import type { Kernel } from '../kernel.ts';
import type { Evidence, Verdict } from '../types.ts';

/**
 * 五个决策岔路 —— 一比一对应 Jev 的判断点：
 *
 *   路由   "下一个该谁干"     → 分类问题，在名册里选
 *   质量门 "这份研究够不够"   → 独立检查者，结构上就批不了自己的卷子
 *   止损   "继续还是停"       → 数数是确定性的，进展评分交给模型
 *   验收   "算不算完成"       → 四项清单缺一不可，模型说了不算
 *   升级   "要不要人接手"     → 落账记录，风险分级决定找哪一级的人
 *
 * 每个岔路都是一次完整的内核裁决：确定性规则先拦，
 * 概率模型只回答类型化问题，结论全部写入哈希链账本。
 * "监督过程"不是额外模块 —— 每一步都留痕，就是监督本身。
 */

export const ORCHESTRATOR = 'vigil/orchestrator';
export const GATE_ACTOR = 'vigil/quality-gate';

/** 路由岔路：决定下一个执行者 */
export interface RouteInput {
  sessionId: string;
  taskId: string;
  task: string;
  /** 当前进度摘要，包含上一轮的退回原因 */
  stateSummary: string;
  roster: Array<{ id: string; role: string }>;
}

export interface RouteResult {
  verdict: Verdict;
  /** 名册内合法的执行者；null 表示需要人工 */
  workerId: string | null;
  needsHuman: boolean;
  reason: string;
}

export async function forkRoute(kernel: Kernel, input: RouteInput): Promise<RouteResult> {
  const criteria = Object.fromEntries(input.roster.map((w) => [w.id, w.role]));
  const verdict = await kernel.decide({
    sessionId: input.sessionId,
    actor: ORCHESTRATOR,
    intent: `路由：为任务 ${input.taskId} 选择下一个执行者`,
    state: `任务 ${input.taskId}：${input.task}\n当前状态：${input.stateSummary}`,
    action: { kind: 'route', target: input.taskId, reversible: true, external: false },
    questions: [
      {
        name: 'next_worker',
        type: 'choice',
        instructions: '根据任务当前状态，选择最合适的下一个执行者',
        criteria,
        floor: 0.7,
      },
    ],
  });

  if (verdict.outcome !== 'allow') {
    return { verdict, workerId: null, needsHuman: true, reason: verdict.reason };
  }
  const choice = verdict.judgments.find((j) => j.name === 'next_worker')?.choice ?? null;
  const known = choice !== null && input.roster.some((w) => w.id === choice);
  if (!known) {
    // 模型选了名册外的人：不能将错就错，升级落账
    const escalation = await forkEscalate(kernel, {
      sessionId: input.sessionId,
      taskId: input.taskId,
      reason: `路由返回了名册外的执行者「${choice}」，无法派工`,
      stateSummary: input.stateSummary,
    });
    return {
      verdict: escalation.verdict,
      workerId: null,
      needsHuman: true,
      reason: `路由结果不合法（${choice}），已升级人工（${escalation.tier}）`,
    };
  }
  return { verdict, workerId: choice, needsHuman: false, reason: verdict.reason };
}

/** 质量门岔路：独立复核产出质量 */
export interface QualityGateInput {
  sessionId: string;
  taskId: string;
  /** 产出人，质量门在结构上永远是别人 */
  producer: string;
  /** 产出人对自己的主张 */
  claim: string;
  /** 产出的原始材料，作为复核对象放进 state，不走证据通道 */
  material: string;
}

export interface QualityGateResult {
  verdict: Verdict;
  passed: boolean;
  reason: string;
}

export async function forkQualityGate(kernel: Kernel, input: QualityGateInput): Promise<QualityGateResult> {
  const verdict = await kernel.decide({
    sessionId: input.sessionId,
    actor: GATE_ACTOR,
    intent: `质量门：复核 ${input.producer} 对任务 ${input.taskId} 的产出`,
    state: `产出人：${input.producer}\n主张：${input.claim}\n材料：${input.material}`,
    action: { kind: 'verify', target: input.taskId, reversible: true, external: false },
    questions: [
      {
        name: 'quality_sufficient',
        type: 'boolean',
        instructions: '该产出是否达到任务要求的质量，可以进入验收环节',
        floor: 0.7,
      },
    ],
  });
  return { verdict, passed: verdict.outcome === 'allow', reason: verdict.reason };
}

/** 止损岔路：继续还是停 */
export interface StopLossInput {
  sessionId: string;
  taskId: string;
  attempts: number;
  maxAttempts: number;
  consecutiveFailures: number;
  failureThreshold?: number;
  stateSummary: string;
}

export interface StopLossResult {
  verdict: Verdict;
  stop: boolean;
  reason: string;
}

