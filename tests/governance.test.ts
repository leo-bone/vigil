import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  Ledger,
  Kernel,
  MockJudge,
  LocalJudge,
  JevJudge,
  createPipelineKernel,
  Orchestrator,
  exportBundle,
  adviseThresholds,
  generateSigningIdentity,
  verifyBytes,
  signBytes,
  shapeOfJudgment,
} from '../src/index.ts';
import { hashObject } from '../src/util/canonical.ts';
import type { DecisionRequest, JudgeQuestion } from '../src/index.ts';

const PROCEED: JudgeQuestion = {
  name: 'proceed',
  type: 'boolean',
  instructions: '是否继续',
  floor: 0.7,
};

function base(overrides: Partial<DecisionRequest> = {}): DecisionRequest {
  return {
    sessionId: 's1',
    actor: 'human/operator',
    intent: '测试动作',
    action: { kind: 'draft', target: 'notes.md', reversible: true, external: false },
    ...overrides,
  };
}

test('签名：配置密钥后每条记录都被签名，验签通过', () => {
  const identity = generateSigningIdentity();
  const ledger = new Ledger(':memory:', {
    signer: { publicKeyPem: identity.publicKeyPem, sign: (data) => signBytes(identity.privateKeyPem, data) },
  });
  const record = ledger.append({
    decisionId: 'dec_1',
    ts: new Date().toISOString(),
    sessionId: 's1',
    actor: 'human/a',
    intent: 'x',
    action: { kind: 'draft', reversible: true, external: false },
    required: 1,
    granted: 4,
    hardBlocks: [],
    judgments: [],
    outcome: 'allow',
    evidenceIds: [],
    evidenceHash: 'x',
    costUsd: 0,
  });
  assert.ok(record.sig);
  const result = ledger.verify();
  assert.equal(result.ok, true);
  assert.equal(result.signaturesVerified, 1);
});

test('签名：篡改记录内容会同时破坏哈希链和签名', () => {
  const identity = generateSigningIdentity();
  const ledger = new Ledger(':memory:', {
    signer: { publicKeyPem: identity.publicKeyPem, sign: (data) => signBytes(identity.privateKeyPem, data) },
  });
  const record = ledger.append({
    decisionId: 'dec_1',
    ts: new Date().toISOString(),
    sessionId: 's1',
    actor: 'human/a',
    intent: 'x',
    action: { kind: 'draft', reversible: true, external: false },
    required: 1,
    granted: 4,
    hardBlocks: [],
    judgments: [],
    outcome: 'allow',
    evidenceIds: [],
    evidenceHash: 'x',
    costUsd: 0,
  });
  // 攻击者改内容并重算哈希（无私钥，签名还是旧的）
  record.intent = '被篡改的意图';
  const { sig, label, labelNote, labelTs, approval, hash, ...body } = record;
  record.hash = hashObject(body);
  const result = ledger.verify();
  assert.equal(result.ok, false);
  assert.ok(result.reason!.includes('签名'), `实际原因：${result.reason}`);
  assert.equal(verifyBytes(identity.publicKeyPem, record.hash, record.sig!), false);
  void sig; void label; void labelNote; void labelTs; void approval; void hash;
});

test('签名：无公钥时验有签名的账本直接失败', () => {
  const ledger = new Ledger(':memory:');
  const record = ledger.append({
    decisionId: 'dec_1',
    ts: new Date().toISOString(),
    sessionId: 's1',
    actor: 'human/a',
    intent: 'x',
    action: { kind: 'draft', reversible: true, external: false },
    required: 1,
    granted: 4,
    hardBlocks: [],
    judgments: [],
    outcome: 'allow',
    evidenceIds: [],
    evidenceHash: 'x',
    costUsd: 0,
  });
  // 攻击者想补一个假签名蒙混过关
  record.sig = 'AAAA';
  const result = ledger.verify();
  assert.equal(result.ok, false);
  assert.ok(result.reason!.includes('公钥'), `实际原因：${result.reason}`);
  void record;
});

test('审批：绑定记录哈希，拒绝重复审批', () => {
  const ledger = new Ledger(':memory:');
  const record = ledger.append({
    decisionId: 'dec_esc',
    ts: new Date().toISOString(),
    sessionId: 's1',
    actor: 'human/a',
    intent: '危险动作',
    action: { kind: 'send_email', target: 'a@b.c', reversible: false, external: true },
    required: 3,
    granted: 1,
    hardBlocks: [],
    judgments: [],
    outcome: 'require_human',
    evidenceIds: [],
    evidenceHash: 'x',
    costUsd: 0,
  });
  assert.equal(ledger.pendingApprovals().length, 1);
  const info = ledger.approve({ decisionId: 'dec_esc', decision: 'approved', approver: 'human/boss', note: '同意' });
  assert.equal(info.boundHash, record.hash);
  assert.equal(ledger.pendingApprovals().length, 0);
  assert.throws(() => ledger.approve({ decisionId: 'dec_esc', decision: 'rejected', approver: 'human/other' }));
  assert.throws(() => ledger.approve({ decisionId: 'no_such', decision: 'approved', approver: 'x' }));
});

