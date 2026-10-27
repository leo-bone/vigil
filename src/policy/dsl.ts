import type { DecisionRequest } from '../types.ts';

/**
 * 声明式规则条件。
 *
 * 刻意不用正则表达式：规则包是可以从外部下载的，而正则有 ReDoS 风险 ——
 * 一个精心构造的模式就能让你的进程卡死。这里用子串和通配符，
 * 表达力弱一点，但装进来的东西不会伤到你。
 */

/** 形如 `*.pem`、`report-*.md` 的通配符。`*` 匹配任意长度。 */
export function globMatch(pattern: string, text: string): boolean {
  const p = pattern.toLowerCase();
  const t = text.toLowerCase();
  const parts = p.split('*');
  if (parts.length === 1) return t.includes(p);

  let cursor = 0;
  for (let i = 0; i < parts.length; i += 1) {
    const part = parts[i]!;
    if (part === '') continue;
    const index = t.indexOf(part, cursor);
    if (index === -1) return false;
    if (i === 0 && index !== 0) return false;
    cursor = index + part.length;
    if (i === parts.length - 1 && cursor !== t.length) return false;
  }
  return true;
}

export interface Condition {
  /** 动作类型在列表里 */
  kindIn?: string[];
  /** 目标匹配任一模式（支持 `*`） */
  targetMatches?: string[];
  /** 载荷匹配任一模式（支持 `*`） */
  payloadMatches?: string[];
  /** actor 匹配任一模式 */
  actorMatches?: string[];
  /** 状态材料匹配任一模式 */
  stateMatches?: string[];
  /** 动作是否对外 */
  external?: boolean;
  /** 动作是否可逆 */
  reversible?: boolean;
  /** 金额不低于该值 */
  moneyUsdAtLeast?: number;
  /** 证据条数不少于该值 */
  evidenceCountAtLeast?: number;
  /** 子条件全部满足 */
  all?: Condition[];
  /** 子条件至少满足一个 */
  any?: Condition[];
  /** 子条件不满足 */
  not?: Condition;
}

const CONDITION_KEYS: Array<keyof Condition> = [
  'kindIn',
  'targetMatches',
  'payloadMatches',
  'actorMatches',
  'stateMatches',
  'external',
  'reversible',
  'moneyUsdAtLeast',
  'evidenceCountAtLeast',
  'all',
  'any',
  'not',
];

function anyMatch(patterns: string[] | undefined, text: string): boolean {
  if (!patterns || patterns.length === 0) return false;
  return patterns.some((pattern) => globMatch(pattern, text));
}

function haystack(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === undefined || value === null) return '';
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/**
 * 判断一个动作是否满足条件。
 *
 * 顶层各字段之间是"与"关系；`all` / `any` / `not` 用来组合。
 */
export function matchesCondition(condition: Condition, req: DecisionRequest): boolean {
  const action = req.action;

  if (condition.kindIn && !condition.kindIn.includes(action.kind)) return false;
  if (condition.targetMatches && !anyMatch(condition.targetMatches, haystack(action.target))) return false;
  if (condition.payloadMatches && !anyMatch(condition.payloadMatches, haystack(action.payload))) return false;
  if (condition.actorMatches && !anyMatch(condition.actorMatches, req.actor)) return false;
  if (condition.stateMatches && !anyMatch(condition.stateMatches, haystack(req.state))) return false;
  if (condition.external !== undefined && action.external !== condition.external) return false;
  if (condition.reversible !== undefined && action.reversible !== condition.reversible) return false;
  if (condition.moneyUsdAtLeast !== undefined && (action.moneyUsd ?? 0) < condition.moneyUsdAtLeast) {
    return false;
  }
  if (
    condition.evidenceCountAtLeast !== undefined &&
    (req.evidence ?? []).length < condition.evidenceCountAtLeast
  ) {
    return false;
  }
  if (condition.all && !condition.all.every((sub) => matchesCondition(sub, req))) return false;
  if (condition.any && !condition.any.some((sub) => matchesCondition(sub, req))) return false;
  if (condition.not && matchesCondition(condition.not, req)) return false;

  return true;
}

/** 条件里是否至少有一个可判定的字段 —— 空条件永远匹配不上 */
export function hasAnyField(condition: Condition): boolean {
  return CONDITION_KEYS.some((key) => {
    const value = condition[key];
    if (value === undefined) return false;
    if (Array.isArray(value)) return value.length > 0;
    return true;
  });
}
