import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildBrief, type AllocationSlice } from '../src/loop/reasoning.ts';
import { HttpSearchSource, SearchSource, NO_SEARCH } from '../src/loop/evidenceProvider.ts';
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

// ---- 非金融领域：多方案决策矩阵（证据按 option 分组）----

function dimEv(dimension: string, option: string, note = `${dimension} 证据`): ChannelEvidence {
  return ev({ dimension: dimension as never, option, note, verified: true });
}

test('教育领域：两方案证据完整度不同 → 推荐完整度更高者', () => {
  // education 必备维度：authoritative / expert / regulatory / financial / alternative / risk（6 个）
  const evidence: ChannelEvidence[] = [
    // 专升本：缺 risk 维度（5/6）
    dimEv('authoritative', '专升本'),
    dimEv('expert', '专升本'),
    dimEv('regulatory', '专升本'),
    dimEv('financial', '专升本'),
    dimEv('alternative', '专升本'),
    // 竞赛免试升本科：6/6 全
    dimEv('authoritative', '竞赛免试升本科'),
    dimEv('expert', '竞赛免试升本科'),
    dimEv('regulatory', '竞赛免试升本科'),
    dimEv('financial', '竞赛免试升本科'),
    dimEv('alternative', '竞赛免试升本科'),
    dimEv('risk', '竞赛免试升本科'),
  ];
  const brief = buildBrief('education', '升学路径', evidence);
  assert.equal(brief.kind, 'matrix');
  assert.equal(brief.options?.length, 2);
  // 专升本 5/6 = 0.833（缺 risk → 温和惩罚 0.15），竞赛 6/6 全（无风险红牌）→ 竞赛胜出
  assert.equal(brief.recommendedOption, '竞赛免试升本科');
  const comp = brief.options?.find((o) => o.option === '竞赛免试升本科');
  assert.equal(comp?.coverage, 1);
  const ben = brief.options?.find((o) => o.option === '专升本');
  assert.equal(ben?.coverage, 5 / 6);
  assert.ok(brief.caveats.some((c) => c.includes('专升本') && c.includes('风险维度未评估')));
});

test('决策矩阵：有风险红牌的方案被降权', () => {
  const evidence: ChannelEvidence[] = [
    // A：6/6 全，但有风险红牌
    dimEv('authoritative', 'A'),
    dimEv('expert', 'A'),
    dimEv('regulatory', 'A'),
    dimEv('financial', 'A'),
    dimEv('alternative', 'A'),
    dimEv('risk', 'A', '红牌：该路径极不稳定'),
    // B：5/6（缺 risk），无风险红牌
    dimEv('authoritative', 'B'),
    dimEv('expert', 'B'),
    dimEv('regulatory', 'B'),
    dimEv('financial', 'B'),
    dimEv('alternative', 'B'),
  ];
  const brief = buildBrief('education', 'q', evidence);
  assert.equal(brief.kind, 'matrix');
  // A 完整度 1.0 但减 0.4 = 0.6；B 0.833 且无惩罚 → B 胜出
  assert.equal(brief.recommendedOption, 'B');
  const a = brief.options?.find((o) => o.option === 'A');
  assert.equal(a?.riskFlags.length, 1);
  assert.ok(brief.caveats.some((c) => c.includes('A') && c.includes('风险红牌')));
});

test('只有单一方案 → 退化 generic，不强行矩阵', () => {
  const evidence = [dimEv('authoritative', '唯一方案'), dimEv('risk', '唯一方案')];
  const brief = buildBrief('medical', 'q', evidence);
  assert.equal(brief.kind, 'generic');
  assert.equal(brief.options, undefined);
});

test('矩阵推荐结论写入 recommendation 且引用方案名', () => {
  const evidence: ChannelEvidence[] = [
    dimEv('authoritative', '方案甲'),
    dimEv('expert', '方案甲'),
    dimEv('regulatory', '方案甲'),
    dimEv('financial', '方案甲'),
    dimEv('alternative', '方案甲'),
    dimEv('authoritative', '方案乙'),
    dimEv('expert', '方案乙'),
    dimEv('regulatory', '方案乙'),
    dimEv('financial', '方案乙'),
    dimEv('alternative', '方案乙'),
    dimEv('risk', '方案乙'),
  ];
  const brief = buildBrief('work', 'q', evidence);
  // 方案乙完整度 6/6（含风险已评估），方案甲缺 risk（温和惩罚）→ 乙胜出
  assert.equal(brief.recommendedOption, '方案乙');
  assert.ok(brief.recommendation.includes('方案乙'));
});


