import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Ledger } from '../src/ledger/store.ts';
import { MockJudge } from '../src/judge/mock.ts';
import {
  createPipelineKernel,
  Orchestrator,
  forkAcceptance,
  forkEscalate,
  forkQualityGate,
  forkRoute,
  forkStopLoss,
} from '../src/index.ts';
import type { VigilWorker, WorkerOutput } from '../src/index.ts';

function setup(fixed: Record<string, number> = {}, choices: Record<string, string> = {}) {
  const ledger = new Ledger(':memory:');
  const kernel = createPipelineKernel(ledger, new MockJudge({ fixed, choices }));
  return { ledger, kernel };
}

const ROSTER = [
  { id: 'bot/researcher', role: '研究员' },
  { id: 'bot/writer', role: '写手' },
];

test('路由：从名册里选出执行者', async () => {
  const { kernel } = setup({}, { next_worker: 'bot/writer' });
  const result = await forkRoute(kernel, {
    sessionId: 's1',
    taskId: 't1',
    task: '写报告',
    stateSummary: '刚接手',
    roster: ROSTER,
  });
  assert.equal(result.workerId, 'bot/writer');
  assert.equal(result.needsHuman, false);
  assert.equal(result.verdict.outcome, 'allow');
});

test('路由：模型选了名册外的人 → 拒绝派工并升级落账', async () => {
  const { kernel, ledger } = setup({}, { next_worker: 'bot/ghost' });
  const result = await forkRoute(kernel, {
    sessionId: 's1',
    taskId: 't1',
    task: '写报告',
    stateSummary: '刚接手',
    roster: ROSTER,
  });
  assert.equal(result.workerId, null);
  assert.equal(result.needsHuman, true);
  // 升级本身也是一条账目
  assert.ok(ledger.bySession('s1').some((r) => r.intent.includes('升级人工')));
});

test('质量门：把握不足时退回', async () => {
  const { kernel } = setup({ quality_sufficient: 0.4 });
  const result = await forkQualityGate(kernel, {
    sessionId: 's1',
    taskId: 't1',
    producer: 'bot/researcher',
    claim: '研究完成',
    material: '一堆草稿',
  });
  assert.equal(result.passed, false);
  assert.equal(result.verdict.outcome, 'require_human');
});

test('止损：重试次数到顶，确定性 deny', async () => {
  const { kernel } = setup({ progress: 5 });
  const result = await forkStopLoss(kernel, {
    sessionId: 's1',
    taskId: 't1',
    attempts: 3,
    maxAttempts: 3,
    consecutiveFailures: 0,
    stateSummary: '',
  });
  assert.equal(result.stop, true);
  assert.equal(result.verdict.outcome, 'deny');
  assert.ok(result.verdict.hardBlocks.some((b) => b.rule === 'stoploss.attempt_cap'));
});

test('止损：次数未到、进展尚可 → 继续', async () => {
  const { kernel } = setup({ progress: 4 });
  const result = await forkStopLoss(kernel, {
    sessionId: 's1',
    taskId: 't1',
    attempts: 1,
    maxAttempts: 3,
    consecutiveFailures: 0,
    stateSummary: '',
  });
  assert.equal(result.stop, false);
});

test('验收：四项清单缺项时，模型说了也不算', async () => {
  const { kernel } = setup({ acceptance_criteria_met: 0.99 });
  const result = await forkAcceptance(kernel, {
    sessionId: 's1',
    taskId: 't1',
    claimant: 'bot/writer',
    claim: '完成了',
    evidence: [{ id: 'ev1', producedBy: 'bot/writer', verified: false }],
    stateSummary: '',
  });
  assert.equal(result.accepted, false);
  assert.deepEqual(result.missing.sort(), ['交付物及位置', '独立核验记录', '遗留问题声明'].sort());
  assert.ok(result.verdict.hardBlocks.some((b) => b.rule === 'acceptance.checklist'));
});

test('验收：自产自验被识破', async () => {
  const { kernel } = setup({ acceptance_criteria_met: 0.99 });
  const result = await forkAcceptance(kernel, {
    sessionId: 's1',
    taskId: 't1',
    claimant: 'bot/writer',
    claim: '完成了',
    deliverableUri: 'out/report.md',
    leftoverIssues: '',
    evidence: [{ id: 'ev1', producedBy: 'bot/writer', verified: true }],
    stateSummary: '',
  });
  assert.equal(result.accepted, false);
  assert.ok(result.verdict.hardBlocks.some((b) => b.rule === 'acceptance.self_verified'));
});

