import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Kernel } from '../src/kernel.ts';
import { Ledger } from '../src/ledger/store.ts';
import { MockJudge } from '../src/judge/mock.ts';
import { defaultPolicy } from '../src/policy/rules.ts';
import { resolveDomainSpec, type ChannelEvidence } from '../src/loop/evidence.ts';
import { LoopEventBus } from '../src/loop/events.ts';
import { DecisionLoop, type LoopGoal } from '../src/loop/decisionLoop.ts';
import {
  gatherEvidence,
  GoldSource,
  SilverSource,
  TreasuryYieldSource,
  CryptoSource,
  StockIndexSource,
  extendedSources,
  defaultSources,
  type EvidenceSource,
} from '../src/loop/evidenceProvider.ts';
import {
  WeComNotifier,
  WebhookNotifier,
  EmailNotifier,
  MultiNotifier,
  buildNotifiers,
} from '../src/loop/notifier.ts';
import {
  DryRunExecutor,
  WebhookExecutor,
  buildExecutor,
} from '../src/loop/executor.ts';

const tmp = (): string => mkdtempSync(join(tmpdir(), 'vigil-sys-'));

function loopKernel() {
  return new Kernel({
    ledger: new Ledger(':memory:'),
    judge: new MockJudge({ fixed: { proceed: 0.9 }, latencyMs: 0 }),
    policy: defaultPolicy({ moneyCapPerAction: Number.MAX_SAFE_INTEGER }),
  });
}

/** 统一 mock fetch：既支持 .json() 也支持 .text()，并记录本次调用 */
function mockFetch(handler: (url: string, opts: unknown) => unknown) {
  const real = globalThis.fetch;
  const calls: Array<{ url: string; opts: unknown }> = [];
  globalThis.fetch = (async (url: string | URL | Request, opts?: unknown) => {
    calls.push({ url: String(url), opts });
    const payload = handler(String(url), opts);
    const body = typeof payload === 'string' ? payload : JSON.stringify(payload);
    return {
      ok: true,
      status: 200,
      json: async () => (typeof payload === 'string' ? JSON.parse(payload) : payload),
      text: async () => body,
    } as Response;
  }) as typeof globalThis.fetch;
  return { calls, restore: () => (globalThis.fetch = real) };
}

const INVEST = resolveDomainSpec('invest');

// ---------------------------------------------------------------------------
// 1. 真实数据源：能机读的维度实时抓取并附时间戳；抓不到诚实降级
// ---------------------------------------------------------------------------

test('实时源：黄金 XAU 实时抓取，返回已核验证据与抓取时间', async () => {
  const m = mockFetch(() => ({ price: 4045.2, updatedAt: '2026-10-28T00:00:00Z' }));
  try {
    const ev = await new GoldSource().fetch({ dimension: 'financial', domain: 'invest', question: 'q' });
    assert.equal(ev.dimension, 'financial');
    assert.equal(ev.channel, 'gold-xau');
    assert.equal(ev.verified, true);
    assert.match(ev.note ?? '', /XAU/);
    assert.ok(ev.capturedAt);
  } finally {
    m.restore();
  }
});

test('实时源：白银 XAG / 10Y 国债 / 加密 / 股指 各自抓到对应数据', async () => {
  const m = mockFetch((url) => {
    if (url.includes('XAG')) return { price: 53.8, updatedAt: '2026-10-28T00:00:00Z' };
    if (url.includes('TREASURY_YIELD')) return { data: [{ date: '2026-09-01', value: '4.99' }] };
    if (url.includes('coingecko')) return { bitcoin: { usd: 80800 }, ethereum: { usd: 2900 } };
    if (url.includes('stooq')) return 'Date,Close,Open\n2026-10-28,5764.32,5750.10\n';
    return {};
  });
  try {
    const silver = await new SilverSource().fetch({ dimension: 'financial', domain: 'invest', question: 'q' });
    assert.equal(silver.channel, 'silver-xag');
    assert.ok(silver.verified);
    const treasury = await new TreasuryYieldSource().fetch({ dimension: 'financial', domain: 'invest', question: 'q' });
    assert.equal(treasury.channel, 'us10y');
    assert.match(treasury.note ?? '', /4\.99/);
    const crypto = await new CryptoSource().fetch({ dimension: 'financial', domain: 'invest', question: 'q' });
    assert.equal(crypto.channel, 'crypto-btc');
    assert.match(crypto.note ?? '', /BTC/);
    const stock = await new StockIndexSource().fetch({ dimension: 'financial', domain: 'invest', question: 'q' });
    assert.equal(stock.channel, 'sp500');
    assert.match(stock.note ?? '', /S&P 500/);
  } finally {
    m.restore();
  }
});

