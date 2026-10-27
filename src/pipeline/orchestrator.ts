import type { Kernel, KernelOptions } from '../kernel.ts';
import { Kernel as KernelClass } from '../kernel.ts';
import { Ledger } from '../ledger/store.ts';
import { defaultPolicy, defaultRules } from '../policy/rules.ts';
import type { PolicyContext } from '../policy/rules.ts';
import type { Judge } from '../judge/index.ts';
import type { Evidence, Verdict } from '../types.ts';
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
 *
 * 实现上是一个**可跨调用续跑的状态机**：
 * begin() 决定下一个该谁干，submit() 接收干完的结果并给出下一步。
 * 进程内可以直接 runTask() 跑完整循环；跨进程（MCP 场景）则由宿主
 * 分别调用这两个接口 —— 干活的可以是另一个 agent，不一定是本进程。
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

export interface EscalationInfo {
  sessionId: string;
  taskId: string;
  reason: string;
  tier: RiskTier;
  /** 升级记录的裁决，审批事件将绑定到这条记录 */
  verdict: Verdict;
}

export interface OrchestratorOptions {
  /** 单个任务最多尝试次数，默认 3 */
  maxAttempts?: number;
  /** 连续失败多少次直接止损，默认 2 */
  failureThreshold?: number;
  /** 防御性步数上限，防止编排逻辑自身死循环，默认 24 */
  maxSteps?: number;
  /**
   * 升级回调（吸收 OMA 的"可恢复审批"）。
   *
   * 不提供：升级即终止任务（原行为）。
   * 提供：宿主决定 'retry'（人工批准继续，审批落账并绑定升级记录的哈希）
   * 或 'abort'（照旧终止）。同一任务最多接受 2 次人工续命，防止无限人肉循环。
   */
  onEscalation?: (info: EscalationInfo) => Promise<'retry' | 'abort'> | 'retry' | 'abort';
  /** 人工续命次数上限，默认 2 */
  maxEscalations?: number;
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

/** 名册里的一项：一个可以被路由到的执行者 */
export interface RosterEntry {
  id: string;
  role: string;
}

/** 任务在任意时刻的状态。跨调用续跑靠的就是它。 */
export interface PipelineState {
  sessionId: string;
  taskId: string;
  task: string;
  roster: RosterEntry[];
  attempts: number;
  consecutiveFailures: number;
  /** 上一轮退回的具体原因 */
  feedback?: string;
  /** 每个岔路的走向 */
  steps: string[];
  /** 每个工人实际干了什么 */
  trace: string[];
  /** 已经走过的岔路数，用于防御性上限 */
  turns: number;
  /** 当前在等谁的交付 */
  pending?: { workerId: string; role: string; attempt: number };
  status?: TaskStatus;
  escalatedTo?: RiskTier;
  reason?: string;
}

/**
 * 一次交接。宿主拿到它就知道现在该做什么。
 *
 * work = 轮到你干活了；其余三种是终态。
 */
export type PipelineTurn =
  | {
      kind: 'work';
      workerId: string;
      role: string;
      attempt: number;
      /** 上一轮退回的原因，没有则为空 */
      feedback?: string;
      /** 给执行者的具体指令 */
      instructions: string;
      /** 交回来时必须包含什么，缺一项验收就过不了 */
      requirements: string[];
    }
  | { kind: 'escalated'; tier: RiskTier; reason: string }
  | { kind: 'stopped'; reason: string }
  | { kind: 'completed'; claim: string; report: TaskReport };

/** 验收的四项硬清单，缺一项都不算完成 */
export const ACCEPTANCE_REQUIREMENTS = [
  '交付物及位置：deliverableUri 必须给出真实位置',
  '独立核验记录：evidence 里至少一份 verified=true，且 producedBy 不等于执行者本人',
  '遗留问题声明：leftoverIssues 必须显式给出（没有遗留问题就写空字符串）',
];

export class Orchestrator {
  #kernel: Kernel;
  #maxAttempts: number;
  #failureThreshold: number;
  #maxSteps: number;
  #onEscalation?: NonNullable<OrchestratorOptions['onEscalation']>;
  #maxEscalations: number;
  #states = new Map<string, PipelineState>();

  constructor(kernel: Kernel, options: OrchestratorOptions = {}) {
    this.#kernel = kernel;
    this.#maxAttempts = options.maxAttempts ?? 3;
    this.#failureThreshold = options.failureThreshold ?? 2;
    this.#maxSteps = options.maxSteps ?? 24;
    this.#onEscalation = options.onEscalation;
    this.#maxEscalations = options.maxEscalations ?? 2;
  }

  get kernel(): Kernel {
    return this.#kernel;
  }