export async function forkStopLoss(kernel: Kernel, input: StopLossInput): Promise<StopLossResult> {
  const verdict = await kernel.decide({
    sessionId: input.sessionId,
    actor: ORCHESTRATOR,
    intent: `止损判断：任务 ${input.taskId} 第 ${input.attempts} 次尝试之后`,
    state: `任务进度：${input.stateSummary}\n已尝试 ${input.attempts} 次，连续失败 ${input.consecutiveFailures} 次`,
    action: { kind: 'stoploss', target: input.taskId, reversible: true, external: false },
    extras: {
      stoploss: {
        attempts: input.attempts,
        maxAttempts: input.maxAttempts,
        consecutiveFailures: input.consecutiveFailures,
        failureThreshold: input.failureThreshold,
      },
    },
    questions: [
      {
        name: 'progress',
        type: 'score',
        instructions: '评估任务当前的真实进展（不是意愿，是证据支持的进展）',
        scale: ['1 几乎无进展', '2 略有推进', '3 过半', '4 接近完成', '5 基本完成'],
        escalateIfBelow: 2,
      },
    ],
  });
  // 上限到顶是确定性 deny；评分过低或连续失败是 escalate。
  // 只要不是 allow，就不该再烧一轮钱。
  return { verdict, stop: verdict.outcome !== 'allow', reason: verdict.reason };
}

/** 验收岔路：算不算完成 */
export interface AcceptanceInput {
  sessionId: string;
  taskId: string;
  /** 声称完成的人 */
  claimant: string;
  claim: string;
  /** 交付物位置。没有位置等于没有交付物。 */
  deliverableUri?: string;
  evidence: Evidence[];
  /** 遗留问题声明。没声明 ≠ 没有遗留问题，必须显式声明（可以为空串）。 */
  leftoverIssues?: string;
  stateSummary: string;
}

export interface AcceptanceResult {
  verdict: Verdict;
  accepted: boolean;
  missing: string[];
  reason: string;
}

export async function forkAcceptance(kernel: Kernel, input: AcceptanceInput): Promise<AcceptanceResult> {
  const independent = input.evidence.some((e) => e.verified === true && e.producedBy !== input.claimant);
  const missing: string[] = [];
  if (!input.deliverableUri) missing.push('交付物及位置');
  if (!independent) missing.push('独立核验记录');
  if (input.leftoverIssues === undefined) missing.push('遗留问题声明');

  const verdict = await kernel.decide({
    sessionId: input.sessionId,
    actor: GATE_ACTOR,
    intent: `验收：${input.claimant} 声称完成任务 ${input.taskId}`,
    state: `主张：${input.claim}\n交付物：${input.deliverableUri ?? '（未提供）'}\n遗留问题声明：${
      input.leftoverIssues ?? '（未声明）'
    }`,
    action: { kind: 'accept', target: input.deliverableUri ?? input.taskId, reversible: true, external: false },
    evidence: input.evidence,
    extras: {
      claimant: input.claimant,
      acceptance: {
        deliverableProvided: Boolean(input.deliverableUri),
        independentVerification: independent,
        leftoverDeclared: input.leftoverIssues !== undefined,
      },
    },
    questions: [
      {
        name: 'acceptance_criteria_met',
        type: 'boolean',
        instructions: '交付物是否实质满足任务要求，可以关闭该任务',
        floor: 0.75,
      },
    ],
  });

  // 清单是确定性结论：模型打分再高，缺项就是缺项，一票否决。
  const accepted = missing.length === 0 && verdict.outcome === 'allow';
  const reason = missing.length > 0 ? `验收缺项：${missing.join('、')}；${verdict.reason}` : verdict.reason;
  return { verdict, accepted, missing, reason };
}

/** 升级岔路：要不要人接手，找哪一级的人 */
export interface EscalateInput {
  sessionId: string;
  taskId: string;
  reason: string;
  stateSummary?: string;
  /** 涉及金额则无论模型怎么判，直接 critical */
  moneyUsd?: number;
}

export type RiskTier = 'routine' | 'urgent' | 'critical';

export interface EscalateResult {
  verdict: Verdict;
  tier: RiskTier;
}

export async function forkEscalate(kernel: Kernel, input: EscalateInput): Promise<EscalateResult> {
  const verdict = await kernel.decide({
    sessionId: input.sessionId,
    actor: ORCHESTRATOR,
    intent: `升级人工：${input.reason}`,
    state: `任务 ${input.taskId}。${input.stateSummary ?? ''}`,
    action: { kind: 'escalate', target: input.taskId, reversible: true, external: false },
    questions: [
      {
        name: 'risk_tier',
        type: 'choice',
        instructions: '评估该事项的风险等级，决定通知哪一级的人',
        criteria: {
          routine: '常规，工作时间处理即可',
          urgent: '紧急，需要尽快处理',
          critical: '重大，需要立即中断其他工作处理',
        },
        // 只记录分级，不再自我升级 —— 升级本身就是要落账的动作
        gating: false,
      },
    ],
  });
  const modelTier = verdict.judgments.find((j) => j.name === 'risk_tier')?.choice;
  // 金额是确定性信号，直接压过模型分级
  const tier: RiskTier = input.moneyUsd && input.moneyUsd > 0 ? 'critical' : (modelTier as RiskTier) ?? 'urgent';
  return { verdict, tier };
}
