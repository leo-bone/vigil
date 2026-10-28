import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Kernel } from '../src/kernel.ts';
import { Ledger } from '../src/ledger/store.ts';
import { MockJudge } from '../src/judge/mock.ts';
import { defaultPolicy } from '../src/policy/rules.ts';
import {
  checkCompleteness,
  resolveDomainSpec,
  listDomains,
  type ChannelEvidence,
} from '../src/loop/evidence.ts';
import { LoopEventBus, loadEventLog, type LoopEvent } from '../src/loop/events.ts';
import {
  DecisionLoop,
  loadLoopState,
  type LoopGoal,
  type DecisionLoopState,
} from '../src/loop/decisionLoop.ts';

const tmp = (): string => mkdtempSync(join(tmpdir(), 'vigil-loop-'));

/** 与 cli.ts 中真实循环一致的配置：抬高金钱上限，让"补贴后压线成交"不被内核红线误杀 */
function loopKernel() {
  return new Kernel({
    ledger: new Ledger(':memory:'),
    judge: new MockJudge({ fixed: { proceed: 0.9 }, latencyMs: 0 }),
    policy: defaultPolicy({ moneyCapPerAction: 1000 }),
  });
}

const PURCHASE = resolveDomainSpec('purchase');

/** 用通用证据维度表达的"买 MacBook Neo"全证据（覆盖 purchase 领域 6 个必备维度） */
const FULL_EVIDENCE: ChannelEvidence[] = [
  { channel: 'authoritative', source: 'Apple 官网 4599', priceRMB: 4599, verified: true },
  { channel: 'market', source: '天猫 4599 / 线下 4030 比价', priceRMB: 4030, verified: true },
  { channel: 'regulatory', source: '国补15% 3909 + 学生补贴 4030', priceRMB: 3909, verified: true },
  { channel: 'financial', source: '以旧换新净价 2899', priceRMB: 2899, verified: true },
  { channel: 'alternative', source: '对比 MacBook Air M5 16GB', verified: true },
  { channel: 'peer', source: '用户/社群反馈：续航与保值', verified: true },
];

function gatedGoal(overrides: Partial<LoopGoal> = {}): LoopGoal {
  return {
    sessionId: 'buy-neo-test',
    question: '是否购买 MacBook Neo（办公，预算 4000）',
    action: {
      kind: 'purchase_laptop',
      target: 'MacBook Neo 13 A18 Pro 8GB 256GB',
      reversible: false,
      external: true,
      moneyUsd: 563,
    },
    positions: [
      {
        actor: 'user-desire',
        conclusion: 'allow',
        authority: 1,
        reason: '办公负载轻量，8GB 足够',
      },
      {
        actor: 'budget-guard',
        conclusion: 'allow',
        authority: 2,
        reason: '补贴后压线 ≤4000',
      },
    ],
    evidence: FULL_EVIDENCE,
    evidenceSpec: PURCHASE,
    ...overrides,
  };
}

test('领域注册表：覆盖了衣食住行与工作/购物/旅行/融资/医疗/教育等通用领域', () => {
  const domains = listDomains();
  const keys = domains.map((d) => d.key);
  for (const k of ['purchase', 'medical', 'education', 'travel', 'financing', 'work', 'housing']) {
    assert.ok(keys.includes(k), `应注册领域 ${k}`);
  }
  // 每个领域都声明了必备证据维度
  for (const d of domains) assert.ok(d.required.length > 0, `${d.key} 应有必备维度`);
});

test('证据完整性：全维度覆盖判定为 complete', () => {
  const r = checkCompleteness(FULL_EVIDENCE, PURCHASE);
  assert.equal(r.complete, true);
  assert.deepEqual(r.missing, []);
});

test('证据完整性：缺维度则判定 incomplete 并报告缺哪类（修复首轮漏国补翻车）', () => {
  const partial = FULL_EVIDENCE.filter((e) => e.channel !== 'regulatory');
  const r = checkCompleteness(partial, PURCHASE);
  assert.equal(r.complete, false);
  assert.deepEqual(r.missing, ['regulatory']);
});

test('证据完整性：覆盖但没核验 → requireVerified 下仍判 incomplete（强制"真实"）', () => {
  const unverified = FULL_EVIDENCE.map((e) =>
    e.channel === 'regulatory' ? { ...e, verified: false } : e,
  );
  const r = checkCompleteness(unverified, PURCHASE, { requireVerified: true });
  assert.equal(r.complete, false);
  assert.deepEqual(r.missing, ['regulatory']);
});

test('事件总线：emit 既推送给订阅者又落盘，loadEventLog 可回看', () => {
  const dir = tmp();
  const bus = new LoopEventBus('lp_test', { logPath: join(dir, 'events-lp_test.jsonl') });
  const seen: LoopEvent[] = [];
  bus.on((e) => seen.push(e));
  bus.emit('goal_received', 'info', '目标接收');
  bus.emit('gate', 'gate', '确认闸门');
  assert.equal(seen.length, 2);
  const log = loadEventLog(join(dir, 'events-lp_test.jsonl'));
  assert.equal(log.length, 2);
  assert.equal(log[0]!.stage, 'goal_received');
  assert.equal(log[1]!.level, 'gate');
});

