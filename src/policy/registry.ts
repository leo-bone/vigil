import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseRulePack, installPack, type RulePack } from './pack.ts';
import { signBytes, verifyBytes } from '../ledger/signing.ts';

/**
 * 规则包注册表（索引）与分发。
 *
 * 规则包一旦能被分发，"别人写的规则"就能进你的决策链路。
 * 这是个新攻击面，必须当成外来输入处理：
 *
 *   1. 指纹 —— 索引里记内容的 sha256，装之前必须对上，
 *      否则"索引说 A、下载来的是 B"就成立。
 *   2. 签名 —— 有签名的包必须验签通过才能装。
 *      没签名的包也能装，但会明确告诉你"这个包没人签字"。
 *   3. 只收紧不放松 —— 策略补丁只能把上限压低、把禁止清单加长、
 *      把授权降级，绝不能反过来。（这条在 mergePackPolicy 里强制）
 *   4. 声明式 —— 包是 JSON，不执行任何代码，最坏情况就是一条规则一直命中。
 */

/** 包文件大小上限。防止超大连载把内存吃光。 */
export const MAX_PACK_BYTES = 256 * 1024;
/** 规则条数上限 */
export const MAX_PACK_RULES = 200;

export interface PackIndexEntry {
  id: string;
  name: string;
  version: string;
  description?: string;
  appliesTo?: string;
  author?: string;
  /** 包文件地址：本地路径或 http(s) URL */
  url: string;
  /** 包内容的 sha256（规范化 JSON 后） */
  sha256: string;
  /** 规则条数，装之前用来对账 */
  rules: number;
  /** 对 sha256 的签名（base64） */
  signature?: string;
  /** 签名者公钥（PEM） */
  publicKeyPem?: string;
  publishedAt?: string;
}

export interface PackIndex {
  version: 1;
  updatedAt: string;
  packs: PackIndexEntry[];
}

export const INDEX_FILENAME = 'vigil.rules.json';

/**
 * 规范化 JSON：键排序后序列化。
 *
 * 指纹必须算在"同一个包的不同写法"上，否则有人改个空格就能绕过指纹比对。
 */
export function canonicalPack(pack: RulePack): string {
  const sorted = {
    id: pack.id,
    name: pack.name,
    version: pack.version ?? '',
    description: pack.description ?? '',
    appliesTo: pack.appliesTo ?? '',
    policy: pack.policy ? sortKeys(pack.policy as Record<string, unknown>) : null,
    rules: pack.rules.map((rule) => ({
      id: rule.id,
      description: rule.description,
      severity: rule.severity,
      detail: rule.detail ?? '',
      when: sortKeys(rule.when as unknown as Record<string, unknown>),
    })),
  };
  return JSON.stringify(sorted, null, 2);
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0,
    );
    return Object.fromEntries(entries.map(([key, item]) => [key, sortKeys(item)]));
  }
  return value;
}

export function packDigest(pack: RulePack): string {
  return createHash('sha256').update(canonicalPack(pack)).digest('hex');
}

/** 给索引条目做一条新登记 */
export function buildIndexEntry(
  pack: RulePack,
  url: string,
  options: { author?: string; signer?: { privateKeyPem: string; publicKeyPem: string } } = {},
): PackIndexEntry {
  const sha256 = packDigest(pack);
  const entry: PackIndexEntry = {
    id: pack.id,
    name: pack.name,
    version: pack.version ?? '0.0.0',
    description: pack.description,
    appliesTo: pack.appliesTo,
    author: options.author,
    url,
    sha256,
    rules: pack.rules.length,
    publishedAt: new Date().toISOString(),
  };
  if (options.signer) {
    entry.signature = signBytes(options.signer.privateKeyPem, sha256);
    entry.publicKeyPem = options.signer.publicKeyPem;
  }
  return entry;
}

export function readIndex(path: string): PackIndex {
  if (!existsSync(path)) return { version: 1, updatedAt: new Date().toISOString(), packs: [] };
  const raw = JSON.parse(readFileSync(path, 'utf8')) as PackIndex;
  if (raw.version !== 1) throw new Error(`索引版本不认识：${raw.version}`);
  if (!Array.isArray(raw.packs)) throw new Error('索引格式不对：packs 必须是数组');
  return raw;
}

