#!/usr/bin/env node
/**
 * Vigil 离线验证器 —— 零依赖单文件。
 *
 * 用途：把 bundle.json 和本文件发给任何第三方（审计师、监管、客户），
 * 对方只需 `node verify-standalone.mjs bundle.json` 就能验证：
 *   1. 序号连续、prevHash 成链
 *   2. 每条记录的哈希可复算（内容未被篡改）
 *   3. 每条记录的 Ed25519 签名有效（整条链不是重算伪造的）
 *
 * 本文件刻意不 import Vigil 的任何模块：验证器必须是独立可信的，
 * 和被验证的系统共享代码就失去了"不信任生产方"的意义。
 * 唯一需要保持同步的是 canonicalize + sha256 这两个函数（有测试守护）。
 */
import { createHash, createPublicKey, verify as edVerify } from 'node:crypto';
import { readFileSync } from 'node:fs';

function canon(value) {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(canon);
  const out = {};
  for (const key of Object.keys(value).sort()) {
    const val = value[key];
    if (val === undefined) continue;
    out[key] = canon(val);
  }
  return out;
}

function hashObject(value) {
  return createHash('sha256').update(JSON.stringify(canon(value)), 'utf8').digest('hex');
}

const [, , bundlePath] = process.argv;
if (!bundlePath) {
  console.error('用法：node verify-standalone.mjs <bundle.json>');
  process.exit(2);
}

let bundle;
try {
  bundle = JSON.parse(readFileSync(bundlePath, 'utf8'));
} catch (error) {
  console.error(`无法读取 bundle：${error.message}`);
  process.exit(2);
}

if (bundle.format !== 'vigil-bundle@1') {
  console.error(`不认识的格式：${bundle.format}`);
  process.exit(2);
}

const GENESIS = '0'.repeat(64);
const records = bundle.records ?? [];
let prev = GENESIS;
let sigsOk = 0;
let sigsTotal = 0;

for (let i = 0; i < records.length; i += 1) {
  const record = records[i];
  const fail = (reason) => {
    console.error(`✗ 第 ${i + 1} 条（${record.decisionId ?? '?'}）：${reason}`);
    process.exit(1);
  };
  if (record.seq !== i + 1) fail(`序号断裂：期望 ${i + 1}，实际 ${record.seq}`);
  if (record.prevHash !== prev) fail('prevHash 与上一条不一致');
  const { hash, label, labelNote, labelTs, approval, sig, ...body } = record;
  if (hashObject(body) !== hash) fail('哈希不匹配：内容被修改过');
  if (sig) {
    sigsTotal += 1;
    if (!bundle.publicKeyPem) fail('记录带签名但 bundle 未包含公钥');
    let ok = false;
    try {
      ok = edVerify(null, Buffer.from(hash, 'utf8'), createPublicKey(bundle.publicKeyPem), Buffer.from(sig, 'base64'));
    } catch {
      ok = false;
    }
    if (!ok) fail('Ed25519 签名无效：记录或签名被篡改，或公钥不匹配');
    sigsOk += 1;
  }
  prev = hash;
}

if (records.length > 0 && prev !== bundle.root) {
  console.error(`✗ 链尾与 bundle.root 不一致：${prev} != ${bundle.root}`);
  process.exit(1);
}

console.log(`✓ ${records.length} 条记录，哈希链完整`);
if (sigsTotal > 0) {
  console.log(`✓ ${sigsOk}/${sigsTotal} 条 Ed25519 签名验证通过（公钥指纹 ${createHash('sha256').update(bundle.publicKeyPem).digest('hex').slice(0, 16)}）`);
} else {
  console.log('· 记录未带签名（导出方未启用签名）');
}
console.log(`✓ 链尾 root = ${bundle.root.slice(0, 16)}…`);
process.exit(0);
