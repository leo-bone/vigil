import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * 紧急制动（Kill Switch）。
 *
 * 对标 ECC 的 the-security-guide.md 里的 "Kill Switches" 一节。
 *
 * 它的场景很具体：agent 正在做一件你没想到、但已经来不及一件件看的事。
 * 这时候需要的不是"再问一次模型"，而是一个**总闸**——
 * 一条命令，让后面所有动作立刻全部转人工，直到你手动解除。
 *
 * 为什么不是"直接拒绝"：拒绝了连"停下来看看发生了什么"都做不到。
 * 转人工才是对的：人被叫醒，agent 也停下来了。
 */
export interface KillState {
  active: boolean;
  /** 制动时间 */
  since?: string;
  /** 制动原因 */
  reason?: string;
}

export const KILL_FILE = '.vigil/killed';

export function readKillState(path: string = KILL_FILE): KillState {
  if (!existsSync(path)) return { active: false };
  try {
    const raw = readFileSync(path, 'utf8').trim();
    // 空文件 = 已解除（解除动作不删文件，只清空并留一份 .released 记录）
    if (!raw) return { active: false };
    const parsed = JSON.parse(raw) as { since?: string; reason?: string };
    return { active: true, since: parsed.since, reason: parsed.reason };
  } catch {
    // 文件在但读不出来：宁可当成制动已启用，不能当成没制动
    return { active: true, since: new Date().toISOString(), reason: '（制动标记无法解析）' };
  }
}

export function engageKill(reason: string, path: string = KILL_FILE): KillState {
  const state: KillState = { active: true, since: new Date().toISOString(), reason };
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  return state;
}

/**
 * 解除制动。
 *
 * 解除本身也留痕 —— 什么时候按的、为什么按的，
 * 事后复盘时"这个紧急制动是谁解除的"必须能查到。
 */
export function releaseKill(path: string = KILL_FILE): KillState {
  const previous = readKillState(path);
  if (existsSync(path)) {
    // 不能真删（有些环境会拦截删除），改名留存同样安全：读的时候只看这个名字
    writeFileSync(`${path}.released`, `${JSON.stringify(previous, null, 2)}\n`, 'utf8');
    writeFileSync(path, '');
  }
  return { active: false };
}