  /** 任务当前状态，用于断线后恢复 */
  state(taskId: string): PipelineState | undefined {
    return this.#states.get(taskId);
  }

  /**
   * 开一个新任务：走止损（首轮跳过）→ 路由，交给宿主去派工。
   *
   * 返回 work 回合表示"该 workerId 干活了"；
   * 返回 escalated / stopped 就是终态。
   */
  async begin(input: { sessionId: string; taskId: string; task: string; roster: RosterEntry[] }): Promise<PipelineTurn> {
    const state: PipelineState = {
      sessionId: input.sessionId,
      taskId: input.taskId,
      task: input.task,
      roster: input.roster,
      attempts: 0,
      consecutiveFailures: 0,
      steps: [],
      trace: [],
      turns: 0,
    };
    this.#states.set(input.taskId, state);
    return this.#route(state);
  }

  /**
   * 交回一轮干活的成果：落账 → 质量门 → 验收。
   *
   * 过不了就带着具体原因重新路由；过了就是终态。
   */
  async submit(taskId: string, output: WorkerOutput): Promise<PipelineTurn> {
    const state = this.#states.get(taskId);
    if (!state) throw new Error(`未知任务 ${taskId}：先调用 vigil_task_start`);
    if (!state.pending) throw new Error(`任务 ${taskId} 当前没有等待交付，可能已经结束`);

    const { workerId, attempt } = state.pending;
    state.pending = undefined;

    // 干活本身也要过一遍内核落账 —— 监督覆盖每一轮，不只覆盖岔路
    const workVerdict = await this.#kernel.decide({
      sessionId: state.sessionId,
      actor: workerId,
      intent: `执行任务 ${taskId}（第 ${attempt} 次）：${output.summary}`,
      action: { kind: 'work', target: taskId, reversible: true, external: false },
      costUsd: output.costUsd,
    });
    state.trace.push(`${workerId}（第 ${attempt} 次）：${output.summary}`);
    state.steps.push(`执行：${workerId} → ${workVerdict.outcome}`);

