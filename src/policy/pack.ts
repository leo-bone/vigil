import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Rule, PolicyContext } from './rules.ts';
import type { Condition } from './dsl.ts';
import { hasAnyField, matchesCondition } from './dsl.ts';

/**
 * 规则包（Rule Pack）。
 *
 * 一个规则包 = 一组行业事故形态的固化描述 + 一份策略补丁。
 * 它是声明式的 JSON，不是代码 —— 所以：
 *   - 装进流程的东西不会执行任何代码，来源不可信也伤不到你
 *   - 可以被审阅、被 diff、被签名
 *   - 写规则包的人不需要会写 TypeScript
 *
 * 这也是"护城河在规则库"这句话能落地的前提：规则库要能被抄走、被搬运，
 * 才谈得上积累。
 */

export interface DeclarativeRule {
  id: string;
  description: string;
  severity: 'deny' | 'escalate';
  /** 命中时写进账本的说明。支持 {target} {actor} {kind} 占位 */
  detail?: string;
  when: Condition;
}

export interface RulePack {
  id: string;
  name: string;
  version?: string;
  description?: string;
  /** 适用场景说明，给人看的 */
  appliesTo?: string;
  /** 这个包假设的策略补丁，会合并进当前策略 */
  policy?: Partial<PolicyContext>;
  rules: DeclarativeRule[];
}

export class RulePackError extends Error {}

function fail(message: string): never {
  throw new RulePackError(message);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 校验并规范化一个规则包。任何不合法的地方都要给出明确原因。 */
export function parseRulePack(raw: unknown, source = '<inline>'): RulePack {
  if (!isPlainObject(raw)) fail(`${source}：规则包必须是一个 JSON 对象`);

  const id = raw.id;
  if (typeof id !== 'string' || id.trim() === '') fail(`${source}：缺少 id`);
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(id)) {
    fail(`${source}：id「${id}」只能用字母、数字、点、下划线和连字符`);
  }

  const name = raw.name;
  if (typeof name !== 'string' || name.trim() === '') fail(`${source}：缺少 name`);

  if (!Array.isArray(raw.rules)) fail(`${source}：rules 必须是数组`);
  const rules: DeclarativeRule[] = [];
  const seen = new Set<string>();
  for (const [index, item] of (raw.rules as unknown[]).entries()) {
    if (!isPlainObject(item)) fail(`${source}：第 ${index + 1} 条规则不是对象`);
    const ruleId = item.id;
    if (typeof ruleId !== 'string' || ruleId.trim() === '') {
      fail(`${source}：第 ${index + 1} 条规则缺少 id`);
    }
    if (seen.has(ruleId)) fail(`${source}：规则 id 重复「${ruleId}」`);
    seen.add(ruleId);
    if (item.severity !== 'deny' && item.severity !== 'escalate') {
      fail(`${source}：规则「${ruleId}」的 severity 只能是 deny 或 escalate`);
    }
    if (typeof item.description !== 'string' || item.description.trim() === '') {
      fail(`${source}：规则「${ruleId}」缺少 description`);
    }
    if (!isPlainObject(item.when)) fail(`${source}：规则「${ruleId}」缺少 when 条件`);
    if (!hasAnyField(item.when as Condition)) {
      fail(`${source}：规则「${ruleId}」的 when 条件是空的，永远不会命中`);
    }
    rules.push({
      id: ruleId,
      description: item.description as string,
      severity: item.severity,
      detail: typeof item.detail === 'string' ? item.detail : undefined,
      when: item.when as Condition,
    });
  }

  if (rules.length === 0) fail(`${source}：规则包里没有规则`);

  const policy = isPlainObject(raw.policy) ? (raw.policy as Partial<PolicyContext>) : undefined;
  if (policy) {
    if (policy.denylistTargets !== undefined && !Array.isArray(policy.denylistTargets)) {
      fail(`${source}：policy.denylistTargets 必须是数组`);
    }
    if (policy.grants !== undefined && !Array.isArray(policy.grants)) {
      fail(`${source}：policy.grants 必须是数组`);
    }
  }

  return {
    id,
    name,
    version: typeof raw.version === 'string' ? raw.version : undefined,
    description: typeof raw.description === 'string' ? raw.description : undefined,
    appliesTo: typeof raw.appliesTo === 'string' ? raw.appliesTo : undefined,
    policy,
    rules,
  };
}

