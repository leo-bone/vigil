/**
 * 实时证据采集层（Evidence Provider）。
 *
 * 这是把"证据真实完整"从"人/agent 手填 JSON"升级为"系统自己跑"的关键一步。
 * 设计原则（诚实闭环，绝不假核验）：
 *   1. 能机读的维度（汇率、贵金属、国债、行情）→ 用真实公开 API 实时抓取，
 *      附 source URL + 抓取时间戳 + verified:true；
 *   2. 抓不到的维度（政策/专家/风险）→ 没有可用后端时返回 verified:false，
 *      交给证据完整性闸门拦截，强制人工/搜索补充，绝不编造"已核验"；
 *   3. 同一规范维度可挂多路实时源（如 invest/financial 同时有 FX、黄金、国债、行情），
 *      只要其中一路成功核验，该维度即视为已覆盖。
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

/** 某个源能服务的 (领域, 维度, 通道) 能力描述 */
export interface SourceCapability {
  /** 限定领域；省略表示任意领域 */
  domain?: string;
  dimension: EvidenceDimension;
  /** 该源在此维度下产出的唯一通道标签（用于在同类维度中区分，例如 fx-usd-cny / gold-xau） */
  channel: string;
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

/** 带超时的 fetch，避免某个不可达源把整个采集卡死 */
async function fetchJson(url: string, timeoutMs = 7000): Promise<unknown> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return (await res.json()) as unknown;
  } finally {
    clearTimeout(timer);
  }
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
    { domain: 'invest', dimension: 'financial', channel: 'fx-usd-cny' },
    { domain: 'financing', dimension: 'financial', channel: 'fx-usd-cny' },
  ];

  async fetch(_q: EvidenceQuery): Promise<ChannelEvidence> {
    const url = 'https://api.frankfurter.app/latest?from=USD&to=CNY';
    const data = (await fetchJson(url)) as { date: string; rates: Record<string, number> };
    const rate = data.rates?.CNY;
    if (typeof rate !== 'number') throw new Error('Frankfurter 响应缺少 CNY 汇率');
    const fetchedAt = new Date().toISOString();
    return {
      dimension: 'financial',
      channel: 'fx-usd-cny',
      source: `${url} (date=${data.date})`,
      verified: true,
      value: rate,
      unit: 'USD/CNY',
      note: `实时汇率 USD/CNY=${rate}（Frankfurter/ECB 数据，抓取于 ${fetchedAt}）`,
      capturedAt: fetchedAt,
    };
  }
}

/**
 * open.er-api.com 实时汇率源（免费、无需 key），作为 Frankfurter 的兜底。
 */
export class ErApiFxSource implements EvidenceSource {
  id = 'er-api';
  serves: SourceCapability[] = [
    { domain: 'invest', dimension: 'financial', channel: 'fx-er-api' },
    { domain: 'financing', dimension: 'financial', channel: 'fx-er-api' },
  ];

  async fetch(_q: EvidenceQuery): Promise<ChannelEvidence> {
    const url = 'https://open.er-api.com/v6/latest/USD';
    const data = (await fetchJson(url)) as { time_last_update_utc?: string; rates?: Record<string, number> };
    const rate = data.rates?.CNY;
    if (typeof rate !== 'number') throw new Error('er-api 响应缺少 CNY 汇率');
    const fetchedAt = new Date().toISOString();
    return {
      dimension: 'financial',
      channel: 'fx-er-api',
      source: `${url} (updated=${data.time_last_update_utc ?? 'n/a'})`,
      verified: true,
      value: rate,
      unit: 'USD/CNY',
      note: `实时汇率 USD/CNY=${rate}（open.er-api.com，抓取于 ${fetchedAt}）`,
      capturedAt: fetchedAt,
    };
  }
}

/**
 * 现货黄金价格源（gold-api.com，无需 key，沙箱内可达）。
 * 服务 invest / financing 的 financial 维度，作为独立行情而非"卖方喊单"。
 */
export class GoldSource implements EvidenceSource {
  id = 'gold-api';
  serves: SourceCapability[] = [
    { domain: 'invest', dimension: 'financial', channel: 'gold-xau' },
    { domain: 'financing', dimension: 'financial', channel: 'gold-xau' },
  ];