test('实时源：抓取失败时不假核验，抛错交由采集层降级为未核验', async () => {
  const m = mockFetch(() => {
    throw new Error('boom');
  });
  try {
    await assert.rejects(() => new GoldSource().fetch({ dimension: 'financial', domain: 'invest', question: 'q' }));
  } finally {
    m.restore();
  }
});

test('gatherEvidence：同一维度可挂多路源，全部进入证据集', async () => {
  class SrcA implements EvidenceSource {
    id = 'a';
    serves = [{ domain: 'invest', dimension: 'financial', channel: 'a' }];
    async fetch() {
      return { dimension: 'financial', channel: 'a', source: 'a://x', verified: true, note: 'A' } as ChannelEvidence;
    }
  }
  class SrcB implements EvidenceSource {
    id = 'b';
    serves = [{ domain: 'invest', dimension: 'financial', channel: 'b' }];
    async fetch() {
      return { dimension: 'financial', channel: 'b', source: 'b://x', verified: true, note: 'B' } as ChannelEvidence;
    }
  }
  const res = await gatherEvidence(INVEST, 'q', 'invest', [new SrcA(), new SrcB()]);
  const fin = res.evidence.filter((e) => (e.dimension ?? e.channel) === 'financial');
  assert.equal(fin.length, 2);
  assert.deepEqual(res.gathered, ['financial']);
});

test('gatherEvidence：已核验的既有证据整维度沿用，不为该维度重复抓取（含实时源降级）', async () => {
  const existing: ChannelEvidence[] = [
    { dimension: 'financial', channel: 'fx-usd-cny', source: 'prior://fx', verified: true, note: 'prior' },
  ];
  let calls = 0;
  class Src implements EvidenceSource {
    id = 'live';
    serves = [{ domain: 'invest', dimension: 'financial', channel: 'fx-usd-cny' }];
    async fetch() {
      calls++;
      return { dimension: 'financial', channel: 'fx-usd-cny', source: 'live://fx', verified: true, note: 'live' } as ChannelEvidence;
    }
  }
  const res = await gatherEvidence(INVEST, 'q', 'invest', [new Src()], { existing });
  assert.equal(calls, 0, '既有已核验证据应被沿用，实时源不应被调用');
  assert.ok(res.evidence.some((e) => e.source === 'prior://fx'));
});

test('gatherEvidence：实时源失败时该维度诚实标记为未核验，不阻塞其他维度', async () => {
  class Failing implements EvidenceSource {
    id = 'fail';
    serves = [{ domain: 'invest', dimension: 'financial', channel: 'fx-usd-cny' }];
    async fetch() {
      throw new Error('network down');
    }
  }
  const res = await gatherEvidence(INVEST, 'q', 'invest', [new Failing()]);
  const fin = res.evidence.find((e) => (e.dimension ?? e.channel) === 'financial')!;
  assert.equal(fin.verified, false);
  assert.match(fin.note ?? '', /采集失败/);
  assert.ok(res.unverified.includes('financial'));
});