    // 质量门：独立检查者复核，结构上批不了自己的卷子
    const quality = await forkQualityGate(this.#kernel, {
      sessionId: state.sessionId,
      taskId,
      producer: workerId,
      claim: output.claim,
      material: [output.summary, ...output.evidence.map((e) => `${e.id}:${e.claim ?? ''}`)].join('\n'),
    });
    state.steps.push(`质量门：${quality.passed ? '通过' : '退回'}（${quality.reason}）`);
    if (!quality.passed) {
      state.consecutiveFailures += 1;
      state.feedback = `质量门退回：${quality.reason}`;
      return this.#route(state);
    }

    // 验收：四项清单缺一不可，模型说了不算
    const acceptance = await forkAcceptance(this.#kernel, {
      sessionId: state.sessionId,
      taskId,
      claimant: workerId,
      claim: output.claim,
      deliverableUri: output.deliverableUri,
      evidence: output.evidence,
      leftoverIssues: output.leftoverIssues,
      stateSummary: output.summary,
    });
    state.steps.push(`验收：${acceptance.accepted ? '通过' : `未过（缺 ${acceptance.missing.join('、')}）`}`);
    if (acceptance.accepted) {
      state.status = 'completed';
      state.reason = `任务完成：${output.claim}`;
      return { kind: 'completed', claim: output.claim, report: this.#report(state) };
    }
    state.consecutiveFailures += 1;
    state.feedback = `验收未过，缺：${acceptance.missing.join('、')}。${acceptance.reason}`;
    return this.#route(state);
  }

  /**
   * 进程内跑完整循环。跨进程场景用 begin() / submit() 两次调用。
   */
  async runTask(sessionId: string, taskId: string, task: string, workers: VigilWorker[]): Promise<TaskReport> {
    const roster = workers.map((worker) => ({ id: worker.id, role: worker.role }));
    let turn = await this.begin({ sessionId, taskId, task, roster });

    // 用 for + 显式 break 而不是 while (turn.kind === 'work')：
    // 循环体内给 turn 重新赋值后，TypeScript 的控制流分析会把
    // 条件里的窄化结果作废（回边汇合处类型退化成整个联合类型）。
    for (;;) {
      if (turn.kind !== 'work') break;
      // 先取成 const：turn 是 let，类型窄化不会传进闭包，
      // 在 find 的回调里直接读 turn.workerId 编译不过。
      const { workerId, attempt, feedback } = turn;
      const worker = workers.find((candidate) => candidate.id === workerId);
      if (!worker) throw new Error(`名册里没有 ${workerId}`);
      const output = await worker.run({
        task,
        taskId,
        attempt,
        feedback,
      });
      turn = await this.submit(taskId, output);
    }

    const state = this.#states.get(taskId)!;
    return this.#report(state);
  }

  /** 止损 + 路由。返回 work 回合表示派工成功。 */
  async #route(state: PipelineState): Promise<PipelineTurn> {
    state.turns += 1;
    if (state.turns > this.#maxSteps) {
      state.status = 'stopped';
      state.reason = `编排步数超过防御上限 ${this.#maxSteps}，强制止损`;
      return { kind: 'stopped', reason: state.reason };
    }

    // 止损：先看历史，够差就别再路由了
    if (state.attempts > 0) {
      const stop = await forkStopLoss(this.#kernel, {
        sessionId: state.sessionId,
        taskId: state.taskId,
        attempts: state.attempts,
        maxAttempts: this.#maxAttempts,
        consecutiveFailures: state.consecutiveFailures,
        failureThreshold: this.#failureThreshold,
        stateSummary: state.feedback ?? '',
      });
      state.steps.push(`止损：${stop.stop ? '触发' : '继续'}（${stop.reason}）`);
      if (stop.stop) {
        state.status = 'stopped';
        state.reason = `止损退出：${stop.reason}`;
        return { kind: 'stopped', reason: state.reason };
      }
    }

    const route = await forkRoute(this.#kernel, {
      sessionId: state.sessionId,
      taskId: state.taskId,
      task: state.task,
      stateSummary: state.feedback ?? '任务刚接手，尚无进展',
      roster: state.roster,
    });
    state.steps.push(`路由：${route.workerId ?? '人工'}（${route.reason}）`);

    if (route.needsHuman) {
      const escalation = await forkEscalate(this.#kernel, {
        sessionId: state.sessionId,
        taskId: state.taskId,
        reason: route.reason,
        stateSummary: state.feedback,
      });
      state.steps.push(`升级：${escalation.tier}`);
      const handled = await this.#handleEscalation(state, route.reason, escalation.tier, escalation.verdict);
      if (!handled) {
        state.status = 'escalated';
        state.escalatedTo = escalation.tier;
        state.reason = route.reason;
        return { kind: 'escalated', tier: escalation.tier, reason: route.reason };
      }
      state.feedback = `人工批准继续（${route.reason}），已重新路由`;
      return this.#route(state);
    }

    const entry = state.roster.find((candidate) => candidate.id === route.workerId)!;
    state.attempts += 1;
    state.pending = { workerId: entry.id, role: entry.role, attempt: state.attempts };

    const instructions = [
      `以「${entry.role}」的身份完成任务：${state.task}`,
      state.feedback ? `上一轮被退回，请针对性修正：${state.feedback}` : '',
      `完成后用 vigil_task_submit 交回结果（第 ${state.attempts} 次尝试）。`,
    ]
      .filter(Boolean)
      .join('\n');

    return {
      kind: 'work',
      workerId: entry.id,
      role: entry.role,
      attempt: state.attempts,
      feedback: state.feedback,
      instructions,
      requirements: [...ACCEPTANCE_REQUIREMENTS],
    };
  }

  /** 升级处理：无回调或回调说 abort → false（终止）；批准 → true（续命次数 +1，超限终止） */
  async #handleEscalation(
    state: PipelineState,
    reason: string,
    tier: RiskTier,
    verdict: Verdict,
  ): Promise<boolean> {
    if (!this.#onEscalation) return false;
    const used = this.#kernel.ledger
      .bySession(state.sessionId)
      .filter((record) => record.approval?.decision === 'approved').length;
    if (used >= this.#maxEscalations) {
      state.steps.push(`人工续命已达上限 ${this.#maxEscalations} 次，终止`);
      return false;
    }
    const answer = await this.#onEscalation({
      sessionId: state.sessionId,
      taskId: state.taskId,
      reason,
      tier,
      verdict,
    });
    if (answer !== 'retry') return false;
    // 审批落账并绑定升级记录哈希：事后能对上"人到底批的是哪条"
    this.#kernel.ledger.approve({
      decisionId: verdict.decisionId,
      decision: 'approved',
      approver: 'orchestrator/onEscalation',
      note: reason,
    });
    state.steps.push(`人工批准继续（第 ${used + 1} 次续命）`);
    return true;
  }

  #report(state: PipelineState): TaskReport {
    return {
      sessionId: state.sessionId,
      taskId: state.taskId,
      task: state.task,
      status: state.status ?? 'stopped',
      attempts: state.attempts,
      spendUsd: this.#kernel.ledger.sessionSpend(state.sessionId),
      steps: state.steps,
      workerTrace: state.trace,
      escalatedTo: state.escalatedTo,
      reason: state.reason ?? '',
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