test('决策循环：证据齐全 + 对外不可逆动作 → 触发确认闸门（awaiting_confirmation）', async () => {
  const dir = tmp();
  const loop = new DecisionLoop(loopKernel(), gatedGoal(), dir);
  const events: LoopEvent[] = [];
  loop.on((e) => events.push(e));
  const final = await loop.run();
  assert.equal(final.status, 'awaiting_confirmation');
  assert.ok(events.some((e) => e.stage === 'gate'), '应发射确认闸门事件');
  assert.ok(events.some((e) => e.stage === 'evidence_complete'), '应发射证据完整放行事件');
  // 状态已落盘，可被 --resume 重新加载
  assert.ok(existsSync(join(dir, `loop-${loop.loopId}.json`)));
});

test('决策循环：证据不全 → 阻塞（blocked），绝不进入裁决或闸门（这正是上一轮翻车的根因）', async () => {
  const dir = tmp();
  const goal = gatedGoal({
    evidence: FULL_EVIDENCE.filter((e) => e.channel !== 'regulatory'),
  });
  const loop = new DecisionLoop(loopKernel(), goal, dir);
  const events: LoopEvent[] = [];
  loop.on((e) => events.push(e));
  const final = await loop.run();
  assert.equal(final.status, 'blocked');
  assert.ok(events.some((e) => e.stage === 'evidence_gap'), '应发射证据缺口告警');
  assert.ok(!events.some((e) => e.stage === 'decision'), '缺口存在时不得裁决');
  assert.ok(!events.some((e) => e.stage === 'gate'), '缺口存在时不得开闸门');
});

test('决策循环：必备维度没核验 → 仍阻塞（强制真实完整，不只是"有"）', async () => {
  const dir = tmp();
  const goal = gatedGoal({
    evidence: FULL_EVIDENCE.map((e) =>
      e.channel === 'regulatory' ? { ...e, verified: false } : e,
    ),
  });
  const loop = new DecisionLoop(loopKernel(), goal, dir);
  const events: LoopEvent[] = [];
  loop.on((e) => events.push(e));
  const final = await loop.run();
  assert.equal(final.status, 'blocked');
  assert.ok(events.some((e) => e.stage === 'evidence_gap'));
});

test('决策循环：确认闸门挂起后，--resume --confirm 才闭环执行到 completed', async () => {
  const dir = tmp();
  const loop = new DecisionLoop(loopKernel(), gatedGoal(), dir);
  const first = await loop.run();
  assert.equal(first.status, 'awaiting_confirmation');
  const id = loop.loopId;

  // 从磁盘恢复（与 cli 的 --resume 路径一致）
  const state: DecisionLoopState | null = loadLoopState(dir, id);
  assert.ok(state, '应能加载已挂起的循环状态');
  const resumed = new DecisionLoop(loopKernel(), state!.goal, dir, id);
  const final = await resumed.resume(true);
  assert.equal(final.status, 'completed');
});

test('决策循环：确认闸门挂起后，未确认（--resume 不带 --confirm）保持挂起，不执行', async () => {
  const dir = tmp();
  const loop = new DecisionLoop(loopKernel(), gatedGoal(), dir);
  await loop.run();
  const id = loop.loopId;
  const state = loadLoopState(dir, id)!;
  const resumed = new DecisionLoop(loopKernel(), state.goal, dir, id);
  const final = await resumed.resume(false);
  assert.equal(final.status, 'awaiting_confirmation');
});

test('决策循环：autoConfirm=true 时无需人工闸门，run 直接闭环到 completed', async () => {
  const dir = tmp();
  const loop = new DecisionLoop(loopKernel(), gatedGoal({ autoConfirm: true }), dir);
  const final = await loop.run();
  assert.equal(final.status, 'completed');
});

test('决策循环：非对外或非不可逆动作不触发确认闸门（自动放行路径）', async () => {
  const dir = tmp();
  const loop = new DecisionLoop(
    loopKernel(),
    gatedGoal({
      action: {
        kind: 'draft_plan',
        target: '购买方案草稿',
        reversible: true,
        external: false,
      },
    }),
    dir,
  );
  const events: LoopEvent[] = [];
  loop.on((e) => events.push(e));
  const final = await loop.run();
  assert.equal(final.status, 'completed');
  assert.ok(!events.some((e) => e.stage === 'gate'), '可逆/非对外动作不应开闸门');
});

test('决策循环：已被否决（deny）的循环，--resume --confirm 也绝不会执行', async () => {
  const dir = tmp();
  // 动作金额超过循环内核的 per-action 上限 → 内核硬规则否决
  const goal = gatedGoal({
    action: { kind: 'take_loan', target: '超额贷款', reversible: false, external: true, moneyUsd: 5000 },
  });
  const loop = new DecisionLoop(loopKernel(), goal, dir);
  const first = await loop.run();
  assert.equal(first.status, 'completed');
  assert.equal(first.outcome, 'deny');
  const id = loop.loopId;
  // 即使误调用 --resume --confirm，也必须拒绝执行
  const state = loadLoopState(dir, id)!;
  const resumed = new DecisionLoop(loopKernel(), state.goal, dir, id);
  const final = await resumed.resume(true);
  assert.equal(final.status, 'completed');
  assert.equal(final.outcome, 'deny');
});
