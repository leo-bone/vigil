import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  gatherEvidence,
  FrankfurterFxSource,
  SearchSource,
  NO_SEARCH,
  type EvidenceSource,
  type EvidenceQuery,
} from '../src/loop/evidenceProvider.ts';
import type { ChannelEvidence, EvidenceSpec } from '../src/loop/evidence.ts';

const INVEST_SPEC: EvidenceSpec = {
  required: ['authoritative', 'regulatory', 'financial', 'risk', 'expert', 'alternative'],
};

/** 一个只服务 financial 维度的 mock 源 */
class MockFxSource implements EvidenceSource {
  id = 'mock-fx';
  serves = [{ dimension: 'financial' as const }];
  async fetch() {
    return {
      channel: 'financial',
      source: 'mock://fx',
      verified: true,
      note: 'mock rate 6.66',
    } satisfies ChannelEvidence;
  }
}

test('证据采集：可用源覆盖的维度标记为已核验，其余标记为未核验（不假核验）', async () => {
  const res = await gatherEvidence(INVEST_SPEC, '配置20万美金', 'invest', [new MockFxSource()]);
  assert.equal(res.evidence.length, 6);
  assert.deepEqual(res.gathered, ['financial']);
  assert.deepEqual(res.unverified.sort(), [
    'alternative',
    'authoritative',
    'expert',
    'regulatory',
    'risk',
  ]);
  assert.equal(res.fullyLive, false);
  const fin = res.evidence.find((e) => e.channel === 'financial')!;
  assert.equal(fin.verified, true);
  const auth = res.evidence.find((e) => e.channel === 'authoritative')!;
  assert.equal(auth.verified, false);
});

test('证据采集：沿用既有已核验证据，不为已有维度重复抓取', async () => {
  const existing: ChannelEvidence[] = [
    { channel: 'authoritative', source: 'pre://x', verified: true, note: 'prior' },
  ];
  const fetchSpy = new MockFxSource();
  let calls = 0;
  const orig = fetchSpy.fetch.bind(fetchSpy);
  fetchSpy.fetch = async (...a) => {
    calls++;
    return orig(...a);
  };
  const res = await gatherEvidence(INVEST_SPEC, '配置20万美金', 'invest', [fetchSpy], {
    existing,
  });
  // authoritative 沿用既有，不应再被抓取
  const auth = res.evidence.find((e) => e.channel === 'authoritative')!;
  assert.equal(auth.source, 'pre://x');
  assert.equal(calls, 1); // 只抓了 financial
  assert.equal(res.fullyLive, false);
});

test('SearchSource 无后端（NO_SEARCH）时不假装能取，维度保持未核验', async () => {
  const src = new SearchSource(NO_SEARCH);
  assert.equal(src.canServe({ dimension: 'authoritative', domain: 'invest', question: 'x' }), false);
  const res = await gatherEvidence(INVEST_SPEC, '配置20万美金', 'invest', [src]);
  assert.equal(res.gathered.length, 0);
  assert.equal(res.unverified.length, 6);
});

test('SearchSource 注入真实 searchFn 后可采集非机读维度并标记为已核验', async () => {
  const src = new SearchSource(async (q) => `搜索结果片段 for ${q}`);
  assert.equal(src.canServe({ dimension: 'authoritative', domain: 'invest', question: 'q' }), true);
  const res = await gatherEvidence(INVEST_SPEC, '配置20万美金', 'invest', [src]);
  // SearchSource 只服务 5 个非机读维度（不含 financial，那是机读源的职责）
  assert.deepEqual(res.gathered.sort(), [
    'alternative',
    'authoritative',
    'expert',
    'regulatory',
    'risk',
  ]);
  assert.equal(res.fullyLive, false);
  assert.ok(res.gathered.every((d) => res.evidence.find((e) => e.channel === d)!.verified));
});

test('FrankfurterFxSource 仅服务 invest/financing 的 financial 维度', () => {
  const src = new FrankfurterFxSource();
  assert.equal(
    src.serves.some((c) => c.dimension === 'financial' && (c.domain === 'invest' || c.domain === 'financing')),
    true,
  );
});

test('FrankfurterFxSource 解析真实响应（mock fetch，离线确定性）', async () => {
  const saved = globalThis.fetch;
  // @ts-expect-error 覆盖全局 fetch 做确定性测试
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({ date: '2026-10-27', rates: { CNY: 6.6675 } }),
  });
  try {
    const src = new FrankfurterFxSource();
    const ev = await src.fetch({ dimension: 'financial', domain: 'invest', question: 'q' });
    assert.equal(ev.verified, true);
    assert.match(ev.note, /USD\/CNY=6\.6675/);
    assert.match(ev.source, /frankfurter\.app/);
  } finally {
    globalThis.fetch = saved;
  }
});

test('多方案 goal：搜索后端按 (维度,方案) 分别补抓，证据归属到各方案', async () => {
  // 模拟 HttpSearchSource 行为：把查询里的 option 透传到返回证据的 option 上，实现方案归属
  class OptionAwareSource implements EvidenceSource {
    id = 'opt-aware';
    serves = [
      { dimension: 'authoritative' as const },
      { dimension: 'expert' as const },
      { dimension: 'risk' as const },
      { dimension: 'regulatory' as const },
      { dimension: 'alternative' as const },
    ];
    async fetch(q: EvidenceQuery) {
      return {
        dimension: q.dimension,
        channel: `opt-${q.dimension}`,
        source: 'mock',
        verified: true,
        option: q.option,
        note: `ev for ${q.dimension}/${q.option ?? '-'}`,
      } satisfies ChannelEvidence;
    }
  }
  const spec: EvidenceSpec = {
    required: ['authoritative', 'expert', 'financial', 'risk', 'regulatory', 'alternative'],
  };
  const existing: ChannelEvidence[] = [
    { dimension: 'financial', channel: 'cost-a', source: 'x', verified: true, option: '方案A', note: 'cost a' },
    { dimension: 'financial', channel: 'cost-b', source: 'x', verified: true, option: '方案B', note: 'cost b' },
  ];
  const res = await gatherEvidence(spec, 'q', 'work', [new OptionAwareSource()], { existing });
  // financial 沿用手填(2 条) + 其余 5 维度 × 2 方案(10 条) = 12 条，都带 option 归属
  const optEv = res.evidence.filter((e) => e.option);
  assert.equal(optEv.length, 12);
  const a = res.evidence.filter((e) => e.option === '方案A');
  const b = res.evidence.filter((e) => e.option === '方案B');
  assert.equal(a.length, 6); // 1 手填 financial + 5 自动补抓非金融
  assert.equal(b.length, 6);
  assert.ok(
    ['authoritative', 'expert', 'risk', 'regulatory', 'alternative'].every((d) =>
      a.some((e) => e.dimension === d && e.verified),
    ),
  );
  // financial 未被重复补抓
  assert.equal(res.evidence.filter((e) => e.dimension === 'financial').length, 2);
});