test('默认源与扩展源：沙箱可达（FX/黄金/白银/国债）纳入默认，加密/股指走扩展源', () => {
  const def = defaultSources();
  assert.ok(def.some((s) => s instanceof GoldSource));
  assert.ok(def.some((s) => s instanceof TreasuryYieldSource));
  assert.ok(!def.some((s) => s instanceof CryptoSource));
  const ext = extendedSources();
  assert.ok(ext.some((s) => s instanceof CryptoSource));
  assert.ok(ext.some((s) => s instanceof StockIndexSource));
});

// ---------------------------------------------------------------------------
// 2. 推送通道：把"实时知道"从拉变推
// ---------------------------------------------------------------------------

test('WeComNotifier：POST 企微 webhook，body 为文本消息', async () => {
  const m = mockFetch(() => ({ errcode: 0 }));
  try {
    const n = new WeComNotifier('https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=K');
    await n.notify({ ts: 't', loopId: 'l', stage: 'gate', level: 'gate', message: '请确认' });
    assert.equal(m.calls.length, 1);
    assert.match(m.calls[0].url, /qyapi\.weixin\.qq\.com/);
    const body = JSON.parse((m.calls[0].opts as { body: string }).body);
    assert.equal(body.msgtype, 'text');
    assert.match(body.text.content, /请确认/);
  } finally {
    m.restore();
  }
});

test('WebhookNotifier：把整个事件原样 POST 出去', async () => {
  const m = mockFetch(() => ({ ok: true }));
  try {
    const n = new WebhookNotifier('https://hooks.example.com/x');
    const ev = { ts: 't', loopId: 'l', stage: 'decision' as const, level: 'info' as const, message: '裁决 allow' };
    await n.notify(ev);
    assert.equal(m.calls.length, 1);
    const body = JSON.parse((m.calls[0].opts as { body: string }).body);
    assert.equal(body.event.message, '裁决 allow');
  } finally {
    m.restore();
  }
});

test('EmailNotifier：按邮件 API 形态 POST，带鉴权头', async () => {
  const m = mockFetch(() => ({ id: 'm1' }));
  try {
    const n = new EmailNotifier({
      endpoint: 'https://api.resend.com/emails',
      apiKey: 're_xxx',
      from: 'vigil@x.com',
      to: 'u@x.com',
    });
    await n.notify({ ts: 't', loopId: 'l', stage: 'gate', level: 'gate', message: '请确认下单' });
    assert.equal(m.calls.length, 1);
    const opts = m.calls[0].opts as { headers: Record<string, string>; body: string };
    assert.match(opts.headers['Authorization'], /Bearer re_xxx/);
    const body = JSON.parse(opts.body);
    assert.equal(body.from, 'vigil@x.com');
    assert.equal(body.to, 'u@x.com');
    assert.match(body.subject, /gate/);
  } finally {
    m.restore();
  }
});

test('MultiNotifier：一次事件扇出到所有通道', async () => {
  let a = 0;
  let b = 0;
  const na = { id: 'a', async notify() { a++; } } as never;
  const nb = { id: 'b', async notify() { b++; } } as never;
  await new MultiNotifier([na, nb]).notify({ ts: 't', loopId: 'l', stage: 'plan', level: 'info', message: 'm' });
  assert.equal(a, 1);
  assert.equal(b, 1);
});

test('LoopEventBus：emit 同时触发已配置 notifier（拉变推）', async () => {
  const events: string[] = [];
  const bus = new LoopEventBus('lp_test', {
    notifier: { id: 'cap', async notify(e) { events.push(e.message); } },
  });
  bus.emit('goal_received', 'info', '目标接收');
  bus.emit('gate', 'gate', '请确认');
  assert.deepEqual(events, ['目标接收', '请确认']);
});

test('buildNotifiers：按环境变量构建通道，未配置返回空', () => {
  const withWh = buildNotifiers({ VIGIL_NOTIFY_WEBHOOK: 'https://hooks.x/y' } as NodeJS.ProcessEnv);
  assert.equal(withWh.length, 1);
  assert.equal(withWh[0].id, 'webhook');
  const none = buildNotifiers({} as NodeJS.ProcessEnv);
  assert.equal(none.length, 0);
});

