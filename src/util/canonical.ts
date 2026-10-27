import { createHash } from 'node:crypto';

/**
 * 稳定序列化：对象键排序，丢弃 undefined。
 * 哈希链必须建立在稳定序列化之上，否则同一份内容换个键序就成了另一个哈希。
 */
function canon(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(canon);
  const src = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(src).sort()) {
    const val = src[key];
    if (val === undefined) continue;
    out[key] = canon(val);
  }
  return out;
}

export function canonicalize(value: unknown): string {
  return JSON.stringify(canon(value));
}

export function sha256(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

export function hashObject(value: unknown): string {
  return sha256(canonicalize(value));
}

/** 短 id，够用且可读 */
export function shortId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

/** 简单通配：`bot/*` 匹配 `bot/engineer`，`*` 匹配一切 */
export function matchesActor(pattern: string, actor: string): boolean {
  if (pattern === '*') return true;
  if (pattern.endsWith('*')) return actor.startsWith(pattern.slice(0, -1));
  return pattern === actor;
}
