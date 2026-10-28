import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ActionSpec } from '../types.ts';
import type { Kernel } from '../kernel.ts';
import { arbitrate, type Position } from '../pipeline/arbiter.ts';
import { LoopEventBus, type LoopEvent } from './events.ts';
import { checkCompleteness, type ChannelEvidence, type EvidenceSpec } from './evidence.ts';

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
  costUsd?: number;
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

  constructor(kernel: Kernel, goal: LoopGoal, vigilDir: string, loopId?: string) {
    this.#kernel = kernel;
    this.#goal = goal;
    this.loopId = loopId ?? makeLoopId();
    this.#createdAt = new Date().toISOString();
    this.#bus = new LoopEventBus(this.loopId, {
      logPath: join(vigilDir, `events-${this.loopId}.jsonl`),
    });
    this.#statePath = join(vigilDir, `loop-${this.loopId}.json`);
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
      this.#bus.emit('evidence_gathered', 'info', `[${evidence.channel}] ${evidence.source}${price} ${mark}`);
    }

    const completeness = checkCompleteness(this.#goal.evidence, this.#goal.evidenceSpec);
    if (!completeness.complete) {
      this.#bus.emit(
        'evidence_gap',
        'alert',
        `🔔 证据不完整：缺少渠道 ${completeness.missing.join('、')}，禁止裁决（这正是上一轮翻车的原因）`,
        { missing: completeness.missing },
      );
      this.#status = 'blocked';
      this.#saveState();
      return this.#buildState();
    }
    this.#bus.emit('evidence_complete', 'info', '✓ 全渠道证据已覆盖，放行裁决');

    this.#bus.emit('arbitrating', 'info', '进入仲裁：综合各立场与已核验证据定夺');
    const result = await arbitrate(this.#kernel, {
      sessionId: this.#goal.sessionId,
      question: this.#goal.question,
      action: this.#goal.action,
      positions: this.#goal.positions,
    });
    this.#lastOutcome = result.decision;
    this.#decisionDetail = `${result.resolution}：${result.reason}`;
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
    this.#bus.emit('executing', 'info', '执行闭环（dry-run，不发生真实交易）：');
    const steps = [
      '比对国补 / 教育 / 学生补贴渠道的当前最优价',
      '锁定满足 ≤4000 预算的渠道',
      '生成下单步骤与凭据清单（待你最终点确认后真实提交）',
    ];
    for (const step of steps) {
      this.#bus.emit('executing', 'info', `  → ${step}`);
    }
    this.#bus.emit('completed', 'info', '✓ 闭环执行完成（dry-run）。真实购买需你最终点确认。');
    this.#status = 'completed';
    this.#saveState();
  }
}

export function loadLoopState(vigilDir: string, loopId: string): DecisionLoopState | null {
  const path = join(vigilDir, `loop-${loopId}.json`);
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf8')) as DecisionLoopState;
}
