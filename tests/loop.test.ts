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

/**
 * 与 cli.ts 中真实循环一致的配置：决策循环里金钱动作的授权由"确认闸门"接管，
 * 因此内核单笔金额上限在此放开到极大（与生产一致），避免自主花费护栏误杀本应交付人工确认的高额决策。
 */
function loopKernel() {
  return new Kernel({
    ledger: new Ledger(':memory:'),
    judge: new MockJudge({ fixed: { proceed: 0.9 }, latencyMs: 0 }),
    policy: defaultPolicy({ moneyCapPerAction: Number.MAX_SAFE_INTEGER }),
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
  // 用低金额上限内核制造一次真实的"内核否决"（生产循环内核放开上限，此处专属复现 deny）
  const denyKernel = new Kernel({
    ledger: new Ledger(':memory:'),
    judge: new MockJudge({ fixed: { proceed: 0.9 }, latencyMs: 0 }),
    policy: defaultPolicy({ moneyCapPerAction: 1000 }),
  });
  const goal = gatedGoal({
    action: { kind: 'take_loan', target: '超额贷款', reversible: false, external: true, moneyUsd: 5000 },
  });
  const loop = new DecisionLoop(denyKernel, goal, dir);
  const first = await loop.run();
  assert.equal(first.status, 'completed');
  assert.equal(first.outcome, 'deny');
  const id = loop.loopId;
  // 即使误调用 --resume --confirm，也必须拒绝执行
  const state = loadLoopState(dir, id)!;
  const resumed = new DecisionLoop(denyKernel, state.goal, dir, id);
  const final = await resumed.resume(true);
  assert.equal(final.status, 'completed');
  assert.equal(final.outcome, 'deny');
});

test('决策领域：invest 注册并强制其必备证据维度（权威/监管/财务/风险/专家/替代）', () => {
  const spec = resolveDomainSpec('invest');
  for (const dim of ['authoritative', 'regulatory', 'financial', 'risk', 'expert', 'alternative']) {
    assert.ok(spec.required.includes(dim as never), `invest 应要求 ${dim}`);
  }
  assert.ok(spec.excludeHint?.includes('market'), 'invest 应排除卖方推销 market 维度');
  // 缺任一必备维度即 incomplete
  const partial = [
    { channel: 'authoritative', source: '美联储', verified: true },
    { channel: 'regulatory', source: '外汇管制', verified: true },
    { channel: 'financial', source: '收益率', verified: true },
    { channel: 'risk', source: '波动', verified: true },
    { channel: 'expert', source: '资管建议', verified: true },
  ] as ChannelEvidence[];
  assert.equal(checkCompleteness(partial, spec, { requireVerified: true }).complete, false);
});

test('决策循环：invest 领域目标跑通 证据门→仲裁→确认闸门→闭环执行(plan 输出)', async () => {
  const dir = tmp();
  const INVEST = resolveDomainSpec('invest');
  const goal: LoopGoal = {
    sessionId: 'invest-200k-test',
    question: '是否按股50%/债20%/黄金10%/BTC5%/现金15%配置 $200K',
    action: {
      kind: 'allocate_invest_lump_sum',
      target: '全球分散配置 $200,000',
      reversible: false,
      external: true,
      moneyUsd: 200000,
    },
    positions: [
      { actor: 'core', conclusion: 'allow', authority: 1, reason: '分散配置可执行' },
      { actor: 'risk', conclusion: 'require_human', authority: 2, reason: '跨境合规待确认' },
    ],
    evidence: [
      { channel: 'authoritative', source: '美联储利率 3.75-4.00%', verified: true },
      { channel: 'regulatory', source: 'QDII/港股通合规通道', verified: true },
      { channel: 'financial', source: '10Y 收益率 ~5.10%', verified: true },
      { channel: 'risk', source: '标普波动 12-15%', verified: true },
      { channel: 'expert', source: '资管分散配置建议', verified: true },
      { channel: 'alternative', source: '股/债/黄金/现金横向对比', verified: true },
    ],
    evidenceSpec: INVEST,
    costUsd: 200000,
    plan: [
      '核对资金通道（境外账户直投 / 国内走 QDII）',
      '建仓：先债+现金，再股，后黄金与 BTC 卫星仓',
      '留存凭证并按 20% 申报境外所得',
    ],
  };
  const loop = new DecisionLoop(loopKernel(), goal, dir);
  const events: LoopEvent[] = [];
  loop.on((e) => events.push(e));
  const first = await loop.run();
  assert.equal(first.status, 'awaiting_confirmation');
  // 闭环执行时应当输出 plan 中的步骤
  const id = loop.loopId;
  const state = loadLoopState(dir, id)!;
  const resumed = new DecisionLoop(loopKernel(), state.goal, dir, id);
  const finalEvents: LoopEvent[] = [];
  resumed.on((e) => finalEvents.push(e));
  await resumed.resume(true);
  assert.ok(
    finalEvents.some((e) => e.stage === 'executing' && String(e.message).includes('核对资金通道')),
    '闭环执行应输出 goal.plan 中的配置步骤',
  );
});

test('monitorCycle：重新采集/重建简报，并能在决策依据变化时主动 alert', async () => {
  const dir = tmp();
  const captured: LoopEvent[] = [];
  const notifier = {
    id: 'spy',
    notify: async (e: LoopEvent): Promise<void> => {
      captured.push(e);
    },
  };
  const mk = (
    option: string,
    dimension: 'authoritative' | 'expert' | 'regulatory' | 'financial' | 'alternative' | 'risk',
    note: string,
  ): ChannelEvidence => ({
    dimension,
    channel: `${dimension}-${option}`,
    source: 'unit-test',
    verified: true,
    option,
    note,
  });
  const goal: LoopGoal = {
    sessionId: 'sess-monitor',
    question: '本科升学：专升本 vs 竞赛免试',
    action: { kind: 'decide', actor: 'user', type: 'generic_decision', target: 'x', reversible: true, external: false },
    positions: [{ actor: 'vigil', authority: 1, conclusion: 'allow', reason: 'r' }],
    evidenceSpec: 'education',
    domain: 'education',
    evidence: [
      mk('专升本', 'authoritative', '统考入学'), mk('专升本', 'expert', '稳定'), mk('专升本', 'regulatory', '全日制本科'),
      mk('专升本', 'financial', '成本低'), mk('专升本', 'alternative', '自考兜底'), mk('专升本', 'risk', '需备考时间投入'),
      mk('竞赛', 'authoritative', '获奖免试'), mk('竞赛', 'expert', '淘汰率高'), mk('竞赛', 'regulatory', '名额有限'),
      mk('竞赛', 'financial', '成本高'), mk('竞赛', 'alternative', '直接就业'), mk('竞赛', 'risk', '需持续备赛'),
    ],
  };
  const loop = new DecisionLoop(loopKernel(), goal, dir, undefined, notifier as never);

  const b1 = await loop.monitorCycle();
  assert.equal(b1?.kind, 'matrix');
  // 初始：两方案均 100% 且无红牌 → 并列，无推荐
  assert.equal(b1?.recommendedOption, undefined);

  // 引入变化：给「竞赛」加真实红牌 → 推荐应变为「专升本」
  goal.evidence.forEach((e) => {
    if (e.option === '竞赛' && e.dimension === 'risk') e.note = '红牌：获奖率极低、政策收紧';
  });
  captured.length = 0;
  const b2 = await loop.monitorCycle();
  assert.equal(b2?.recommendedOption, '专升本');

  // 决策依据变化应触发一条 level=alert 的 monitor 事件（主动推送）
  const alerts = captured.filter((e) => e.stage === 'monitor' && e.level === 'alert');
  assert.ok(alerts.length >= 1, '应针对推荐变化发出 alert 事件');
  assert.ok(alerts[0].message.includes('专升本'));
});
