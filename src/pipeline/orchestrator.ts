import type { Kernel, KernelOptions } from '../kernel.ts';
import { Kernel as KernelClass } from '../kernel.ts';
import { Ledger } from '../ledger/store.ts';
import { defaultPolicy, defaultRules } from '../policy/rules.ts';
import type { PolicyContext } from '../policy/rules.ts';
import type { Judge } from '../judge/index.ts';
import type { Evidence } from '../types.ts';
import { pipelineRules } from './rules.ts';
import {
  forkAcceptance,
  forkEscalate,
  forkQualityGate,
  forkRoute,
  forkStopLoss,
  GATE_ACTOR,
  ORCHESTRATOR,
} from './forks.ts';
import type { RiskTier } from './forks.ts';

export { ORCHESTRATOR, GATE_ACTOR };
export type { RiskTier };

/**
 * 统筹助理（Orchestrator）。
 *
 * 一比一复刻 Jev 的主循环，每一步都过内核、落账本：
 *
 *   ┌→ 止损（历史够差就停）──→ stopped
 *   │   路由 ──选不出人──→ 升级 ──→ escalated
 *   │   干活（执行本身也落账）
 *   │   质量门 ──不过──→ 带反馈回路由（算一次失败）
 *   │   验收（四项清单）──缺项──→ 带缺项回路由（算一次失败）
 *   └─────── 通过 ──→ completed
 *
 * "监督过程"不是独立模块：循环里的每个判断都是一次被记录的裁决，
 * 事后 postmortem(sessionId) 能完整回放每一步为什么这么走。
 */

export interface WorkerRunContext {
  task: string;
  taskId: string;
  attempt: number;
  /** 上一轮退回的具体原因，首轮没有 */
  feedback?: string;
}

export interface WorkerOutput {
  /** 这一轮做了什么（一句话） */
  summary: string;
  /** 对完成度的主张 */
  claim: string;
  /** 支撑主张的证据 */
  evidence: Evidence[];
  /** 交付物位置；没有位置等于没有交付物 */
  deliverableUri?: string;
  /** 遗留问题声明，必须显式给出（可以为空串） */
  leftoverIssues?: string;
  /** 本轮成本 */
  costUsd?: number;
}

export interface VigilWorker {
  id: string;
  role: string;
  run(ctx: WorkerRunContext): Promise<WorkerOutput>;
}

export interface OrchestratorOptions {
  /** 单个任务最多尝试次数，默认 3 */
  maxAttempts?: number;
  /** 连续失败多少次直接止损，默认 2 */
  failureThreshold?: number;
  /** 防御性步数上限，防止编排逻辑自身死循环，默认 24 */
  maxSteps?: number;
}

export type TaskStatus = 'completed' | 'stopped' | 'escalated';

export interface TaskReport {
  sessionId: string;
  taskId: string;
  task: string;
  status: TaskStatus;
  attempts: number;
  spendUsd: number;
  /** 每个岔路的走向，人能直接读懂 */
  steps: string[];
  /** 每个工人实际干了什么 */
  workerTrace: string[];
  escalatedTo?: RiskTier;
  reason: string;
}

export class Orchestrator {
  #kernel: Kernel;
  #maxAttempts: number;
  #failureThreshold: number;
  #maxSteps: number;

  constructor(kernel: Kernel, options: OrchestratorOptions = {}) {
    this.#kernel = kernel;
    this.#maxAttempts = options.maxAttempts ?? 3;
    this.#failureThreshold = options.failureThreshold ?? 2;
    this.#maxSteps = options.maxSteps ?? 24;
  }

  get kernel(): Kernel {
    return this.#kernel;
  }

