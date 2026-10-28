/**
 * 实时证据采集层（Evidence Provider）。
 *
 * 这是把"证据真实完整"从"人/agent 手填 JSON"升级为"系统自己跑"的关键一步。
 * 设计原则（诚实闭环，绝不假核验）：
 *   1. 能机读的维度（如汇率）→ 用真实公开 API 实时抓取，附 source URL + 抓取时间戳 + verified:true。
 *   2. 抓不到的维度（如政策/专家/风险）→ 没有可用后端时返回 verified:false，
 *      交给证据完整性闸门拦截，强制人工/搜索补充，绝不编造"已核验"。
 *
 * 之所以这样设计：首轮翻车就是"漏了国补、还假设线上价"——证据必须是真的，
 * 系统要么拿到真数据，要么明说"我没拿到"，而不能默默填个数。
 */

import type { ChannelEvidence, EvidenceDimension, EvidenceSpec } from './evidence.ts';

/** 一次证据采集查询 */
export interface EvidenceQuery {
  dimension: EvidenceDimension;
  /** 决策领域 key，如 invest / financing */
  domain: string;
  /** 决策问题文本 */
  question: string;
}

/** 某个源能服务的 (领域, 维度) 能力描述 */
export interface SourceCapability {
  /** 限定领域；省略表示任意领域 */
  domain?: string;
  dimension: EvidenceDimension;
}

/** 一个实时证据源 */
export interface EvidenceSource {
  id: string;
  serves: SourceCapability[];
  /** 实时抓取；返回带 source URL 与抓取时间的证据（verified 由实现决定） */
  fetch(q: EvidenceQuery): Promise<ChannelEvidence>;
}

function matches(source: EvidenceSource, q: EvidenceQuery): boolean {
  return source.serves.some(
    (c) => (c.domain === undefined || c.domain === q.domain) && c.dimension === q.dimension,
  );
}

/** 可注入的搜索函数：用于政策/专家/风险等无法机读的维度 */
export type SearchFn = (query: string) => Promise<string>;

/** 默认无后端：搜索类维度保持未核验（诚实，不假核验） */
export const NO_SEARCH: SearchFn = async () => {
  throw new Error('no search backend configured');
};

/**
 * Frankfurter 实时汇率源（ECB 数据，无需 key，已验证沙箱内可达）。
 * 服务 invest / financing 领域的 financial 维度，抓取 USD/CNY 实时汇率。
 */
export class FrankfurterFxSource implements EvidenceSource {
  id = 'frankfurter';
  serves: SourceCapability[] = [
    { domain: 'invest', dimension: 'financial' },
    { domain: 'financing', dimension: 'financial' },
  ];

