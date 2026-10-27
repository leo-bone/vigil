import type { ActionSpec, AuthorityLevel } from '../types.ts';
import { AUTHORITY_LABELS } from '../types.ts';

/**
 * 从动作形状推导它需要几级授权。
 *
 * 这是整个系统里唯一允许"自动判定权限"的地方，而且它是纯函数 ——
 * 同样的动作永远得到同样的等级，没有概率，没有模型。
 */
export function requiredAuthority(action: ActionSpec): AuthorityLevel {
  const money = action.moneyUsd ?? 0;
  if (money > 0) return 4;
  if (action.external || !action.reversible) return 3;
  if (action.kind === 'read' || action.kind === 'inspect' || action.kind === 'query') return 0;
  if (action.kind === 'draft' || action.kind === 'propose') return 1;
  return 2;
}

export function describeAuthority(level: AuthorityLevel): string {
  return `L${level} ${AUTHORITY_LABELS[level]}`;
}

export const MAX_AUTHORITY: AuthorityLevel = 4;