test('阈值建议：从标注样本算出按题型的 floor', async () => {
  // 手工构造账本记录，测 adviseThresholds 的纯逻辑：
  // 六个高把握且正确的放行样本 + 一个高把握但错误的样本 + 一个低把握的错误样本
  // —— floor 必须升到能挡住那个"自信的错误"
  const cases: Array<{ p: number; label: 'correct' | 'wrong' }> = [
    { p: 0.95, label: 'correct' },
    { p: 0.92, label: 'correct' },
    { p: 0.9, label: 'correct' },
    { p: 0.88, label: 'correct' },
    { p: 0.86, label: 'correct' },
    { p: 0.84, label: 'correct' },
    { p: 0.93, label: 'wrong' },
    { p: 0.3, label: 'wrong' },
  ];
  const records = cases.map((item, i) => ({
    decisionId: `d${i}`,
    ts: new Date().toISOString(),
    sessionId: 's',
    actor: 'a',
    intent: 'x',
    action: { kind: 'draft', reversible: true, external: false },
    required: 1,
    granted: 4,
    hardBlocks: [],
    judgments: [{ name: 'proceed', type: 'boolean', probability: item.p, confidence: item.p, direction: 'above', valid: true }],
    outcome: 'allow',
    evidenceIds: [],
    evidenceHash: 'x',
    costUsd: 0,
    prevHash: '0',
    hash: 'h',
    label: item.label,
  }));
  const report = adviseThresholds(records as never, { minSamples: 5, targetPrecision: 1 });
  // 0.93 的自信错误必须在门槛之外 → floor ≥ 0.95 才能只放行全对的区间
  assert.ok(report.suggested.boolean >= 0.95, `应挡住 0.93 的自信错误，实际 ${report.suggested.boolean}`);
  assert.equal(shapeOfJudgment({ type: 'boolean' } as never), 'boolean');
});

test('离线验证包：导出的 bundle 能被零依赖 verifier 通过；篡改后被拒', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'vigil-bundle-'));
  const ledgerPath = join(dir, 'ledger.ndjson');
  const identity = generateSigningIdentity();
  const ledger = new Ledger(ledgerPath, {
    signer: { publicKeyPem: identity.publicKeyPem, sign: (data) => signBytes(identity.privateKeyPem, data) },
  });
  const kernel = new Kernel({
    ledger,
    judge: new MockJudge({ fixed: { proceed: 0.9 }, latencyMs: 0 }),
  });
  await kernel.decide(base({ intent: '第一件事', questions: [PROCEED] }));
  await kernel.decide(base({ intent: '第二件事', questions: [PROCEED] }));
  const bundlePath = join(dir, 'bundle.json');
  writeFileSync(bundlePath, JSON.stringify(exportBundle(ledger, identity.publicKeyPem)), 'utf8');

  const verifier = join(import.meta.dirname ?? '.', '..', 'verify-standalone.mjs');
  const stdout = execFileSync('node', [verifier, bundlePath], { encoding: 'utf8' });
  assert.ok(stdout.includes('哈希链完整'));
  assert.ok(stdout.includes('签名验证通过'));

  // 篡改：改一条记录的意图，不重算任何东西
  const bundle = JSON.parse(readFileSync(bundlePath, 'utf8'));
  bundle.records[0].intent = '被篡改';
  const tamperedPath = join(dir, 'tampered.json');
  writeFileSync(tamperedPath, JSON.stringify(bundle), 'utf8');
  assert.throws(() => execFileSync('node', [verifier, tamperedPath], { encoding: 'utf8' }));
});

test('LocalJudge：走 /v1/systemone 方言，解析 noul 答案', async () => {
  const judge = new LocalJudge({ baseUrl: 'http://127.0.0.1:9999/v1/systemone' });
  assert.equal(judge.name, 'local');
  // LocalJudge 继承 JevJudge 的解析路径，用假 fetch 验证 noul 字段的解析
  const fake = new JevJudge({ apiKey: 'x', baseUrl: 'http://127.0.0.1:9999/v1/systemone' });
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ answers: { proceed: { type: 'noul', noul: 0.86, confidence: 0.9 } } }), { status: 200 })) as never;
  try {
    const judgments = await fake.decide('state', [PROCEED]);
    assert.equal(judgments[0]!.valid, true);
    assert.equal(judgments[0]!.probability, 0.86);
  } finally {
    globalThis.fetch = origFetch;
  }
  void judge;
});

test('编排：升级回调批准后继续，审批落账', async () => {
  const kernel = createPipelineKernel(new Ledger(':memory:'), new MockJudge({ latencyMs: 0 }), {}, {});
  let escalated = 0;
  const company = new Orchestrator(kernel, {
    onEscalation: (info) => {
      escalated += 1;
      assert.ok(info.reason);
      return 'retry';
    },
  });
  // 一个没有工人的名册：路由必然选不出人 → 升级 → 回调批准 → 仍选不出 → 第二次批准 → 超限终止
  const report = await company.runTask('s1', 't1', '任务', []);
  assert.ok(escalated >= 1);
  assert.equal(report.status, 'escalated');
  const approvals = kernel.ledger.all().filter((r) => r.approval?.decision === 'approved');
  assert.ok(approvals.length >= 1);
  for (const record of approvals) {
    assert.ok(record.approval!.boundHash === record.hash);
  }
});
