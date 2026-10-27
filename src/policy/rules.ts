import type { ActionSpec, AuthorityLevel, DecisionRequest, HardBlock } from '../types.ts';
import { matchesActor } from '../util/canonical.ts';

/**
 * 策略上下文。
 *
 * 这里是"硬约束"的唯一来源。凡是写进这里的规则都是确定性的：
 * 满足条件就一定触发，没有"模型觉得"。不可协商的红线放这里，
 * 需要权衡的灰区交给概率判断模型。
 */
export interface PolicyContext {
  /** 单次动作金额上限（美元） */
  moneyCapPerAction: number;
  /** 单会话成本上限（美元） */
  moneyCapPerSession: number;
  /** 是否允许无人值守执行不可逆动作 */
  allowAutonomousIrreversible: boolean;
  /** 禁止触达的目标（域名、路径前缀、账号） */
  denylistTargets: string[];
  /** actor 授权授予表，支持 `bot/*` 通配 */
  grants: Array<{ actor: string; authority: AuthorityLevel }>;
  /** 会话已花费（由内核从账本填充） */
  sessionSpendUsd?: number;
}

export interface Rule {
  id: string;
  description: string;
  severity: 'deny' | 'escalate';
  check: (req: DecisionRequest, ctx: PolicyContext) => HardBlock | null;
}

/** 密钥泄露的特征。正则能 100% 抓到的东西，不该交给模型去猜。 */
const SECRET_PATTERNS = [
  /\bsk-[A-Za-z0-9_-]{16,}/,
  /\btsf_[A-Za-z0-9_-]{16,}/,
  /\bghp_[A-Za-z0-9]{20,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
];

export const defaultRules: Rule[] = [
  {
    id: 'money.per_action_cap',
    description: '单笔金额超过上限',
    severity: 'deny',
    check: (req, ctx) => {
      const money = req.action.moneyUsd ?? 0;
      if (money <= 0 || money <= ctx.moneyCapPerAction) return null;
      return {
        rule: 'money.per_action_cap',
        severity: 'deny',
        detail: `动作金额 ${money} 美元，超过单笔上限 ${ctx.moneyCapPerAction} 美元`,
      };
    },
  },
  {
    id: 'money.session_cap',
    description: '会话预算已耗尽',
    severity: 'deny',
    check: (req, ctx) => {
      const spent = ctx.sessionSpendUsd ?? 0;
      if (spent < ctx.moneyCapPerSession) return null;
      return {
        rule: 'money.session_cap',
        severity: 'deny',
        detail: `会话已花费 ${spent.toFixed(2)} 美元，达到上限 ${ctx.moneyCapPerSession} 美元`,
      };
    },
  },
  {
    id: 'target.denylist',
    description: '目标命中禁止清单',
    severity: 'deny',
    check: (req, ctx) => {
      const target = req.action.target;
      if (!target) return null;
      const hit = ctx.denylistTargets.find((entry) => target === entry || target.startsWith(entry));
      if (!hit) return null;
      return { rule: 'target.denylist', severity: 'deny', detail: `目标 ${target} 命中禁止清单 ${hit}` };
    },
  },
  {
    id: 'payload.secret',
    description: '载荷里出现凭据形态的字符串',
    severity: 'deny',
    check: (req) => {
      const payload = typeof req.action.payload === 'string'
        ? req.action.payload
        : JSON.stringify(req.action.payload ?? '');
      for (const pattern of SECRET_PATTERNS) {
        if (pattern.test(payload)) {
          return { rule: 'payload.secret', severity: 'deny', detail: '载荷中检测到疑似密钥或私钥，已阻止外发' };
        }
      }
      return null;
    },
  },
  {
    id: 'action.irreversible_unattended',
    description: '无人值守执行不可逆动作',
    severity: 'escalate',
    check: (req, ctx) => {
      if (ctx.allowAutonomousIrreversible) return null;
      if (req.action.reversible) return null;
      return {
        rule: 'action.irreversible_unattended',
        severity: 'escalate',
        detail: `动作 ${req.action.kind} 不可逆，当前策略不允许无人值守执行`,
      };
    },
  },
  {
    id: 'evidence.required_for_external',
    description: '对外动作必须带证据',
    severity: 'escalate',
    check: (req) => {
      if (!req.action.external) return null;
      const strong = (req.evidence ?? []).filter((e) => e.id);
      if (strong.length > 0) return null;
      return {
        rule: 'evidence.required_for_external',
        severity: 'escalate',
        detail: '对外动作没有附带任何证据，禁止声明"已完成"',
      };
    },
  },
  {
    id: 'evidence.self_review',
    description: '自己批自己的卷子',
    severity: 'escalate',
    check: (req) => {
      const evidence = req.evidence ?? [];
      if (evidence.length === 0) return null;
      const foreign = evidence.filter((e) => e.producedBy !== req.actor);
      if (foreign.length > 0) return null;
      return {
        rule: 'evidence.self_review',
        severity: 'escalate',
        detail: `全部 ${evidence.length} 份证据都由 ${req.actor} 自己产出，需要独立复核`,
      };
    },
  },
  {
    id: 'evidence.unverified',
    description: '依赖未核验的证据',
    severity: 'escalate',
    check: (req) => {
      const unverified = (req.evidence ?? []).filter((e) => e.verified === false);
      if (unverified.length === 0) return null;
      return {
        rule: 'evidence.unverified',
        severity: 'escalate',
        detail: `${unverified.length} 份证据标记为未核验：${unverified.map((e) => e.id).join(', ')}`,
      };
    },
  },
];

export function runRules(req: DecisionRequest, ctx: PolicyContext, rules: Rule[] = defaultRules): HardBlock[] {
  const blocks: HardBlock[] = [];
  for (const rule of rules) {
    const hit = rule.check(req, ctx);
    if (hit) blocks.push(hit);
  }
  return blocks;
}

const FALLBACK_GRANT: AuthorityLevel = 1;

export function grantedAuthority(actor: string, ctx: PolicyContext): AuthorityLevel {
  let best: AuthorityLevel | null = null;
  for (const grant of ctx.grants) {
    if (!matchesActor(grant.actor, actor)) continue;
    if (best === null || grant.authority > best) best = grant.authority;
  }
  return best ?? FALLBACK_GRANT;
}

/** 默认策略：保守到有点烦人，这是刻意的。放宽比收紧更容易出事。 */
export function defaultPolicy(overrides: Partial<PolicyContext> = {}): PolicyContext {
  return {
    moneyCapPerAction: 50,
    moneyCapPerSession: 200,
    allowAutonomousIrreversible: false,
    denylistTargets: ['.env', '/etc/', 'secrets/', 'production'],
    grants: [
      { actor: 'bot/researcher', authority: 1 },
      { actor: 'bot/engineer', authority: 2 },
      { actor: 'bot/writer', authority: 1 },
      { actor: 'bot/outbound', authority: 3 },
      { actor: 'human/*', authority: 4 },
    ],
    ...overrides,
  };
}

export function actionSummary(action: ActionSpec): string {
  const bits = [action.kind];
  if (action.target) bits.push(`→ ${action.target}`);
  if (action.moneyUsd) bits.push(`${action.moneyUsd} USD`);
  if (!action.reversible) bits.push('不可逆');
  if (action.external) bits.push('对外');
  return bits.join(' ');
}
