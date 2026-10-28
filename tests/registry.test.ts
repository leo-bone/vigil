import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  parseRulePack,
  mergePackPolicy,
  packDigest,
  canonicalPack,
  buildIndexEntry,
  readIndex,
  writeIndex,
  publishToIndex,
  searchIndex,
  verifyPack,
  installFromIndex,
  fetchPack,
} from '../src/index.ts';
import { generateSigningIdentity, signBytes } from '../src/index.ts';
import type { PolicyContext } from '../src/policy/rules.ts';

const BASE: PolicyContext = {
  moneyCapPerAction: 0,
  moneyCapPerSession: 0,
  allowAutonomousIrreversible: false,
  denylistTargets: ['.env'],
  grants: [{ actor: 'bot/*', authority: 2 }],
};

function pack(raw: Record<string, unknown>) {
  return parseRulePack(raw);
}

test('指纹：规范化后算，改空格改顺序都不影响', () => {
  const a = pack({
    id: 'x.y',
    name: '示例',
    version: '1.0.0',
    rules: [{ id: 'r', description: 'd', severity: 'deny', when: { kindIn: ['a'], external: true } }],
  });
  const b = pack({
    id: 'x.y',
    name: '示例',
    version: '1.0.0',
    rules: [{ id: 'r', description: 'd', severity: 'deny', when: { external: true, kindIn: ['a'] } }],
  });
  assert.equal(canonicalPack(a), canonicalPack(b), '键顺序不同但内容相同，指纹必须一样');
  assert.equal(packDigest(a), packDigest(b));
});

test('指纹：内容改一个字节就对不上', () => {
  const a = pack({
    id: 'x.y',
    name: '示例',
    rules: [{ id: 'r', description: 'd', severity: 'deny', when: { kindIn: ['a'] } }],
  });
  const b = pack({
    id: 'x.y',
    name: '示例',
    rules: [{ id: 'r', description: '改过的 d', severity: 'deny', when: { kindIn: ['a'] } }],
  });
  assert.notEqual(packDigest(a), packDigest(b));
});

test('策略补丁只能收紧，不能放松 —— 恶意包放不宽任何东西', () => {
  const evil = pack({
    id: 'evil.relax',
    name: '恶意包',
    policy: {
      moneyCapPerAction: 999999,
      moneyCapPerSession: 999999,
      allowAutonomousIrreversible: true,
      grants: [{ actor: 'bot/evil', authority: 4 }],
    },
    rules: [{ id: 'r', description: 'd', severity: 'deny', when: { kindIn: ['never'] } }],
  });
  const merged = mergePackPolicy(BASE, evil);

  assert.equal(merged.moneyCapPerAction, 0, '金额上限不能被抬高');
  assert.equal(merged.moneyCapPerSession, 0, '会话上限不能被抬高');
  assert.equal(merged.allowAutonomousIrreversible, false, '不能放开无人值守不可逆');
  assert.ok(!merged.grants.some((grant) => grant.actor === 'bot/evil'), '不能凭空授权');
  for (const grant of merged.grants) {
    assert.ok(grant.authority <= 2, '授权只能降级');
  }
});

test('策略补丁：禁止清单只能加长，金额上限只能压低', () => {
  const good = pack({
    id: 'good.pack',
    name: '好包',
    policy: { denylistTargets: ['secrets/'], moneyCapPerAction: 0 },
    rules: [{ id: 'r', description: 'd', severity: 'deny', when: { kindIn: ['x'] } }],
  });
  const merged = mergePackPolicy(BASE, good);
  assert.deepEqual(merged.denylistTargets, ['.env', 'secrets/']);
  assert.equal(merged.moneyCapPerAction, 0);

  // 基线宽松时，包可以往下压
  const loose = { ...BASE, moneyCapPerAction: 100 };
  assert.equal(mergePackPolicy(loose, good).moneyCapPerAction, 0);
});

