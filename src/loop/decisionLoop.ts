import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ActionSpec } from '../types.ts';
import type { Kernel } from '../kernel.ts';
import { arbitrate, type Position } from '../pipeline/arbiter.ts';
import { LoopEventBus, type LoopEvent } from './events.ts';
import { checkCompleteness, type ChannelEvidence, type EvidenceSpec } from './evidence.ts';
import type { Notifier } from './notifier.ts';
import type { ActionExecutor } from './executor.ts';
import { DryRunExecutor } from './executor.ts';
import { buildBrief, type DecisionBrief } from './reasoning.ts';

/**
 * 决策循环状态机。
 *
 * 这是 Vigil 从"带账本的聊天机器人"走向"决策系统"的核心：
 *   1. 实时事件 —— 每一步都发射可见事件（goal_received → evidence → decision → gate → execute）
 *   2. 证据完整性闸门 —— 渠道没跑全，禁止裁决（修首轮漏国补翻车）
 *   3. 确认闸门 —— 对外/不可逆（花钱）动作，必须人确认才执行（HITL）
 *   4. 可暂停 —— 等确认 / 等降价时挂起，恢复后续跑，状态落盘
 */
export type LoopStatus = 'running' | 'awaiting_confirmation' | 'completed' | 'blocked';

export interface LoopGoal {
  sessionId: string;
  question: string;
  action: ActionSpec;
  positions: Position[];
  evidence: ChannelEvidence[];
  evidenceSpec: EvidenceSpec;
  /** 决策领域 key（invest / financing / purchase …），供证据驱动裁决选择分配逻辑 */
  domain?: string;
  costUsd?: number;
  /** 闭环执行清单（dry-run 输出）；缺省时打印通用三步 */
  plan?: string[];
  /** 演示用：预先授权金钱动作；真实场景应为 false，由闸门拦截 */
  autoConfirm?: boolean;
}

export interface DecisionLoopState {
  loopId: string;
  sessionId: string;
  goal: LoopGoal;
  status: LoopStatus;
  outcome?: string;
  decisionDetail?: string;
  /** 证据驱动裁决得出的配置简报（invest/financing 含具体仓位） */
  brief?: DecisionBrief;
  createdAt: string;
  updatedAt: string;
}

function makeLoopId(): string {
  return `lp_${Math.random().toString(36).slice(2, 10)}`;
}

/** 对外且不可逆（如花钱购买）= 需要人确认的高风险动作 */
function isGatedAction(action: ActionSpec): boolean {
  return action.external === true && action.reversible === false;
}

export class DecisionLoop {
  readonly loopId: string;
  #kernel: Kernel;
  #goal: LoopGoal;
  #bus: LoopEventBus;
  #statePath: string;
  #status: LoopStatus = 'running';
  #createdAt: string;
  #lastOutcome: string | undefined;
  #decisionDetail: string | undefined;
  #brief: DecisionBrief | undefined;
  #executor: ActionExecutor;

