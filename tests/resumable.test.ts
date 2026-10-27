import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Ledger } from '../src/ledger/store.ts';
import { MockJudge } from '../src/judge/mock.ts';
import {
  createPipelineKernel,
  Orchestrator,
  handleMcpRequest,
  ACCEPTANCE_REQUIREMENTS,
} from '../src/index.ts';
import type { Evidence, PipelineTurn } from '../src/index.ts';

const ROSTER = [
  { id: 'bot/writer', role: '写手' },
  { id: 'bot/checker', role: '复核' },
];

function setup() {
  const ledger = new Ledger(':memory:');
  const judge = new MockJudge({
    fixed: { quality_sufficient: 0.9, acceptance_criteria_met: 0.92, progress: 4 },
    choices: { next_worker: 'bot/writer' },
  });
  const kernel = createPipelineKernel(ledger, judge);
  const orchestrator = new Orchestrator(kernel);
  return { ledger, kernel, orchestrator };
}

const FULL_EVIDENCE: Evidence[] = [
  { id: 'ev_draft', producedBy: 'bot/writer', claim: '草稿已写', verified: false },
  { id: 'ev_check', producedBy: 'bot/checker', claim: '已核对价格', verified: true },
];

test('可续跑状态机：begin 给出派工指令和验收要求', async () => {
  const { orchestrator } = setup();
  const turn = await orchestrator.begin({
    sessionId: 's1',
    taskId: 't1',
    task: '写报价邮件',
    roster: ROSTER,
  });
  assert.equal(turn.kind, 'work');
  if (turn.kind !== 'work') return;
  assert.equal(turn.workerId, 'bot/writer');
  assert.equal(turn.attempt, 1);
  assert.deepEqual(turn.requirements, ACCEPTANCE_REQUIREMENTS);
  assert.ok(turn.instructions.includes('写报价邮件'));
});

test('可续跑状态机：验收缺项时重新派工，并把缺了什么说清楚', async () => {
  const { orchestrator } = setup();
  await orchestrator.begin({ sessionId: 's1', taskId: 't1', task: '写报价邮件', roster: ROSTER });

  const turn = await orchestrator.submit('t1', {
    summary: '写了草稿',
    claim: '已完成',
    evidence: [],
  });

  assert.equal(turn.kind, 'work');
  if (turn.kind !== 'work') return;
  assert.equal(turn.attempt, 2, '退回后应该算第二次尝试');
  assert.ok(turn.feedback?.includes('交付物及位置'));
  assert.ok(turn.feedback?.includes('独立核验记录'));
});

test('可续跑状态机：清单齐全 → completed，状态可查', async () => {
  const { orchestrator, ledger } = setup();
  await orchestrator.begin({ sessionId: 's1', taskId: 't1', task: '写报价邮件', roster: ROSTER });
  const turn = await orchestrator.submit('t1', {
    summary: '定稿并交付',
    claim: '报价邮件已写好',
    deliverableUri: 'drafts/quote.md',
    leftoverIssues: '',
    evidence: FULL_EVIDENCE,
  });
  assert.equal(turn.kind, 'completed');

  const state = orchestrator.state('t1');
  assert.equal(state?.status, 'completed');
  assert.equal(state?.attempts, 1);
  assert.ok(state?.steps.some((step) => step.startsWith('验收：通过')));
  assert.ok(ledger.verify().ok);
});

test('可续跑状态机：交回没有人等待的结果会被拒绝', async () => {
  const { orchestrator } = setup();
  await assert.rejects(
    () => orchestrator.submit('t-not-started', { summary: 'x', claim: 'y', evidence: [] }),
    /未知任务/,
  );
  await orchestrator.begin({ sessionId: 's1', taskId: 't1', task: 'x', roster: ROSTER });
  await orchestrator.submit('t1', {
    summary: 'ok',
    claim: 'ok',
    deliverableUri: 'a.md',
    leftoverIssues: '',
    evidence: FULL_EVIDENCE,
  });
  await assert.rejects(
    () => orchestrator.submit('t1', { summary: 'x', claim: 'y', evidence: [] }),
    /没有等待交付/,
  );
});

async function call(
  kernel: ReturnType<typeof createPipelineKernel>,
  orchestrator: Orchestrator,
  name: string,
  args: Record<string, unknown>,
): Promise<any> {
  const result = (await handleMcpRequest(
    'tools/call',
    { name, arguments: args },
    kernel,
    { orchestrator, pipelineKernel: kernel },
  )) as { content: Array<{ text: string }> };
  return JSON.parse(result.content[0]!.text);
}

test('MCP：统筹循环的三个工具都能用，且回路可跨调用跑完', async () => {
  const { kernel, orchestrator } = setup();

  const list = (await handleMcpRequest('tools/list', {}, kernel, { orchestrator })) as {
    tools: Array<{ name: string }>;
  };
  const names = list.tools.map((tool) => tool.name);
  assert.ok(names.includes('vigil_task_start'));
  assert.ok(names.includes('vigil_task_submit'));
  assert.ok(names.includes('vigil_task_status'));

  const started = await call(kernel, orchestrator, 'vigil_task_start', {
    task: '写报价邮件',
    roster: ROSTER,
    taskId: 'm1',
    sessionId: 's1',
  });
  assert.equal(started.turn.kind, 'work');
  assert.equal(started.turn.workerId, 'bot/writer');
  assert.equal(started.state.status, 'running');

  const rejected = await call(kernel, orchestrator, 'vigil_task_submit', {
    taskId: 'm1',
    summary: '草稿',
    claim: '完成了',
  });
  assert.equal(rejected.turn.kind, 'work');
  assert.equal(rejected.state.attempts, 2);

  const accepted = await call(kernel, orchestrator, 'vigil_task_submit', {
    taskId: 'm1',
    summary: '定稿并交付',
    claim: '报价邮件已写好',
    deliverableUri: 'drafts/quote.md',
    leftoverIssues: '',
    evidence: FULL_EVIDENCE,
  });
  assert.equal(accepted.turn.kind, 'completed');

  const status = await call(kernel, orchestrator, 'vigil_task_status', { taskId: 'm1' });
  assert.equal(status.status, 'completed');
  assert.equal(status.attempts, 2);
});

test('MCP：名册为空直接报错，不猜', async () => {
  const { kernel, orchestrator } = setup();
  await assert.rejects(
    () => call(kernel, orchestrator, 'vigil_task_start', { task: 'x', roster: [] }),
    /名册不能为空/,
  );
});

test('MCP：未知任务的状态查询要报错，而不是返回空壳', async () => {
  const { kernel, orchestrator } = setup();
  await assert.rejects(
    () => call(kernel, orchestrator, 'vigil_task_status', { taskId: 'nope' }),
    /未知任务/,
  );
});

test('可续跑状态机与进程内跑完整循环结论一致', async () => {
  const { orchestrator, kernel } = setup();
  const turn: PipelineTurn = await orchestrator.begin({
    sessionId: 's1',
    taskId: 't1',
    task: '写报价邮件',
    roster: ROSTER,
  });
  assert.equal(turn.kind, 'work');
  const records = kernel.ledger.bySession('s1');
  assert.ok(records.some((record) => record.intent.startsWith('路由')));
});
