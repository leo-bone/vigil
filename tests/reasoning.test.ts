import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildBrief, type AllocationSlice } from '../src/loop/reasoning.ts';
import type { ChannelEvidence } from '../src/loop/evidence.ts';

function ev(partial: Partial<ChannelEvidence> & { channel: string }): ChannelEvidence {
  return {
    dimension: 'financial',
    source: 'unit-test',
    verified: true,
    ...partial,
  } as ChannelEvidence;
}

/** 构造一份"全部实时信号都在"的 invest 证据 */
function fullInvestEvidence(): ChannelEvidence[] {
  return [
    ev({ channel: 'fx-usd-cny', value: 6.67, unit: 'USD/CNY', capturedAt: '2026-10-28T15:00:00Z' }),
    ev({ channel: 'gold-xau', value: 4045, unit: 'USD/oz', capturedAt: '2026-10-28T15:00:01Z' }),
    ev({ channel: 'silver-xag', value: 53.9, unit: 'USD/oz', capturedAt: '2026-10-28T15:00:02Z' }),
    ev({ channel: 'us10y', value: 4.99, unit: '%', capturedAt: '2026-10-28T15:00:03Z' }),
    ev({ channel: 'crypto-btc', value: 82000, unit: 'USD', capturedAt: '2026-10-28T15:00:04Z' }),
    ev({ channel: 'sp500', value: 7750, unit: 'pts', capturedAt: '2026-10-28T15:00:05Z' }),
  ];
}

function findSlice(slices: AllocationSlice[], code: string): AllocationSlice | undefined {
  return slices.find((s) => s.code === code);
}

test('invest 全信号：配置合计 100%，置信度 high，无缺失警示', () => {
  const brief = buildBrief('invest', '配置20万美金', fullInvestEvidence());
  assert.equal(brief.kind, 'allocation');
  assert.equal(brief.totalWeightPct, 100);
  assert.equal(brief.confidence, 'high');
  assert.equal(brief.caveats.length, 0);
  // 实时 10Y=4.99% ≥ 4.5% → 债券 35%
  assert.equal(findSlice(brief.allocation, 'US_TREASURY_10Y')?.weightPct, 35);
  // 标普实时 → 权益 30%
  assert.equal(findSlice(brief.allocation, 'EQUITY_SP500')?.weightPct, 30);
  // BTC 实时 → 卫星仓 5%
  assert.ok(findSlice(brief.allocation, 'BTC'));
  // 现金补足到 100（35+30+15+5+5=90 → 10）
  assert.equal(findSlice(brief.allocation, 'CASH_USD')?.weightPct, 10);
});

test('债券权重随实时 10Y 收益率变化', () => {
  const base = fullInvestEvidence();
  // 高收益率
  const high = base.map((e) => (e.channel === 'us10y' ? { ...e, value: 5.2 } : e));
  assert.equal(findSlice(buildBrief('invest', 'q', high).allocation, 'US_TREASURY_10Y')?.weightPct, 35);
  // 低收益率
  const low = base.map((e) => (e.channel === 'us10y' ? { ...e, value: 2.8 } : e));
  assert.equal(findSlice(buildBrief('invest', 'q', low).allocation, 'US_TREASURY_10Y')?.weightPct, 15);
  // 缺失 10Y → 中性 25% 且带警示
  const missing = base.filter((e) => e.channel !== 'us10y');
  const b = buildBrief('invest', 'q', missing);
  assert.equal(findSlice(b.allocation, 'US_TREASURY_10Y')?.weightPct, 25);
  assert.ok(b.caveats.some((c) => c.includes('10Y')));
});

test('缺失标普/加密行情：仓位下调并诚实警示，绝不编造', () => {
  const noSp = fullInvestEvidence().filter((e) => e.channel !== 'sp500');
  const b1 = buildBrief('invest', 'q', noSp);
  assert.equal(findSlice(b1.allocation, 'EQUITY_SP500')?.weightPct, 20);
  assert.ok(b1.caveats.some((c) => c.includes('标普')));

  const noBtc = fullInvestEvidence().filter((e) => e.channel !== 'crypto-btc');
  const b2 = buildBrief('invest', 'q', noBtc);
  assert.equal(findSlice(b2.allocation, 'BTC'), undefined);
  assert.ok(b2.caveats.some((c) => c.includes('加密')));
});

test('配置理由引用实时数值与时间戳', () => {
  const brief = buildBrief('invest', 'q', fullInvestEvidence());
  const bond = findSlice(brief.allocation, 'US_TREASURY_10Y');
  assert.ok(bond?.rationale.includes('4.99%'));
  assert.ok(bond?.rationale.includes('2026-10-28T15:00'));
  const gold = findSlice(brief.allocation, 'GOLD');
  assert.ok(gold?.rationale.includes('$4045'));
});

test('置信度随实时信号数分级', () => {
  const two = fullInvestEvidence().filter((e) => ['fx-usd-cny', 'us10y'].includes(e.channel));
  assert.equal(buildBrief('invest', 'q', two).confidence, 'low');
  const four = fullInvestEvidence().filter((e) => ['fx-usd-cny', 'gold-xau', 'us10y', 'sp500'].includes(e.channel));
  assert.equal(buildBrief('invest', 'q', four).confidence, 'medium');
});

test('非金融领域返回 generic 简报，不编造配置', () => {
  const evidence = [
    ev({ dimension: 'authoritative', channel: 'auth', note: '官方指南 X' }),
    ev({ dimension: 'risk', channel: 'risk', note: '风险 Y' }),
  ];
  const brief = buildBrief('medical', '就医方案', evidence);
  assert.equal(brief.kind, 'generic');
  assert.equal(brief.allocation.length, 0);
  assert.ok(brief.signalSummary.includes('官方指南 X'));
});

test('financing 领域复用投资配置逻辑', () => {
  const brief = buildBrief('financing', '理财配置', fullInvestEvidence());
  assert.equal(brief.kind, 'allocation');
  assert.equal(brief.totalWeightPct, 100);
});