test('验收：清单齐全且有独立核验 → 通过', async () => {
  const { kernel } = setup({ acceptance_criteria_met: 0.9 });
  const result = await forkAcceptance(kernel, {
    sessionId: 's1',
    taskId: 't1',
    claimant: 'bot/writer',
    claim: '完成了',
    deliverableUri: 'out/report.md',
    leftoverIssues: '',
    evidence: [{ id: 'ev1', producedBy: 'bot/checker', verified: true }],
    stateSummary: '',
  });
  assert.equal(result.accepted, true);
  assert.deepEqual(result.missing, []);
});

test('升级：涉及金额直接 critical，压过模型分级', async () => {
  const { kernel } = setup({}, { risk_tier: 'routine' });
  const result = await forkEscalate(kernel, {
    sessionId: 's1',
    taskId: 't1',
    reason: '付款争议',
    moneyUsd: 500,
  });
  assert.equal(result.tier, 'critical');
});

function scriptedWorker(id: string, script: Array<Partial<WorkerOutput>>): VigilWorker {
  return {
    id,
    role: '测试工人',
    async run({ attempt }) {
      const out = script[Math.min(attempt, script.length) - 1]!;
      return {
        summary: out.summary ?? id,
        claim: out.claim ?? '完成',
        evidence: out.evidence ?? [],
        deliverableUri: out.deliverableUri,
        leftoverIssues: out.leftoverIssues,
        costUsd: 0.01,
      };
    },
  };
}

test('编排：退回后带反馈重做，最终完成', async () => {
  const { kernel, ledger } = setup(
    { quality_sufficient: 0.9, acceptance_criteria_met: 0.9, progress: 4 },
    { next_worker: 'bot/writer' },
  );
  const company = new Orchestrator(kernel);
  const worker = scriptedWorker('bot/writer', [
    { summary: '初稿', evidence: [{ id: 'e1', producedBy: 'bot/writer' }] },
    {
      summary: '定稿',
      deliverableUri: 'out/report.md',
      leftoverIssues: '',
      evidence: [{ id: 'e2', producedBy: 'bot/checker', verified: true }],
    },
  ]);
  const report = await company.runTask('s1', 't1', '写报告', [worker]);
  assert.equal(report.status, 'completed');
  assert.equal(report.attempts, 2);
  // 每个岔路都是账本里的记录，监督过程 = 账本本身
  const intents = ledger.bySession('s1').map((r) => r.intent);
  assert.ok(intents.some((i) => i.startsWith('路由')));
  assert.ok(intents.some((i) => i.startsWith('质量门')));
  assert.ok(intents.some((i) => i.startsWith('验收')));
  assert.ok(intents.some((i) => i.startsWith('止损判断')));
  assert.ok(intents.some((i) => i.startsWith('执行任务')));
  assert.ok(ledger.verify().ok);
});

test('编排：反复虚假完成 → 止损停止烧钱', async () => {
  const { kernel } = setup(
    { quality_sufficient: 0.9, acceptance_criteria_met: 0.9, progress: 4 },
    { next_worker: 'bot/writer' },
  );
  const company = new Orchestrator(kernel, { maxAttempts: 3, failureThreshold: 2 });
  const liar = scriptedWorker('bot/writer', [
    { summary: '快好了', evidence: [{ id: 'e1', producedBy: 'bot/writer' }] },
  ]);
  const report = await company.runTask('s1', 't1', '不可能的任务', [liar]);
  assert.equal(report.status, 'stopped');
  assert.ok(report.reason.includes('止损'));
});

test('编排：路由失常 → 升级人工', async () => {
  const { kernel } = setup({}, { next_worker: 'bot/ghost' });
  const company = new Orchestrator(kernel);
  const worker = scriptedWorker('bot/writer', [{ summary: 'x' }]);
  const report = await company.runTask('s1', 't1', '写报告', [worker]);
  assert.equal(report.status, 'escalated');
  assert.ok(report.escalatedTo);
});