  async fetch(_q: EvidenceQuery): Promise<ChannelEvidence> {
    const url = 'https://api.gold-api.com/price/XAU';
    const data = (await fetchJson(url)) as { updatedAt?: string; price?: number };
    const price = data.price;
    if (typeof price !== 'number') throw new Error('gold-api 响应缺少 price');
    const fetchedAt = new Date().toISOString();
    return {
      dimension: 'financial',
      channel: 'gold-xau',
      source: `${url} (updatedAt=${data.updatedAt ?? 'n/a'})`,
      verified: true,
      value: price,
      unit: 'USD/oz',
      note: `现货黄金 XAU/USD = $${price}（gold-api.com，抓取于 ${fetchedAt}）`,
      capturedAt: fetchedAt,
    };
  }
}

/**
 * 现货白银价格源（gold-api.com，无需 key）。
 */
export class SilverSource implements EvidenceSource {
  id = 'silver-api';
  serves: SourceCapability[] = [
    { domain: 'invest', dimension: 'financial', channel: 'silver-xag' },
    { domain: 'financing', dimension: 'financial', channel: 'silver-xag' },
  ];

  async fetch(_q: EvidenceQuery): Promise<ChannelEvidence> {
    const url = 'https://api.gold-api.com/price/XAG';
    const data = (await fetchJson(url)) as { updatedAt?: string; price?: number };
    const price = data.price;
    if (typeof price !== 'number') throw new Error('gold-api 响应缺少 price');
    const fetchedAt = new Date().toISOString();
    return {
      dimension: 'financial',
      channel: 'silver-xag',
      source: `${url} (updatedAt=${data.updatedAt ?? 'n/a'})`,
      verified: true,
      value: price,
      unit: 'USD/oz',
      note: `现货白银 XAG/USD = $${price}（gold-api.com，抓取于 ${fetchedAt}）`,
      capturedAt: fetchedAt,
    };
  }
}

/**
 * 美国 10 年期国债收益率源（AlphaVantage TREASURY_YIELD，无需 key 的 demo 即可用，
 * 也可通过 VIGIL_AV_KEY 配置正式免费 key 提升配额）。
 */
export class TreasuryYieldSource implements EvidenceSource {
  id = 'alphavantage-treasury';
  serves: SourceCapability[] = [
    { domain: 'invest', dimension: 'financial', channel: 'us10y' },
    { domain: 'financing', dimension: 'financial', channel: 'us10y' },
  ];

  private apiKey: string;
  constructor(apiKey?: string) {
    this.apiKey = apiKey ?? process.env.VIGIL_AV_KEY ?? 'demo';
  }

  async fetch(_q: EvidenceQuery): Promise<ChannelEvidence> {
    const url = `https://www.alphavantage.co/query?function=TREASURY_YIELD&interval=monthly&maturity=10year&apikey=${this.apiKey}`;
    const data = (await fetchJson(url)) as {
      data?: Array<{ date: string; value: string }>;
      Note?: string;
      Information?: string;
    };
    const arr = data.data;
    if (!Array.isArray(arr) || arr.length === 0) {
      throw new Error(data.Note ?? data.Information ?? 'AlphaVantage 无数据（可能 demo key 配额耗尽）');
    }
    const latest = arr[0];
    const yieldPct = Number(latest.value);
    if (!Number.isFinite(yieldPct)) throw new Error('缺收益率数值');
    const fetchedAt = new Date().toISOString();
    return {
      dimension: 'financial',
      channel: 'us10y',
      source: `${url}`,
      verified: true,
      value: yieldPct,
      unit: '%',
      note: `美国 10 年期国债收益率 ${latest.date} = ${yieldPct}%（AlphaVantage，抓取于 ${fetchedAt}）`,
      capturedAt: fetchedAt,
    };
  }
}

/**
 * 加密资产行情源（CoinGecko simple/price，无需 key，公网可达；沙箱内被出网策略拦截，
 * 此时诚实标记未核验，待接入可达网络或代理后自动生效）。
 */
export class CryptoSource implements EvidenceSource {
  id = 'coingecko';
  serves: SourceCapability[] = [
    { domain: 'invest', dimension: 'financial', channel: 'crypto-btc' },
    { domain: 'financing', dimension: 'financial', channel: 'crypto-btc' },
  ];

  async fetch(_q: EvidenceQuery): Promise<ChannelEvidence> {
    const url = 'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,ethereum&vs_currencies=usd';
    const data = (await fetchJson(url)) as { bitcoin?: { usd?: number }; ethereum?: { usd?: number } };
    const btc = data.bitcoin?.usd;
    if (typeof btc !== 'number') throw new Error('CoinGecko 缺 BTC 价格');
    const eth = data.ethereum?.usd;
    const fetchedAt = new Date().toISOString();
    return {
      dimension: 'financial',
      channel: 'crypto-btc',
      source: url,
      verified: true,
      value: btc,
      unit: 'USD',
      note: `BTC=$${btc}${eth !== undefined ? `，ETH=$${eth}` : ''}（CoinGecko，抓取于 ${fetchedAt}）`,
      capturedAt: fetchedAt,
    };
  }
}