test('索引：发布、读取、搜索', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vigil-index-'));
  const path = join(dir, 'vigil.rules.json');
  const target = pack({
    id: 'healthcare.patient-data',
    name: '医疗患者数据保护',
    description: '患者数据外发要卡住',
    rules: [{ id: 'r', description: 'd', severity: 'deny', when: { kindIn: ['x'] } }],
  });

  let index = readIndex(path);
  assert.equal(index.packs.length, 0);

  const entry = buildIndexEntry(target, 'https://example.com/pack.json');
  const published = publishToIndex(index, entry);
  index = published.index;
  writeIndex(path, index);

  const reloaded = readIndex(path);
  assert.equal(reloaded.packs.length, 1);
  assert.equal(reloaded.packs[0]!.id, 'healthcare.patient-data');

  assert.equal(searchIndex(reloaded, '患者').length, 1);
  assert.equal(searchIndex(reloaded, '不存在的词').length, 0);
  assert.equal(searchIndex(reloaded, '').length, 1);
});

test('校验：内容对得上、签名有效才算通过', () => {
  const identity = generateSigningIdentity();
  const target = pack({
    id: 'signed.pack',
    name: '签名包',
    rules: [{ id: 'r', description: 'd', severity: 'deny', when: { kindIn: ['x'] } }],
  });
  const entry = buildIndexEntry(target, 'https://example.com/pack.json', {
    signer: { privateKeyPem: identity.privateKeyPem, publicKeyPem: identity.publicKeyPem },
  });

  const ok = verifyPack(entry, target, { trustedKeyPem: identity.publicKeyPem });
  assert.equal(ok.ok, true);
  assert.equal(ok.signed, true);

  // 篡改内容 → 指纹对不上
  const tampered = pack({
    id: 'signed.pack',
    name: '签名包',
    rules: [{ id: 'r', description: '被改了', severity: 'deny', when: { kindIn: ['x'] } }],
  });
  const bad = verifyPack(entry, tampered, { trustedKeyPem: identity.publicKeyPem });
  assert.equal(bad.ok, false);
  assert.ok(bad.reason?.includes('指纹'));

  // 换一个人的签名 → 验签失败
  const other = generateSigningIdentity();
  const forged = { ...entry, signature: signBytes(other.privateKeyPem, entry.sha256) };
  const forgedResult = verifyPack(forged, target, { trustedKeyPem: identity.publicKeyPem });
  assert.equal(forgedResult.ok, false);
  assert.ok(forgedResult.reason?.includes('签名'));

  // 索引自带公钥不算数 —— 能改索引就能换掉公钥和签名一起伪造
  const selfSigned = verifyPack(entry, target);
  assert.equal(selfSigned.ok, false);
  assert.ok(selfSigned.reason?.includes('可信公钥'));

  // 但公钥在信任列表里就放行
  const trusted = verifyPack(entry, target, {
    trust: { keys: [{ name: 'me', publicKeyPem: identity.publicKeyPem }] },
  });
  assert.equal(trusted.ok, true);
});

test('从索引安装：校验不过的包一个字节都不写', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'vigil-install-'));
  const packsDir = join(dir, 'packs');
  const file = join(dir, 'pack.json');
  const target = pack({
    id: 'good.pack',
    name: '好包',
    rules: [{ id: 'r', description: 'd', severity: 'deny', when: { kindIn: ['x'] } }],
  });
  writeFileSync(file, JSON.stringify(target), 'utf8');

  const entry = buildIndexEntry(target, file);
  const result = await installFromIndex(entry, packsDir);
  assert.equal(result.verify.ok, true);

  // 把文件改了，指纹就对不上了
  const tamperedFile = join(dir, 'tampered.json');
  writeFileSync(
    tamperedFile,
    JSON.stringify(pack({
      id: 'good.pack',
      name: '好包',
      rules: [{ id: 'r', description: '被改了', severity: 'deny', when: { kindIn: ['x'] } }],
    })),
    'utf8',
  );
  const badEntry = { ...entry, url: tamperedFile };
  await assert.rejects(() => installFromIndex(badEntry, join(dir, 'packs2')), /校验不通过/);
});

test('取包：本地文件与 URL 都要有大小上限', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'vigil-fetch-'));
  const huge = join(dir, 'huge.json');
  const big = { id: 'a.b', name: 'x'.repeat(300 * 1024), rules: [] };
  writeFileSync(huge, JSON.stringify(big), 'utf8');
  await assert.rejects(() => fetchPack(huge), /太大了/);
});
