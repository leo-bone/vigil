import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import type { AuthorityLevel } from '../types.ts';
import type { PolicyContext } from './rules.ts';

/**
 * 策略配置文件的读写。
 *
 * 只做一件事：把 `vigil scan --write` 生成的建议变成内核真正读到的策略。
 * 没有这一层，scan 就只是一份好看的报告。
 */
export const CONFIG_BASENAME = 'vigil.config.json';

const AUTHORITY_VALUES = new Set([0, 1, 2, 3, 4]);

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items = value.filter((item): item is string => typeof item === 'string');
  return items.length === value.length ? items : undefined;
}

/**
 * 读配置。任何一项不合法就整项丢弃，用默认值兜底 ——
 * 配置写错时宁可回到保守策略，也不要带着半个策略跑。
 */
export function parsePolicyConfig(raw: unknown): Partial<PolicyContext> | null {
  if (!raw || typeof raw !== 'object') return null;
  const source = raw as Record<string, unknown>;
  const result: Partial<PolicyContext> = {};

  const perAction = asNumber(source.moneyCapPerAction);
  if (perAction !== undefined && perAction >= 0) result.moneyCapPerAction = perAction;

  const perSession = asNumber(source.moneyCapPerSession);
  if (perSession !== undefined && perSession >= 0) result.moneyCapPerSession = perSession;

  if (typeof source.allowAutonomousIrreversible === 'boolean') {
    result.allowAutonomousIrreversible = source.allowAutonomousIrreversible;
  }

  const denylist = asStringArray(source.denylistTargets);
  if (denylist) result.denylistTargets = denylist;

  if (Array.isArray(source.grants)) {
    const grants: PolicyContext['grants'] = [];
    for (const entry of source.grants) {
      if (!entry || typeof entry !== 'object') continue;
      const item = entry as Record<string, unknown>;
      const actor = item.actor;
      const authority = asNumber(item.authority);
      if (typeof actor !== 'string' || authority === undefined) continue;
      if (!AUTHORITY_VALUES.has(authority)) continue;
      grants.push({ actor, authority: authority as AuthorityLevel });
    }
    if (grants.length > 0) result.grants = grants;
  }

  return Object.keys(result).length > 0 ? result : null;
}

export function loadPolicyConfig(path: string): Partial<PolicyContext> | null {
  if (!existsSync(path)) return null;
  try {
    return parsePolicyConfig(JSON.parse(readFileSync(path, 'utf8')));
  } catch {
    return null;
  }
}

export function savePolicyConfig(path: string, policy: PolicyContext, note?: string): void {
  const payload = {
    $comment: note ?? '由 vigil scan 生成。改动会立即影响下次启动的内核；删掉本文件即回到内置默认策略。',
    moneyCapPerAction: policy.moneyCapPerAction,
    moneyCapPerSession: policy.moneyCapPerSession,
    allowAutonomousIrreversible: policy.allowAutonomousIrreversible,
    denylistTargets: policy.denylistTargets,
    grants: policy.grants,
  };
  writeFileSync(path, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}
