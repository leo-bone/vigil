import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Ledger } from '../src/ledger/store.ts';
import { Kernel } from '../src/kernel.ts';
import { MockJudge } from '../src/judge/mock.ts';
import { defaultPolicy } from '../src/policy/rules.ts';
import { postmortem } from '../src/review/postmortem.ts';
import { calibrate } from '../src/review/calibrate.ts';
import type { Judge } from '../src/judge/index.ts';
import type { DecisionRequest } from '../src/types.ts';

const PROCEED = {
  name: 'proceed',
  type: 'boolean' as const,
  instructions: '是否应当继续',
  floor: 0.7,
};

class BoomJudge implements Judge {
  readonly name = 'boom';
  async decide(): Promise<never> {
    throw new Error('判断服务不可用');
  }
}

function makeKernel(judge: Judge = new MockJudge({ fixed: { proceed: 0.9 }, latencyMs: 0 }), path = ':memory:') {
  return new Kernel({
    ledger: new Ledger(path),
    judge,
    policy: defaultPolicy({ moneyCapPerAction: 50 }),
  });
}

function base(overrides: Partial<DecisionRequest> = {}): DecisionRequest {
  return {
    sessionId: 's1',
    actor: 'bot/outbound',
    intent: '发一封邮件',
    action: { kind: 'send_email', target: 'a@b.com', reversible: true, external: true },
    ...overrides,
  };
}

test('干净的动作会被放行', async () => {
  const kernel = makeKernel();
  const verdict = await kernel.decide(
    base({
      evidence: [{ id: 'ev1', producedBy: 'bot/researcher', verified: true }],
      questions: [PROCEED],
    }),
  );
  assert.equal(verdict.outcome, 'allow');
  assert.equal(verdict.required, 3);
});

test('金额超限直接否决，且不计入会话支出', async () => {
  const kernel = makeKernel();
  const verdict = await kernel.decide(
    base({ action: { kind: 'pay', target: 'vendor', reversible: false, external: true, moneyUsd: 80 }, costUsd: 80 }),
  );
  assert.equal(verdict.outcome, 'deny');
  assert.ok(verdict.hardBlocks.some((b) => b.rule === 'money.per_action_cap'));
  assert.equal(kernel.ledger.sessionSpend('s1'), 0);
});

test('授权不足必须转人工，不能靠模型补', async () => {
  const kernel = makeKernel();
  const verdict = await kernel.decide(
    base({
      actor: 'bot/researcher',
      action: { kind: 'delete', target: 'tmp/cache', reversible: false, external: false },
    }),
  );
  assert.equal(verdict.outcome, 'require_human');
  assert.equal(verdict.required, 3);
  assert.equal(verdict.granted, 1);
});

test('对外动作没有证据，一律转人工', async () => {
  const kernel = makeKernel();
  const verdict = await kernel.decide(base({ evidence: [] }));
  assert.equal(verdict.outcome, 'require_human');
  assert.ok(verdict.hardBlocks.some((b) => b.rule === 'evidence.required_for_external'));
});

test('证据全部由自己产出 = 自己批自己的卷子，转人工', async () => {
  const kernel = makeKernel();
  const verdict = await kernel.decide(
    base({ actor: 'bot/outbound', evidence: [{ id: 'ev1', producedBy: 'bot/outbound', verified: true }] }),
  );
  assert.equal(verdict.outcome, 'require_human');
  assert.ok(verdict.hardBlocks.some((b) => b.rule === 'evidence.self_review'));
});

test('判断器宕机时 fail-closed，而不是放行', async () => {
  const kernel = makeKernel(new BoomJudge());
  const verdict = await kernel.decide(
    base({
      evidence: [{ id: 'ev1', producedBy: 'bot/researcher', verified: true }],
      questions: [PROCEED],
    }),
  );
  assert.equal(verdict.outcome, 'require_human');
  assert.ok(verdict.reason.includes('fail-closed'));
});

test('置信度低于 floor 时不给过', async () => {
  const kernel = makeKernel(new MockJudge({ fixed: { proceed: 0.55 }, latencyMs: 0 }));
  const verdict = await kernel.decide(
    base({
      evidence: [{ id: 'ev1', producedBy: 'bot/researcher', verified: true }],
      questions: [PROCEED],
    }),
  );
  assert.equal(verdict.outcome, 'require_human');
});

test('哈希链可校验，且能抓出被改过的记录', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'vigil-'));
  const path = join(dir, 'ledger.ndjson');
  const kernel = makeKernel(new MockJudge({ fixed: { proceed: 0.9 }, latencyMs: 0 }), path);
  await kernel.decide(base({ intent: '第一件事' }));
  await kernel.decide(base({ intent: '第二件事' }));

  const fresh = new Ledger(path);
  assert.equal(fresh.verify().ok, true);
  assert.equal(fresh.verify().count, 2);

  const tampered = readFileSync(path, 'utf8').replace('第一件事', '另一件事');
  writeFileSync(path, tampered, 'utf8');
  const after = new Ledger(path);
  const result = after.verify();
  assert.equal(result.ok, false);
  assert.equal(result.brokenAt, 1);
});

test('事后梳理能算出虚假完成率与可追溯率', async () => {
  const kernel = makeKernel();
  const ok1 = await kernel.decide(
    base({
      intent: '带证据发信',
      evidence: [{ id: 'ev1', producedBy: 'bot/researcher', verified: true }],
      questions: [PROCEED],
    }),
  );
  const ok2 = await kernel.decide(
    base({
      intent: '没证据发信',
      action: { kind: 'send_email', target: 'x@y.com', reversible: true, external: false },
    }),
  );
  kernel.ledger.label(ok1.decisionId, 'correct');
  kernel.ledger.label(ok2.decisionId, 'wrong', '客户否认需求');

  const report = postmortem(kernel.ledger, 's1');
  assert.equal(report.decisions, 2);
  assert.equal(report.chainOk, true);
  // 可追溯率只统计对外动作：ok2 的 action 不是 external，不纳入分母
  assert.equal(report.metrics.traceableRate, 1);
  assert.equal(report.metrics.falseDoneRate, 0.5);
  assert.equal(report.falsified.length, 1);
});

test('校准能算出 Brier 分数并给出阈值扫描', async () => {
  const kernel = makeKernel(new MockJudge({ fixed: { proceed: 0.85 }, latencyMs: 0 }));
  const a = await kernel.decide(
    base({ intent: 'A', evidence: [{ id: 'e1', producedBy: 'r', verified: true }], questions: [PROCEED] }),
  );
  const b = await kernel.decide(
    base({ intent: 'B', evidence: [{ id: 'e2', producedBy: 'r', verified: true }], questions: [PROCEED] }),
  );
  kernel.ledger.label(a.decisionId, 'correct');
  kernel.ledger.label(b.decisionId, 'wrong');

  const report = calibrate(kernel.ledger.all(), { question: 'proceed' });
  assert.equal(report.samples, 2);
  assert.ok(report.brier !== null && report.brier > 0.3);
  assert.ok(report.sweep.length > 0);
});