// ---- 搜索源 ----

test('HttpSearchSource：POST 后端后返回已核验证据', async () => {
  const oldFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: string, opts: unknown) => {
    const o = opts as { method?: string; body?: string };
    assert.equal(o.method, 'POST');
    assert.ok((o.body ?? '').includes('regulatory'));
    return new Response(JSON.stringify({ answer: '湖南省专升本政策要点：统招专升本为全日制本科' }), {
      status: 200,
    });
  }) as unknown as typeof fetch;
  const src = new HttpSearchSource('https://search.example.com/q');
  assert.equal(src.canServe({ dimension: 'regulatory', domain: 'education', question: 'x' }), true);
  const e = await src.fetch({ dimension: 'regulatory', domain: 'education', question: 'x' });
  assert.equal(e.verified, true);
  assert.ok(e.note.includes('湖南省专升本政策要点'));
  globalThis.fetch = oldFetch;
});

test('SearchSource 无后端（NO_SEARCH）时 canServe=false，诚实不假核验', () => {
  const src = new SearchSource(NO_SEARCH);
  assert.equal(src.canServe({ dimension: 'regulatory', domain: 'education', question: 'x' }), false);
});

test('风险红牌：否定语境（"无硬性合规红牌"）不算红牌，仅真实红牌才罚分', () => {
  // work 领域必备维度：authoritative / expert / financial / risk / alternative / regulatory
  const mk = (
    option: string,
    dimension: 'authoritative' | 'expert' | 'financial' | 'risk' | 'alternative' | 'regulatory',
    note: string,
  ): ChannelEvidence => ({
    dimension,
    channel: `${dimension}-${option}`,
    source: 'unit-test',
    verified: true,
    option,
    note,
  });
  const evidence: ChannelEvidence[] = [
    mk('B2B', 'authoritative', '东南亚需求稳定'),
    mk('B2B', 'expert', '从业者反馈门槛低'),
    mk('B2B', 'financial', '启动 20-40 万'),
    mk('B2B', 'risk', '风险：账期长、低价内卷；但无硬性合规红牌，试错成本低'),
    mk('B2B', 'alternative', '可转 ODM 代工兜底'),
    mk('B2B', 'regulatory', '需出口备案'),
    mk('EUUS', 'authoritative', '欧美客单价高'),
    mk('EUUS', 'expert', '卖家反馈利润厚'),
    mk('EUUS', 'financial', '启动 50-100 万'),
    mk('EUUS', 'risk', '红牌：合规单证缺失即退运、平台封号，现金链断裂风险高'),
    mk('EUUS', 'alternative', '可用 TikTok Shop 分流'),
    mk('EUUS', 'regulatory', '需 FDA/EFSA 合规'),
  ];
  const brief = buildBrief('work', '冻干食品跨境走哪条路', evidence);
  assert.equal(brief.kind, 'matrix');
  const b2b = brief.options?.find((o) => o.option === 'B2B');
  const euus = brief.options?.find((o) => o.option === 'EUUS');
  assert.ok(b2b && euus);
  assert.equal(b2b.riskFlags.length, 0, '否定语境不应判红牌');
  assert.equal(euus.riskFlags.length, 1, '真实红牌应被判红牌');
  assert.equal(brief.recommendedOption, 'B2B', '无红牌且证据全的方案应被推荐');
});

test('未知决策领域 + 空证据：safeRequired 不崩溃，回退为空维度集合', () => {
  // 之前 safeRequired 在未知领域且无证据时会因 evidence 为 undefined 崩溃；修复后返回 [] 且不抛错
  let brief;
  assert.doesNotThrow(() => {
    brief = buildBrief('totally-unknown-domain-xyz', '任意问题', []);
  });
  assert.equal(brief.kind, 'generic');
  assert.equal(brief.totalWeightPct, 0);
});