/**
 * 股指行情源（Stooq CSV，无需 key，公网可达；沙箱内可能不可达，诚实降级）。
 */
export class StockIndexSource implements EvidenceSource {
  id = 'stooq';
  serves: SourceCapability[] = [
    { domain: 'invest', dimension: 'financial', channel: 'sp500' },
    { domain: 'financing', dimension: 'financial', channel: 'sp500' },
  ];

  async fetch(_q: EvidenceQuery): Promise<ChannelEvidence> {
    const url = 'https://stooq.com/q/l/?s=spx.us&f=sd2t2ohlcv&h&e=csv';
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 7000);
    let text: string;
    try {
      const res = await fetch(url, { signal: ctrl.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      text = await res.text();
    } finally {
      clearTimeout(timer);
    }
    const lines = text.trim().split('\n').filter(Boolean);
    if (lines.length < 2) throw new Error('Stooq 返回非预期内容');
    const cols = lines[0].toLowerCase().split(',');
    const row = lines[lines.length - 1].split(',');
    const close = Number(row[cols.indexOf('close')]);
    const date = row[cols.indexOf('date')];
    if (!Number.isFinite(close)) throw new Error('Stooq 缺 close 字段');
    const fetchedAt = new Date().toISOString();
    return {
      dimension: 'financial',
      channel: 'sp500',
      source: `${url} (date=${date})`,
      verified: true,
      value: close,
      unit: 'pts',
      note: `S&P 500 收盘 ${date} = ${close}（Stooq，抓取于 ${fetchedAt}）`,
      capturedAt: fetchedAt,
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
    { dimension: 'authoritative', channel: 'web-search' },
    { dimension: 'regulatory', channel: 'web-search' },
    { dimension: 'expert', channel: 'web-search' },
    { dimension: 'risk', channel: 'web-search' },
    { dimension: 'alternative', channel: 'web-search' },
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
      dimension: q.dimension,
      channel: q.dimension,
      source: `web-search (query="[${q.dimension}] ${q.question}", fetched=${fetchedAt})`,
      verified: true,
      note: snippet.slice(0, 400),
      capturedAt: fetchedAt,
    };
  }
}

/**
 * HTTP 搜索后端源：把"搜索类维度"交给一个真实的后端服务去取
 * （你自己的搜索代理 / 向量库 / 爬虫 / LLM 工具端点均可，只需接受
 *   POST { query, dimension }、返回 { answer | snippet } 的 JSON）。
 *
 * 配置方式：在 CLI 里通过 `VIGIL_SEARCH_URL=https://your-search.example.com/query` 启用；
 * 未配置时此源不会进入采集（canServe=false），相关维度保持未核验，由闸门诚实拦截——
 * 绝不因为"有个搜索框"就假装核验过了。
 */
export class HttpSearchSource implements EvidenceSource {
  id = 'http-search';
  private url: string;
  private headers: Record<string, string>;
  /** 该源负责的非机读维度 */
  serves: SourceCapability[] = [
    { dimension: 'authoritative', channel: 'http-search' },
    { dimension: 'regulatory', channel: 'http-search' },
    { dimension: 'expert', channel: 'http-search' },
    { dimension: 'risk', channel: 'http-search' },
    { dimension: 'alternative', channel: 'http-search' },
  ];

  constructor(url: string, headers: Record<string, string> = {}) {
    this.url = url;
    this.headers = headers;
  }

  canServe(q: EvidenceQuery): boolean {
    return matches(this, q);
  }

  async fetch(q: EvidenceQuery): Promise<ChannelEvidence> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 10000);
    let text: string;
    try {
      const res = await fetch(this.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...this.headers },
        body: JSON.stringify({ query: `[${q.dimension}] ${q.question}`, dimension: q.dimension }),
        signal: ctrl.signal,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { answer?: string; snippet?: string };
      text = (data.answer ?? data.snippet ?? JSON.stringify(data)).slice(0, 500);
    } finally {
      clearTimeout(timer);
    }
    const fetchedAt = new Date().toISOString();
    return {
      dimension: q.dimension,
      channel: `http-search-${q.dimension}`,
      source: `${this.url} (dim=${q.dimension}, fetched=${fetchedAt})`,
      verified: true,
      note: text,
      capturedAt: fetchedAt,
    };
  }
}