export function writeIndex(path: string, index: PackIndex): void {
  const dir = path.slice(0, path.lastIndexOf('/'));
  if (dir && !existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(path, `${JSON.stringify(index, null, 2)}\n`, 'utf8');
}

/** 把一个包登记进索引。同 id 覆盖。 */
export function publishToIndex(
  index: PackIndex,
  entry: PackIndexEntry,
): { index: PackIndex; replaced: boolean } {
  const packs = index.packs.filter((item) => item.id !== entry.id);
  const replaced = packs.length !== index.packs.length;
  packs.push(entry);
  packs.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return {
    index: { ...index, version: 1, updatedAt: new Date().toISOString(), packs },
    replaced,
  };
}

/** 在索引里搜。关键词匹配 id、名字、描述、适用场景。 */
export function searchIndex(index: PackIndex, keyword: string): PackIndexEntry[] {
  const q = keyword.trim().toLowerCase();
  if (!q) return index.packs;
  return index.packs.filter((entry) =>
    [entry.id, entry.name, entry.description, entry.appliesTo, entry.author]
      .filter(Boolean)
      .some((field) => String(field).toLowerCase().includes(q)),
  );
}

export interface VerifyResult {
  ok: boolean;
  reason?: string;
  /** 包是不是签过名的 */
  signed: boolean;
}

/**
 * 信任钥匙串。
 *
 * 这是"规则包可分发"这件事的安全底座。
 *
 * 索引自己带公钥是不够的：能改索引的人，也能把公钥和签名一起换掉，
 * 伪造出一个"看起来验签通过"的包。所以**索引只能是目录，不能是信任锚**。
 *
 * 真正的信任锚是用户显式固定的公钥（.vigil/trusted-keys.json）。
 * 索引里带公钥只是为了让人知道"这个包是谁签的"，以及方便比对。
 */
export interface TrustStore {
  keys: Array<{ name: string; publicKeyPem: string; addedAt?: string }>;
}

export const TRUST_FILE = '.vigil/trusted-keys.json';

export function readTrustStore(path: string = TRUST_FILE): TrustStore {
  if (!existsSync(path)) return { keys: [] };
  const raw = JSON.parse(readFileSync(path, 'utf8')) as TrustStore;
  if (!Array.isArray(raw.keys)) return { keys: [] };
  return raw;
}

export function writeTrustStore(store: TrustStore, path: string = TRUST_FILE): void {
  const dir = path.slice(0, path.lastIndexOf('/'));
  if (dir && !existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(path, `${JSON.stringify(store, null, 2)}\n`, 'utf8');
}

/** 这个公钥在不在信任列表里 */
export function isTrusted(store: TrustStore, publicKeyPem: string): boolean {
  const normalize = (pem: string) => pem.replace(/\s+/g, '');
  return store.keys.some((item) => normalize(item.publicKeyPem) === normalize(publicKeyPem));
}

export function addTrustedKey(
  store: TrustStore,
  name: string,
  publicKeyPem: string,
): { store: TrustStore; added: boolean } {
  if (isTrusted(store, publicKeyPem)) return { store, added: false };
  const keys = [...store.keys, { name, publicKeyPem, addedAt: new Date().toISOString() }];
  return { store: { keys }, added: true };
}

/**
 * 校验一个包和索引条目对不对得上。
 *
 * 三件事：指纹对不对、签名验不验得过、包本身合不合法。
 *
 * 公钥从哪来很重要：
 *   - 显式传入的可信公钥优先
 *   - 其次是信任列表里的
 *   - 索引自带的公钥**不算数** —— 能改索引就能换掉它
 */
export function verifyPack(
  entry: PackIndexEntry,
  pack: RulePack,
  options: { trustedKeyPem?: string; trust?: TrustStore } = {},
): VerifyResult {
  const signed = Boolean(entry.signature);
  const digest = packDigest(pack);
  if (digest !== entry.sha256) {
    return {
      ok: false,
      signed,
      reason: `内容指纹对不上：索引记录 ${entry.sha256.slice(0, 12)}…，实际 ${digest.slice(0, 12)}…`,
    };
  }
  if (!entry.signature) {
    return { ok: true, signed };
  }

  const trusted =
    options.trustedKeyPem ??
    (options.trust && entry.publicKeyPem && isTrusted(options.trust, entry.publicKeyPem)
      ? entry.publicKeyPem
      : undefined);

  if (!trusted) {
    return {
      ok: false,
      signed,
      reason:
        '这个包有签名，但当前没有可信公钥。索引自带的公钥不算数 —— 能改索引就能换掉它。' +
        '请用 vigil trust add <公钥.pem> 把签名者的公钥加进信任列表',
    };
  }
  if (!verifyBytes(trusted, entry.sha256, entry.signature)) {
    return { ok: false, signed, reason: '签名验证失败：包的内容与签名者当初签的不是一份' };
  }
  return { ok: true, signed };
}

/** 读一个包（本地路径或 http(s) URL） */
export async function fetchPack(url: string): Promise<RulePack> {
  let raw: string;
  if (/^https?:\/\//i.test(url)) {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`下载失败 ${response.status}：${url}`);
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > MAX_PACK_BYTES) {
      throw new Error(`包太大了（${buffer.byteLength} 字节，上限 ${MAX_PACK_BYTES}）`);
    }
    raw = new TextDecoder().decode(buffer);
  } else {
    if (!existsSync(url)) throw new Error(`找不到规则包文件：${url}`);
    const stat = readFileSync(url);
    if (stat.byteLength > MAX_PACK_BYTES) {
      throw new Error(`包太大了（${stat.byteLength} 字节，上限 ${MAX_PACK_BYTES}）`);
    }
    raw = stat.toString('utf8');
  }
  const pack = parseRulePack(JSON.parse(raw), url);
  if (pack.rules.length > MAX_PACK_RULES) {
    throw new Error(`规则条数超限（${pack.rules.length} 条，上限 ${MAX_PACK_RULES}）`);
  }
  return pack;
}

/**
 * 从索引安装一个包。
 *
 * 顺序很关键：先取回、再校验指纹与签名、最后才落盘。
 * 校验不过的包一个字节都不写进 packs 目录。
 */
export async function installFromIndex(
  entry: PackIndexEntry,
  packsDir: string,
  options: { trustedKeyPem?: string; trust?: TrustStore; force?: boolean } = {},
): Promise<{ path: string; verify: VerifyResult }> {
  const pack = await fetchPack(entry.url);
  const verify = verifyPack(entry, pack, {
    trustedKeyPem: options.trustedKeyPem,
    trust: options.trust,
  });
  if (!verify.ok) throw new Error(`规则包校验不通过：${verify.reason}`);
  const result = installPack(pack, packsDir, options.force);
  return { path: result.path, verify };
}