  constructor(
    kernel: Kernel,
    goal: LoopGoal,
    vigilDir: string,
    loopId?: string,
    notifier?: Notifier,
    executor?: ActionExecutor,
  ) {
    this.#kernel = kernel;
    this.#goal = goal;
    this.loopId = loopId ?? makeLoopId();
    this.#createdAt = new Date().toISOString();
    this.#bus = new LoopEventBus(this.loopId, {
      logPath: join(vigilDir, `events-${this.loopId}.jsonl`),
      notifier,
    });
    this.#executor = executor ?? new DryRunExecutor();
    this.#statePath = join(vigilDir, `loop-${this.loopId}.json`);
    // 若以已有 loopId 构造（--resume 路径），恢复先前状态，使 resume 能正确判门
    if (loopId) {
      const prev = loadLoopState(vigilDir, loopId);
      if (prev) {
        this.#status = prev.status;
        this.#lastOutcome = prev.outcome;
        this.#decisionDetail = prev.decisionDetail;
        this.#brief = prev.brief;
        this.#createdAt = prev.createdAt;
      }
    }
  }

  on(sink: (event: LoopEvent) => void): void {
    this.#bus.on(sink);
  }

  get status(): LoopStatus {
    return this.#status;
  }

  #buildState(): DecisionLoopState {
    const state: DecisionLoopState = {
      loopId: this.loopId,
      sessionId: this.#goal.sessionId,
      goal: this.#goal,
      status: this.#status,
      createdAt: this.#createdAt,
      updatedAt: new Date().toISOString(),
    };
    if (this.#lastOutcome !== undefined) state.outcome = this.#lastOutcome;
    if (this.#decisionDetail !== undefined) state.decisionDetail = this.#decisionDetail;
    if (this.#brief !== undefined) state.brief = this.#brief;
    return state;
  }

  #saveState(): void {
    writeFileSync(this.#statePath, `${JSON.stringify(this.#buildState(), null, 2)}\n`);
  }

  /** 跑完整循环，直到裁决后遇到闸门挂起、或执行完成 */
  async run(): Promise<DecisionLoopState> {
    this.#bus.emit('goal_received', 'info', `目标接收：${this.#goal.question}`);
    this.#bus.emit(
      'plan',
      'info',
      '计划：收集全渠道证据 → 完整性校验 → 仲裁 → 高风险动作确认闸门 → 执行闭环',
    );

    for (const evidence of this.#goal.evidence) {
      const price = evidence.priceRMB !== undefined ? ` ¥${evidence.priceRMB}` : '';
      const mark = evidence.verified ? '✓已核验' : '·未核验';
      const dim = evidence.dimension ?? evidence.channel;
      const detail = evidence.note ? ` — ${evidence.note}` : '';
      this.#bus.emit('evidence_gathered', 'info', `[${dim}/${evidence.channel}] ${evidence.source}${price} ${mark}${detail}`);
    }

    const completeness = checkCompleteness(this.#goal.evidence, this.#goal.evidenceSpec, {
      requireVerified: true,
    });
    if (!completeness.complete) {
      this.#bus.emit(
        'evidence_gap',
        'alert',
        `🔔 证据不完整：缺少证据维度 ${completeness.missing.join('、')}，或必备维度未核验，禁止裁决（这正是上一轮翻车的原因）`,
        { missing: completeness.missing },
      );
      this.#status = 'blocked';
      this.#saveState();
      return this.#buildState();
    }
    this.#bus.emit('evidence_complete', 'info', '✓ 全渠道证据已覆盖，放行裁决');

    // 证据驱动裁决：把实时证据转成有数据支撑的方案（invest/financing 即具体仓位）
    this.#brief = buildBrief(this.#goal.domain ?? 'custom', this.#goal.question, this.#goal.evidence);
    this.#bus.emit('reasoning', 'info', `证据驱动分析：${this.#brief.signalSummary}`);
    if (this.#brief.kind === 'allocation') {
      this.#bus.emit(
        'reasoning',
        'info',
        `建议配置（合计 ${this.#brief.totalWeightPct}%）：` +
          this.#brief.allocation.map((a) => `${a.asset} ${a.weightPct}%`).join(' / '),
      );
      this.#bus.emit('reasoning', 'info', `置信度：${this.#brief.confidence}`);
    }
    for (const cav of this.#brief.caveats) {
      this.#bus.emit('reasoning', 'info', `⚠ 提示：${cav}`);
    }

    this.#bus.emit('arbitrating', 'info', '进入仲裁：综合各立场与已核验证据定夺');
    const result = await arbitrate(this.#kernel, {
      sessionId: this.#goal.sessionId,
      question: this.#goal.question,
      action: this.#goal.action,
      positions: this.#goal.positions,
      brief: this.#brief,
    });
    this.#lastOutcome = result.decision;
    const allocText =
      this.#brief.kind === 'allocation'
        ? `；建议配置：${this.#brief.allocation.map((a) => `${a.asset} ${a.weightPct}%`).join('/')}`
        : '';
    this.#decisionDetail = `${result.resolution}：${result.reason}${allocText}`;
    this.#bus.emit(
      'decision',
      result.decision === 'deny' ? 'alert' : 'info',
      `裁决：${result.decision}（阶梯 ${result.resolution}）`,
      { decision: result.decision, resolution: result.resolution, reason: result.reason },
    );

    if (result.decision === 'deny') {
      this.#status = 'completed';
      this.#saveState();
      return this.#buildState();
    }

    if (isGatedAction(this.#goal.action)) {
      this.#bus.emit(
        'gate',
        'gate',
        `确认闸门：系统裁决=${result.decision}，但检测到对外/不可逆动作（${this.#goal.action.kind}），需你授权后才执行闭环`,
        { action: this.#goal.action.kind, costUsd: this.#goal.costUsd },
      );
      if (!this.#goal.autoConfirm) {
        this.#status = 'awaiting_confirmation';
        this.#saveState();
        return this.#buildState();
      }
      this.#bus.emit('gate', 'gate', '（演示）已按 --auto-confirm 预授权，继续闭环执行');
    }

    await this.#execute();
    return this.#buildState();
  }

  /** 从挂起恢复：confirmed=true 才解除闸门并闭环执行 */
  async resume(confirmed: boolean): Promise<DecisionLoopState> {
    this.#bus.emit('resumed', 'info', `恢复循环（确认=${confirmed}）`);
    // 已否决的循环不可能被"确认执行"——这是硬约束，防止 deny 被误放行成真实动作
    if (this.#lastOutcome === 'deny') {
      this.#bus.emit(
        'paused',
        'alert',
        '该循环仲裁结论为 deny（已否决），无法确认执行；如需重新评估请新建循环',
      );
      this.#status = 'completed';
      this.#saveState();
      return this.#buildState();
    }
    // 只有挂在确认闸门上的循环才允许恢复执行，其余状态（completed / blocked）一律拒绝
    if (this.#status !== 'awaiting_confirmation') {
      this.#bus.emit('paused', 'alert', `循环当前状态为 ${this.#status}，无需/无法恢复执行`);
      this.#saveState();
      return this.#buildState();
    }
    if (!confirmed) {
      this.#bus.emit('paused', 'alert', '未获授权，循环保持挂起，不执行任何真实动作');
      this.#status = 'awaiting_confirmation';
      this.#saveState();
      return this.#buildState();
    }
    if (isGatedAction(this.#goal.action)) {
      this.#bus.emit('gate', 'gate', '✓ 已获授权，解除闸门，继续闭环执行');
    }
    await this.#execute();
    return this.#buildState();
  }

  async #execute(): Promise<void> {
    const isGated = isGatedAction(this.#goal.action);
    this.#bus.emit(
      'executing',
      'info',
      `执行闭环（执行器=${this.#executor.id}${isGated ? '，已通过确认闸门' : ''}）：`,
    );
    const steps =
      this.#goal.plan && this.#goal.plan.length > 0
        ? this.#goal.plan
        : [
            '比对已核验证据中的最优选项',
            '锁定满足约束的选项',
            '生成执行清单与凭据',
          ];
    for (const step of steps) {
      this.#bus.emit('executing', 'info', `  → ${step}`);
    }

    // 真正落地：只有走到这里（裁决通过 + 已确认）才会调用执行器。
    // deny 永远到不了这里；未确认时循环停在 awaiting_confirmation。
    const result = await this.#executor.execute({
      sessionId: this.#goal.sessionId,
      question: this.#goal.question,
      action: this.#goal.action,
      costUsd: this.#goal.costUsd,
      brief: this.#brief,
    });
    this.#bus.emit(
      'executing',
      result.ok ? 'info' : 'alert',
      `执行结果：${result.detail}${result.externalRef ? `（外部引用 ${result.externalRef}）` : ''}`,
    );
    this.#bus.emit(
      'completed',
      'info',
      this.#executor.id === 'dry-run'
        ? '✓ 闭环执行完成（dry-run，未发生真实交易）。接真实执行适配器并确认后才会真实下单/划转。'
        : '✓ 闭环执行完成（已真实触发执行适配器）。',
    );
    this.#status = 'completed';
    this.#saveState();
  }
}

export function loadLoopState(vigilDir: string, loopId: string): DecisionLoopState | null {
  const path = join(vigilDir, `loop-${loopId}.json`);
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf8')) as DecisionLoopState;
}