  async runTask(sessionId: string, taskId: string, task: string, workers: VigilWorker[]): Promise<TaskReport> {
    const steps: string[] = [];
    const trace: string[] = [];
    let attempts = 0;
    let consecutiveFailures = 0;
    let feedback: string | undefined;
    let reason = '';

    for (let step = 0; step < this.#maxSteps; step += 1) {
      // 1. 止损：先看历史，够差就别再路由了（首轮没有历史，跳过）
      if (attempts > 0) {
        const stop = await forkStopLoss(this.#kernel, {
          sessionId,
          taskId,
          attempts,
          maxAttempts: this.#maxAttempts,
          consecutiveFailures,
          failureThreshold: this.#failureThreshold,
          stateSummary: feedback ?? '',
        });
        steps.push(`止损：${stop.stop ? '触发' : '继续'}（${stop.reason}）`);
        if (stop.stop) {
          reason = `止损退出：${stop.reason}`;
          return this.#report(sessionId, taskId, task, 'stopped', attempts, steps, trace, reason);
        }
      }

      // 2. 路由
      const route = await forkRoute(this.#kernel, {
        sessionId,
        taskId,
        task,
        stateSummary: feedback ?? '任务刚接手，尚无进展',
        roster: workers.map((w) => ({ id: w.id, role: w.role })),
      });
      steps.push(`路由：${route.workerId ?? '人工'}（${route.reason}）`);
      if (route.needsHuman) {
        const escalation = await forkEscalate(this.#kernel, {
          sessionId,
          taskId,
          reason: route.reason,
          stateSummary: feedback,
        });
        steps.push(`升级：${escalation.tier}`);
        return this.#report(sessionId, taskId, task, 'escalated', attempts, steps, trace, route.reason, escalation.tier);
      }
      const worker = workers.find((w) => w.id === route.workerId)!;
      attempts += 1;

      // 3. 干活。执行本身也过一遍内核落账 —— 监督过程覆盖每一轮，不只覆盖岔路
      const output = await worker.run({ task, taskId, attempt: attempts, feedback });
      const workVerdict = await this.#kernel.decide({
        sessionId,
        actor: worker.id,
        intent: `执行任务 ${taskId}（第 ${attempts} 次）：${output.summary}`,
        action: { kind: 'work', target: taskId, reversible: true, external: false },
        costUsd: output.costUsd,
      });
      trace.push(`${worker.id}（第 ${attempts} 次）：${output.summary}`);
      steps.push(`执行：${worker.id} → ${workVerdict.outcome}`);

      // 4. 质量门：独立检查者复核，结构上批不了自己的卷子
      const quality = await forkQualityGate(this.#kernel, {
        sessionId,
        taskId,
        producer: worker.id,
        claim: output.claim,
        material: [output.summary, ...output.evidence.map((e) => `${e.id}:${e.claim ?? ''}`)].join('\n'),
      });
      steps.push(`质量门：${quality.passed ? '通过' : '退回'}（${quality.reason}）`);
      if (!quality.passed) {
        consecutiveFailures += 1;
        feedback = `质量门退回：${quality.reason}`;
        continue;
      }

      // 5. 验收：四项清单缺一不可，模型说了不算
      const acceptance = await forkAcceptance(this.#kernel, {
        sessionId,
        taskId,
        claimant: worker.id,
        claim: output.claim,
        deliverableUri: output.deliverableUri,
        evidence: output.evidence,
        leftoverIssues: output.leftoverIssues,
        stateSummary: output.summary,
      });
      steps.push(
        `验收：${acceptance.accepted ? '通过' : `未过（缺 ${acceptance.missing.join('、')}）`}`,
      );
      if (acceptance.accepted) {
        reason = `任务完成：${output.claim}`;
        return this.#report(sessionId, taskId, task, 'completed', attempts, steps, trace, reason);
      }
      consecutiveFailures += 1;
      feedback = `验收未过，缺：${acceptance.missing.join('、')}。${acceptance.reason}`;
    }

    reason = `编排步数超过防御上限 ${this.#maxSteps}，强制止损`;
    return this.#report(sessionId, taskId, task, 'stopped', attempts, steps, trace, reason);
  }

  #report(
    sessionId: string,
    taskId: string,
    task: string,
    status: TaskStatus,
    attempts: number,
    steps: string[],
    trace: string[],
    reason: string,
    escalatedTo?: RiskTier,
  ): TaskReport {
    return {
      sessionId,
      taskId,
      task,
      status,
      attempts,
      spendUsd: this.#kernel.ledger.sessionSpend(sessionId),
      steps,
      workerTrace: trace,
      escalatedTo,
      reason,
    };
  }
}

/**
 * 组装一条带流水线规则的内核。
 *
 * 在默认规则之外加上岔路的确定性规则（重试上限、验收清单、自产自验），
 * 并给 vigil/orchestrator、vigil/quality-gate 和工人授予 L2 ——
 * 岔路动作本身都是可逆的内部判断，真正危险的对外动作仍由 hook 层把守。
 */
export function createPipelineKernel(
  ledger: Ledger,
  judge: Judge,
  policyOverrides: Partial<PolicyContext> = {},
  options: Partial<KernelOptions> = {},
): Kernel {
  const base = defaultPolicy();
  const policy: PolicyContext = {
    ...base,
    ...policyOverrides,
    grants: [
      ...base.grants.filter((g) => !['bot/researcher', 'bot/writer', 'bot/engineer'].includes(g.actor)),
      { actor: 'bot/*', authority: 2 },
      { actor: 'vigil/orchestrator', authority: 2 },
      { actor: 'vigil/quality-gate', authority: 2 },
      ...(policyOverrides.grants ?? []),
    ],
  };
  return new KernelClass({
    ledger,
    judge,
    policy,
    rules: [...defaultRules, ...pipelineRules],
    ...options,
  });
}