// ---------------------------------------------------------------------------
// 3. 真实执行适配器：保留确认闸门，deny/未确认绝不执行
// ---------------------------------------------------------------------------

test('DryRunExecutor：只留痕，不发生真实副作用', async () => {
  const m = mockFetch(() => ({}));
  try {
    const r = await new DryRunExecutor().execute({
      sessionId: 's',
      question: 'q',
      action: { kind: 'buy', reversible: false, external: true, moneyUsd: 100 },
      costUsd: 100,
    });
    assert.equal(r.ok, true);
    assert.match(r.detail, /dry-run/);
    assert.equal(m.calls.length, 0, 'dry-run 不应发起任何网络请求');
  } finally {
    m.restore();
  }
});

test('WebhookExecutor：确认后把动作 POST 到端点并返回外部引用', async () => {
  const m = mockFetch(() => ({ id: 'ord_123' }));
  try {
    const ex = new WebhookExecutor('https://broker.example.com/execute');
    const r = await ex.execute({
      sessionId: 's',
      question: 'q',
      action: { kind: 'allocate', target: 'VOO', reversible: false, external: true, moneyUsd: 200000 },
      costUsd: 200000,
    });
    assert.equal(m.calls.length, 1);
    assert.match(m.calls[0].url, /broker\.example\.com/);
    const body = JSON.parse((m.calls[0].opts as { body: string }).body);
    assert.equal(body.action.kind, 'allocate');
    assert.equal(body.costUsd, 200000);
    assert.equal(body.intent, 'vigil-confirmed-action');
    assert.equal(r.externalRef, 'ord_123');
  } finally {
    m.restore();
  }
});

test('buildExecutor：默认 dry-run；配置 webhook 后启用真实执行', () => {
  const dry = buildExecutor({} as NodeJS.ProcessEnv);
  assert.equal(dry.id, 'dry-run');
  const live = buildExecutor({ VIGIL_EXECUTOR_WEBHOOK: 'https://x/y' } as NodeJS.ProcessEnv);
  assert.equal(live.id, 'webhook');
});

test('集成：确认闸门生效——未确认不执行，确认后才触发执行适配器', async () => {
  const m = mockFetch(() => ({ id: 'ord_confirmed' }));
  const vigilDir = tmp();
  try {
    const goal: LoopGoal = {
      sessionId: 'integ-1',
      question: '配置 20 万美金（invest）',
      action: { kind: 'allocate', target: '全球组合', reversible: false, external: true, moneyUsd: 200000 },
      positions: [{ actor: 'a', conclusion: 'allow', authority: 1, reason: '分散配置' }],
      evidenceSpec: INVEST,
      evidence: [
        { dimension: 'authoritative', channel: 'authoritative', source: 's', verified: true, note: 'n' },
        { dimension: 'regulatory', channel: 'regulatory', source: 's', verified: true, note: 'n' },
        { dimension: 'financial', channel: 'fx-usd-cny', source: 's', verified: true, note: 'n' },
        { dimension: 'risk', channel: 'risk', source: 's', verified: true, note: 'n' },
        { dimension: 'expert', channel: 'expert', source: 's', verified: true, note: 'n' },
        { dimension: 'alternative', channel: 'alternative', source: 's', verified: true, note: 'n' },
      ],
      costUsd: 200000,
    };
    const executor = new WebhookExecutor('https://broker.example.com/execute');

    // 第一次 run：证据齐 → 仲裁 → 确认闸门挂起，绝不执行
    const loop1 = new DecisionLoop(loopKernel(), goal, vigilDir, undefined, undefined, executor);
    const r1 = await loop1.run();
    assert.equal(r1.status, 'awaiting_confirmation');
    assert.equal(m.calls.length, 0, '挂起阶段不应有任何真实执行');

    // 未确认恢复：保持挂起
    const loop2 = new DecisionLoop(loopKernel(), goal, vigilDir, loop1.loopId, undefined, executor);
    const r2 = await loop2.resume(false);
    assert.equal(r2.status, 'awaiting_confirmation');
    assert.equal(m.calls.length, 0, '未确认不应执行');

    // 确认恢复：解除闸门并真实触发执行适配器
    const loop3 = new DecisionLoop(loopKernel(), goal, vigilDir, loop1.loopId, undefined, executor);
    const r3 = await loop3.resume(true);
    assert.equal(r3.status, 'completed');
    assert.equal(m.calls.length, 1, '确认后必须触发一次真实执行');
    assert.equal(m.calls[0].url, 'https://broker.example.com/execute');
  } finally {
    m.restore();
  }
});