/** 把规则包里的说明里的占位符替换掉 */
function fillDetail(template: string, req: { actor: string; action: { kind: string; target?: string } }): string {
  return template
    .replace(/\{actor\}/g, req.actor)
    .replace(/\{kind\}/g, req.action.kind)
    .replace(/\{target\}/g, req.action.target ?? '(未指定)');
}

/** 把声明式规则转成内核能跑的 Rule */
export function packToRules(pack: RulePack): Rule[] {
  return pack.rules.map((rule) => ({
    id: `${pack.id}.${rule.id}`,
    description: rule.description,
    severity: rule.severity,
    check: (req) => {
      if (!matchesCondition(rule.when, req)) return null;
      return {
        rule: `${pack.id}.${rule.id}`,
        severity: rule.severity,
        detail: fillDetail(rule.detail ?? rule.description, req),
      };
    },
  }));
}

/** 把规则包的策略补丁合并进当前策略 */
export function mergePackPolicy(base: PolicyContext, pack: RulePack): PolicyContext {
  const patch = pack.policy;
  if (!patch) return base;
  const merged: PolicyContext = { ...base };
  if (patch.denylistTargets) {
    merged.denylistTargets = [...new Set([...base.denylistTargets, ...patch.denylistTargets])];
  }
  if (patch.grants) {
    // 授权只能收紧，不能提升。规则包是"别人写的东西"，
    // 绝不能靠它给自己或别人发更高的权限。
    const byActor = new Map(base.grants.map((grant) => [grant.actor, grant]));
    for (const grant of patch.grants) {
      const existing = byActor.get(grant.actor);
      // 没有基线授权的 actor，不允许包来凭空授权
      if (!existing) continue;
      byActor.set(grant.actor, {
        actor: grant.actor,
        authority: Math.min(existing.authority, grant.authority) as typeof existing.authority,
      });
    }
    merged.grants = [...byActor.values()];
  }
  // 金额上限只能往严的方向走：包可以把 50 改成 0，但不能把 0 改成 500
  if (patch.moneyCapPerAction !== undefined) {
    merged.moneyCapPerAction = Math.min(base.moneyCapPerAction, patch.moneyCapPerAction);
  }
  if (patch.moneyCapPerSession !== undefined) {
    merged.moneyCapPerSession = Math.min(base.moneyCapPerSession, patch.moneyCapPerSession);
  }
  if (patch.allowAutonomousIrreversible !== undefined) {
    // 只允许从"允许"改成"不允许"，反向不行
    merged.allowAutonomousIrreversible = base.allowAutonomousIrreversible && patch.allowAutonomousIrreversible;
  }
  return merged;
}

/** 规则包目录 */
export const PACKS_DIR = '.vigil/packs';

export function loadPackFile(path: string): RulePack {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    fail(`${path}：不是合法的 JSON（${error instanceof Error ? error.message : String(error)}）`);
  }
  return parseRulePack(raw, path);
}

/** 读一个目录下的全部规则包。坏包不拖垮整个流程，但要报出来。 */
export function loadPacks(dir: string): { packs: RulePack[]; errors: string[] } {
  const packs: RulePack[] = [];
  const errors: string[] = [];
  if (!existsSync(dir)) return { packs, errors };
  for (const entry of readdirSync(dir)) {
    if (!entry.endsWith('.json')) continue;
    const path = join(dir, entry);
    try {
      packs.push(loadPackFile(path));
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }
  return { packs, errors };
}

/** 装一个规则包：复制到 packs 目录。同 id 覆盖需要 force。 */
export function installPack(pack: RulePack, dir: string, force = false): { path: string; replaced: boolean } {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const path = join(dir, `${pack.id}.json`);
  const replaced = existsSync(path);
  if (replaced && !force) {
    fail(`${path} 已存在。确认要覆盖就加 --force`);
  }
  writeFileSync(path, `${JSON.stringify(pack, null, 2)}\n`, 'utf8');
  return { path, replaced };
}