/** 默认启用的实时源（无需 key、沙箱可达）：FX / 黄金 / 白银 / 国债。 */
export function defaultSources(): EvidenceSource[] {
  return [
    new FrankfurterFxSource(),
    new ErApiFxSource(),
    new GoldSource(),
    new SilverSource(),
    new TreasuryYieldSource(),
  ];
}

/** 扩展实时源（公网可达、沙箱可能不可达，需显式开启）：加密资产 / 股指行情。 */
export function extendedSources(): EvidenceSource[] {
  return [new CryptoSource(), new StockIndexSource()];
}

/**
 * 组合采集源：默认源 + 可选扩展源 + 可选 HTTP 搜索后端（政策/专家/风险等维度）。
 * 未配置 searchUrl 时，搜索类维度无后端 → 诚实保持未核验，由闸门拦截。
 */
export function buildSources(opts: { extended?: boolean; searchUrl?: string } = {}): EvidenceSource[] {
  const sources: EvidenceSource[] = [
    new FrankfurterFxSource(),
    new ErApiFxSource(),
    new GoldSource(),
    new SilverSource(),
    new TreasuryYieldSource(),
  ];
  if (opts.extended) sources.push(new CryptoSource(), new StockIndexSource());
  if (opts.searchUrl) sources.push(new HttpSearchSource(opts.searchUrl));
  return sources;
}

export interface GatherOptions {
  /** 已存在的证据（如手填的 JSON）；采集时优先保留其中已核验的维度，只补缺失/未核验项 */
  existing?: ChannelEvidence[];
  /** 注入的搜索后端（agent 运行期可把 WebSearch 接进来） */
  search?: SearchFn;
  /** 是否纳入扩展源（加密/股指等公网源） */
  extended?: boolean;
}

export interface GatherResult {
  evidence: ChannelEvidence[];
  /** 已实时核验的维度 */
  gathered: EvidenceDimension[];
  /** 抓不到 / 未核验的维度（完整性闸门会据此拦截） */
  unverified: EvidenceDimension[];
  /** 是否所有必备维度都已实时核验 */
  fullyLive: boolean;
}

/**
 * 按决策规格采集证据：遍历必备维度，用能服务的所有源实时抓取（同一维度可多路）；
 * 已有 verified 证据的 (维度,通道) 直接沿用，不重复抓。抓不到的维度保持未核验。
 */
export async function gatherEvidence(
  spec: EvidenceSpec,
  question: string,
  domain: string,
  sources: EvidenceSource[] = defaultSources(),
  opts: GatherOptions = {},
): Promise<GatherResult> {
  const existing = opts.existing ?? [];
  const activeSources = [
    ...sources,
    ...(opts.extended ? extendedSources() : []),
    ...(opts.search ? [new SearchSource(opts.search)] : []),
  ];

  const evidence: ChannelEvidence[] = [];

  for (const dim of spec.required) {
    // 先沿用已核验的既有证据（整维度）：手填/搜索已核验的，不重复抓取，避免把真实证据丢掉
    const priorVerified = existing.filter((e) => (e.dimension ?? e.channel) === dim && e.verified);
    if (priorVerified.length > 0) {
      for (const p of priorVerified) evidence.push(p);
      continue;
    }

    const sourcesForDim = activeSources.filter((s) =>
      s instanceof SearchSource ? s.canServe({ dimension: dim, domain, question }) : matches(s, { dimension: dim, domain, question }),
    );

    if (sourcesForDim.length === 0) {
      evidence.push({
        dimension: dim,
        channel: dim,
        source: '(none)',
        verified: false,
        note: '无可用实时源，需人工 / 搜索补充',
      });
      continue;
    }

    for (const src of sourcesForDim) {
      const cap = src.serves.find((c) => (c.domain === undefined || c.domain === domain) && c.dimension === dim);
      const channel = cap?.channel ?? src.id;
      try {
        const ev = await src.fetch({ dimension: dim, domain, question });
        evidence.push(ev);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        evidence.push({
          dimension: dim,
          channel,
          source: src.id,
          verified: false,
          note: `采集失败：${msg}`,
        });
      }
    }
  }

  // 以"维度是否至少有 1 条 verified"汇总，与完整性闸门口径一致
  const gathered: EvidenceDimension[] = [];
  const unverified: EvidenceDimension[] = [];
  for (const dim of spec.required) {
    const hasVerified = evidence.some((e) => (e.dimension ?? e.channel) === dim && e.verified);
    (hasVerified ? gathered : unverified).push(dim);
  }

  return { evidence, gathered, unverified, fullyLive: unverified.length === 0 };
}