test('集成：证据驱动裁决——brief 进入循环状态并随确认后执行上下文传递', async () => {
  const m = mockFetch(() => ({ id: 'ord_brief' }));
  const vigilDir = tmp();
  try {
    const goal: LoopGoal = {
      sessionId: 'brief-1',
      question: '配置 20 万美金（invest）',
      action: { kind: 'allocate', target: '全球组合', reversible: false, external: true, moneyUsd: 200000 },
      positions: [{ actor: 'a', conclusion: 'allow', authority: 1, reason: '分散配置' }],
      evidenceSpec: INVEST,
      domain: 'invest',
      evidence: [
        { dimension: 'authoritative', channel: 'authoritative', source: 's', verified: true, note: 'n' },
        { dimension: 'regulatory', channel: 'regulatory', source: 's', verified: true, note: 'n' },
        { dimension: 'financial', channel: 'fx-usd-cny', source: 's', verified: true, value: 6.67, unit: 'USD/CNY', capturedAt: '2026-10-28T15:00:00Z' },
        { dimension: 'financial', channel: 'gold-xau', source: 's', verified: true, value: 4045, unit: 'USD/oz', capturedAt: '2026-10-28T15:00:00Z' },
        { dimension: 'financial', channel: 'silver-xag', source: 's', verified: true, value: 53.9, unit: 'USD/oz', capturedAt: '2026-10-28T15:00:00Z' },
        { dimension: 'financial', channel: 'us10y', source: 's', verified: true, value: 4.99, unit: '%', capturedAt: '2026-10-28T15:00:00Z' },
        { dimension: 'risk', channel: 'risk', source: 's', verified: true, note: 'n' },
        { dimension: 'expert', channel: 'expert', source: 's', verified: true, note: 'n' },
        { dimension: 'alternative', channel: 'alternative', source: 's', verified: true, note: 'n' },
      ],
      costUsd: 200000,
    };
    const executor = new WebhookExecutor('https://broker.example.com/execute');
    const loop1 = new DecisionLoop(loopKernel(), goal, vigilDir, undefined, undefined, executor);
    const r1 = await loop1.run();
    assert.equal(r1.status, 'awaiting_confirmation');
    assert.ok(r1.brief, 'brief 应进入循环状态');
    assert.equal(r1.brief?.kind, 'allocation');
    assert.equal(r1.brief?.totalWeightPct, 100);
    // 实时 10Y=4.99% ≥4.5 → 债券 35%
    const bond = r1.brief?.allocation.find((a) => a.code === 'US_TREASURY_10Y');
    assert.equal(bond?.weightPct, 35);

    // 确认后执行：WebhookExecutor 应把 decisionBrief 作为 payload 的一部分发到端点
    const loop3 = new DecisionLoop(loopKernel(), goal, vigilDir, loop1.loopId, undefined, executor);
    await loop3.resume(true);
    const body = JSON.parse((m.calls[0].opts as { body: string }).body);
    assert.ok(body.decisionBrief, '执行 payload 应携带 decisionBrief');
    assert.equal(body.decisionBrief.kind, 'allocation');
    assert.equal(body.decisionBrief.allocation.length, r1.brief?.allocation.length);
  } finally {
    m.restore();
  }
});