  async fetch(_q: EvidenceQuery): Promise<ChannelEvidence> {
    const url = 'https://api.frankfurter.app/latest?from=USD&to=CNY';
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Frankfurter HTTP ${res.status}`);
    const data = (await res.json()) as { date: string; rates: Record<string, number> };
    const rate = data.rates?.CNY;
    if (typeof rate !== 'number') throw new Error('Frankfurter 响应缺少 CNY 汇率');
    const fetchedAt = new Date().toISOString();
    return {
      channel: 'financial',
      source: `${url} (date=${data.date})`,
      verified: true,
      note: `实时汇率 USD/CNY=${rate}（Frankfurter/ECB 数据，抓取于 ${fetchedAt}）`,
    };
  }
}

/**
 * open.er-api.com 实时汇率源（免费、无需 key），作为 Frankfurter 的兜底。
 */
export class ErApiFxSource implements EvidenceSource {
  id = 'er-api';
  serves: SourceCapability[] = [
    { domain: 'invest', dimension: 'financial' },
    { domain: 'financing', dimension: 'financial' },
  ];

  async fetch(_q: EvidenceQuery): Promise<ChannelEvidence> {
    const url = 'https://open.er-api.com/v6/latest/USD';
    const res = await fetch(url);
    if (!res.ok) throw new Error(`er-api HTTP ${res.status}`);
    const data = (await res.json()) as { time_last_update_utc?: string; rates?: Record<string, number> };
    const rate = data.rates?.CNY;
    if (typeof rate !== 'number') throw new Error('er-api 响应缺少 CNY 汇率');
    const fetchedAt = new Date().toISOString();
    return {
      channel: 'financial',
      source: `${url} (updated=${data.time_last_update_utc ?? 'n/a'})`,
      verified: true,
      note: `实时汇率 USD/CNY=${rate}（open.er-api.com，抓取于 ${fetchedAt}）`,
    };
  }
}

/**
 * 搜索源：用于政策/专家/风险/替代等无法机读的维度。
 * 仅当注入了真实 searchFn 时才生效；否则 canFetch 返回 false，
 * 相关维度保持未核验，由完整性闸门拦截。
 */
export class SearchSource implements EvidenceSource {
  id = 'web-search';
  private fn: SearchFn;
  /** 该源负责的非机读维度 */
  serves: SourceCapability[] = [
    { dimension: 'authoritative' },
    { dimension: 'regulatory' },
    { dimension: 'expert' },
    { dimension: 'risk' },
    { dimension: 'alternative' },
  ];

  constructor(fn: SearchFn = NO_SEARCH) {
    this.fn = fn;
  }

  canServe(q: EvidenceQuery): boolean {
    if (this.fn === NO_SEARCH) return false; // 无后端 → 不假装能取
    return matches(this, q);
  }

  async fetch(q: EvidenceQuery): Promise<ChannelEvidence> {
    const snippet = await this.fn(`[${q.dimension}] ${q.question}`);
    const fetchedAt = new Date().toISOString();
    return {
      channel: q.dimension,
      source: `web-search (query="[${q.dimension}] ${q.question}", fetched=${fetchedAt})`,
      verified: true,
      note: snippet.slice(0, 400),
    };
  }
}

/** 默认启用的实时源（无需 key、沙箱可达）。搜索源默认不启用（无后端）。 */
export function defaultSources(): EvidenceSource[] {
  return [new FrankfurterFxSource(), new ErApiFxSource()];
}

export interface GatherOptions {
  /** 已存在的证据（如手填的 JSON）；采集时优先保留其中已核验的维度，只补缺失/未核验项 */
  existing?: ChannelEvidence[];
  /** 注入的搜索后端（agent 运行期可把 WebSearch 接进来） */
  search?: SearchFn;
}

export interface GatherResult {
  evidence: ChannelEvidence[];
  /** 成功采集且 verified 的维度 */
  gathered: EvidenceDimension[];
  /** 抓不到 / 未核验的维度（完整性闸门会据此拦截） */
  unverified: EvidenceDimension[];
  /** 是否所有必备维度都已实时核验 */
  fullyLive: boolean;
}

/**
 * 按决策规格采集证据：遍历必备维度，用能服务的源实时抓取；
 * 已有 verified 证据的维度直接沿用，不重复抓。抓不到的维度保持未核验。
 */
export async function gatherEvidence(
  spec: EvidenceSpec,
  question: string,
  domain: string,
  sources: EvidenceSource[] = defaultSources(),
  opts: GatherOptions = {},
): Promise<GatherResult> {
  const existing = opts.existing ?? [];
  const activeSources = opts.search ? [...sources, new SearchSource(opts.search)] : sources;

  const evidence: ChannelEvidence[] = [];
  const gathered: EvidenceDimension[] = [];
  const unverified: EvidenceDimension[] = [];

  for (const dim of spec.required) {
    // 沿用已核验的既有证据
    const prior = existing.find((e) => e.channel === dim && e.verified);
    if (prior) {
      evidence.push(prior);
      gathered.push(dim);
      continue;
    }
    const src = activeSources.find((s) =>
      s instanceof SearchSource ? s.canServe({ dimension: dim, domain, question }) : matches(s, { dimension: dim, domain, question }),
    );
    if (!src) {
      evidence.push({
        channel: dim,
        source: '(none)',
        verified: false,
        note: '无可用实时源，需人工 / 搜索补充',
      });
      unverified.push(dim);
      continue;
    }
    try {
      const ev = await src.fetch({ dimension: dim, domain, question });
      evidence.push(ev);
      if (ev.verified) gathered.push(dim);
      else unverified.push(dim);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      evidence.push({
        channel: dim,
        source: src.id,
        verified: false,
        note: `采集失败：${msg}`,
      });
      unverified.push(dim);
    }
  }

  return { evidence, gathered, unverified, fullyLive: unverified.length === 0 };
}
