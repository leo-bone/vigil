import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { SqliteLedger, importNdjson, Ledger, generateSigningIdentity, signBytes } from '../src/index.ts';

const here = fileURLToPath(new URL('.', import.meta.url));
const repoRoot = join(here, '..');

/**
 * 环境探测：SQLite 需要创建并删除 journal 文件。
 *
 * 有些环境（CI 沙箱、受限的临时目录策略）会拦截这类删除，
 * 于是 SQLite 报 "disk I/O error" —— 那是环境问题，不是代码问题。
 * 与其让测试假失败，不如说清楚"这里跑不了"。
 */
function sqliteUsable(): string | false {
  try {
    const dir = mkdtempSync(join(tmpdir(), 'vigil-sqlite-probe-'));
    const db = new DatabaseSync(join(dir, 'probe.db'));
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('CREATE TABLE probe (a INTEGER)');
    db.close();
    return false;
  } catch (error) {
    return `本机环境不支持 SQLite（${error instanceof Error ? error.message : String(error)}）`;
  }
}

const SKIP = sqliteUsable();

function tempDb(): string {
  return join(mkdtempSync(join(tmpdir(), 'vigil-sqlite-')), 'ledger.db');
}

function sample(overrides: Record<string, unknown> = {}) {
  return {
    decisionId: 'dec_1',
    ts: new Date().toISOString(),
    sessionId: 's1',
    actor: 'bot/writer',
    intent: '写报告',
    action: { kind: 'draft', reversible: true, external: false },
    required: 1,
    granted: 1,
    hardBlocks: [],
    judgments: [],
    outcome: 'allow',
    evidenceIds: [],
    evidenceHash: 'x',
    costUsd: 0.5,
    ...overrides,
  } as never;
}

test('SQLite 账本：写入、读取、哈希链校验', { skip: SKIP }, () => {
  const path = tempDb();
  const ledger = new SqliteLedger(path);
  ledger.append(sample({ decisionId: 'dec_1' }));
  ledger.append(sample({ decisionId: 'dec_2', sessionId: 's2', costUsd: 1.5 }));
  ledger.close();

  const reopened = new SqliteLedger(path);
  assert.equal(reopened.all().length, 2);
  assert.equal(reopened.bySession('s2').length, 1);
  assert.equal(reopened.sessionSpend('s1'), 0.5);
  const check = reopened.verify();
  assert.equal(check.ok, true, check.reason);
  assert.equal(check.count, 2);
  reopened.close();
});

test('SQLite 与 NDJSON 的哈希链语义一致 —— 同一串决策，两种后端链相同', { skip: SKIP }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'vigil-same-'));
  const ndjson = new Ledger(join(dir, 'l.ndjson'));
  const sqlite = new SqliteLedger(join(dir, 'l.db'));

  for (let i = 0; i < 5; i += 1) {
    const input = sample({ decisionId: `dec_${i}`, ts: '2026-10-27T00:00:00.000Z' });
    const a = ndjson.append(input);
    const b = sqlite.append(input);
    assert.equal(b.hash, a.hash, `第 ${i} 条的哈希必须一致`);
    assert.equal(b.prevHash, a.prevHash);
  }
  assert.equal(sqlite.verify().ok, true);
  assert.equal(ndjson.verify().ok, true);
  ndjson.close?.();
  sqlite.close();
});

test('append 防御：调用方传了 seq/prevHash/hash 也不会污染哈希链', { skip: SKIP }, () => {
  const path = tempDb();
  const ledger = new SqliteLedger(path);
  // 模拟手滑的 JS 调用方
  ledger.append({ ...sample(), seq: 999, prevHash: 'deadbeef', hash: 'cafebabe' } as never);
  ledger.append(sample({ decisionId: 'dec_2' }));
  const check = ledger.verify();
  assert.equal(check.ok, true, check.reason);
  ledger.close();
});

test('签名记录迁移后仍然能验签', { skip: SKIP }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'vigil-migrate-'));
  const identity = generateSigningIdentity();
  const ndjsonPath = join(dir, 'l.ndjson');
  const ledger = new Ledger(ndjsonPath, {
    signer: {
      publicKeyPem: identity.publicKeyPem,
      sign: (data) => signBytes(identity.privateKeyPem, data),
    },
  });
  ledger.append(sample({ decisionId: 'dec_1' }));
  ledger.append(sample({ decisionId: 'dec_2' }));

  const dbPath = join(dir, 'l.db');
  const result = importNdjson(ndjsonPath, dbPath);
  assert.equal(result.imported, 2);

  const migrated = new SqliteLedger(dbPath, { publicKeyPem: identity.publicKeyPem });
  const check = migrated.verify();
  assert.equal(check.ok, true, check.reason);
  assert.equal(check.signaturesVerified, 2, '签名必须一起迁过去');
  migrated.close();
});

test('多进程并发写同一个账本：哈希链不能断', { skip: SKIP }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'vigil-concurrent-'));
  const dbPath = join(dir, 'l.db');
  const writer = join(dir, 'writer.mjs');
  writeFileSync(
    writer,
    `
import { SqliteLedger } from ${JSON.stringify(join(repoRoot, 'src/ledger/sqlite.ts'))};
const [path, tag, count] = process.argv.slice(2);
const ledger = new SqliteLedger(path);
for (let i = 0; i < Number(count); i += 1) {
  ledger.append({
    decisionId: 'dec_' + tag + '_' + i,
    ts: new Date().toISOString(),
    sessionId: 's_' + tag,
    actor: 'bot/' + tag,
    intent: '写入 ' + i,
    action: { kind: 'draft', reversible: true, external: false },
    required: 1, granted: 1, hardBlocks: [], judgments: [], outcome: 'allow',
    evidenceIds: [], evidenceHash: 'x', costUsd: 0.01,
  });
}
ledger.close();
`,
    'utf8',
  );

  const run = (tag: string) =>
    new Promise<void>((resolve, reject) => {
      const child = spawn(process.execPath, [writer, dbPath, tag, '25'], { stdio: 'ignore' });
      child.on('error', reject);
      child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`进程 ${tag} 退出码 ${code}`))));
    });

  await Promise.all([run('a'), run('b'), run('c')]);

  const ledger = new SqliteLedger(dbPath);
  const records = ledger.all();
  assert.equal(records.length, 75, '三个进程各写 25 条，一条都不能少');
  const check = ledger.verify();
  assert.equal(check.ok, true, check.reason);
  // 序号必须连续
  records.forEach((record, index) => assert.equal(record.seq, index + 1));
  ledger.close();
});

test('SQLite 账本：标签与审批都能落进去并读回来', { skip: SKIP }, () => {
  const path = tempDb();
  const ledger = new SqliteLedger(path);
  ledger.append(sample({ decisionId: 'dec_1', outcome: 'require_human' }));
  assert.equal(ledger.pendingApprovals().length, 1);

  const approval = ledger.approve({
    decisionId: 'dec_1',
    decision: 'approved',
    approver: 'human/boss',
    note: '同意',
  });
  assert.equal(approval.decision, 'approved');
  assert.equal(ledger.pendingApprovals().length, 0);

  ledger.label('dec_1', 'correct', '事后验证');
  const record = ledger.all()[0]!;
  assert.equal(record.label, 'correct');
  assert.equal(record.labelNote, '事后验证');
  assert.equal(record.approval?.approver, 'human/boss');
  ledger.close();
});
