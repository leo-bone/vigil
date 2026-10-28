/**
 * 证据驱动裁决（Reasoning Layer）。
 *
 * 这是把 Vigil 从"打印证据 + 手填立场决定一切"升级为"让实时证据真的参与决策"的关键一层。
 *
 * 之前的问题：决策循环把 live 采集到的行情（黄金/国债/FX 实时价）只打印了一遍，
 * 真正的裁决由 goal 里预先写死的 positions 立场决定 —— 等于没在决策。
 *
 * 本层做的事：把已核验的金融证据，按**透明、可复核的规则**转成一份有数据支撑的配置方案
 * （DecisionBrief），再喂回裁决与执行。规则全部写在代码里、可解释、每个仓位都引用实时数值与时间戳。
 *
 * 设计底线（与证据层一致，绝不假决策）：
 *   - 只在有真实数值时才给该资产配置仓位；抓不到的行情，仓位下调/移除并明确警示，绝不编造数字。
 *   - 非金融领域（医疗/教育/购物…）不做资产配置，只输出"已核验证据摘要"作为裁决依据，
 *     避免越界给出无依据的"建议"。
 */

import type { ChannelEvidence, EvidenceDimension } from './evidence.ts';
import { resolveDomainSpec } from './evidence.ts';

/** 单一资产的配置建议（权重 + 引用实时数据的理由） */
export interface AllocationSlice {
  /** 人类可读资产名，如「美国10年期国债」「现货黄金」 */
  asset: string;
  /** 机器可读代码，如 US_TREASURY_10Y / GOLD，供执行器/券商端点消费 */
  code: string;
  /** 目标权重（百分比，所有 slice 合计 = 100） */
  weightPct: number;
  /** 引用实时数值与时间戳的配置理由 */
  rationale: string;
  /** 支撑该仓位的证据通道（fx-usd-cny / gold-xau / us10y …） */
  evidenceChannel?: string;
}

export type Confidence = 'low' | 'medium' | 'high';

/** 多方案决策矩阵中的单个方案评分 */
export interface DecisionOptionScore {
  /** 方案标签，如「专升本」「竞赛免试升本科」 */
  option: string;
  /** 该方案已核验的必备维度 */
  verifiedDims: EvidenceDimension[];
  /** 该方案缺失（未核验）的必备维度 */
  missingDims: EvidenceDimension[];
  /** 风险维度的已核验红牌（note 列表） */
  riskFlags: string[];
  /** 证据完整度 0~1 = 已核验必备维度 / 总必备维度 */
  coverage: number;
  /** 综合得分（coverage 减去风险惩罚，用于排序） */
  score: number;
}

/** 一份证据驱动的决策简报 */
export interface DecisionBrief {
  domain: string;
  question: string;
  generatedAt: string;
  /** 实时信号一句话汇总（带时间戳），直接可见 */
  signalSummary: string;
  /** 资产配置（仅 invest / financing 领域有内容） */
  allocation: AllocationSlice[];
  /** allocation 权重合计（应为 100；generic 为 0） */
  totalWeightPct: number;
  confidence: Confidence;
  /** 缺失信号 / 假设的警示 */
  caveats: string[];
  /** 一句话结论 */
  recommendation: string;
  /** 'allocation' = 已算出配置；'generic' = 仅证据摘要；'matrix' = 多方案决策矩阵 */
  kind: 'allocation' | 'generic' | 'matrix';
  /** 多方案决策矩阵（matrix 时有内容） */
  options?: DecisionOptionScore[];
  /** 矩阵推荐方案标签 */
  recommendedOption?: string;
}

/** 取某通道已核验证据的结构化数值 */
function val(ev: ChannelEvidence | undefined): number | undefined {
  return ev && ev.verified && typeof ev.value === 'number' ? ev.value : undefined;
}

function findCh(evidence: ChannelEvidence[], channel: string): ChannelEvidence | undefined {
  return evidence.find((e) => e.channel === channel && e.verified);
}

/** 金融资产配置领域：invest（投资）/ financing（融资理财）共用同一套实时信号 */
const ALLOCATION_DOMAINS = new Set(['invest', 'financing']);

/**
 * 由实时证据构建决策简报。
 * @param domain 决策领域 key（invest / financing / purchase / medical …）
 * @param question 决策问题
 * @param evidence 已采集证据（含已核验的实时金融数据）
 * @param requiredDims 该领域的必备证据维度（默认从注册表解析）；多方案矩阵据此计算每个方案的完整度
 */
export function buildBrief(
  domain: string,
  question: string,
  evidence: ChannelEvidence[],
  requiredDims?: EvidenceDimension[],
): DecisionBrief {
  if (ALLOCATION_DOMAINS.has(domain)) {
    return buildAllocationBrief(domain, question, evidence);
  }
  const dims = requiredDims ?? safeRequired(domain);
  return buildGenericBrief(domain, question, evidence, dims);
}

/** 从注册表解析必备维度；未知领域回退到证据里出现过的维度，避免崩溃 */
function safeRequired(domain: string, evidence: ChannelEvidence[]): EvidenceDimension[] {
  try {
    return resolveDomainSpec(domain).required;
  } catch {
    return Array.from(new Set(evidence.map((e) => e.dimension ?? e.channel))) as EvidenceDimension[];
  }
}

/**
 * 通用简报：非金融领域的决策依据。
 * - 若证据按 `option` 分组（存在 ≥2 个方案），生成**多方案决策矩阵**：
 *   每个方案的"必备维度证据完整度×风险红牌"排序，给出推荐方案（透明、可复核）。
 * - 否则退化为证据摘要，不编造配置。
 *
 * 设计底线（与金融配置一致，绝不假决策）：
 *   - 只按"证据完整度 + 风险红牌"排序，明确说明这不是对方案优劣的价值判断，而是"哪条路证据最充分、风险最可控"；
 *   - 任一方案缺必备维度 → 保留为警示，不会替你拍板；
 *   - 有未决风险红牌的方案一律降权并标注。
 */
function buildGenericBrief(
  domain: string,
  question: string,
  evidence: ChannelEvidence[],
  requiredDims?: EvidenceDimension[],
): DecisionBrief {
  const dims = requiredDims ?? safeRequired(domain, evidence);
  const options = Array.from(
    new Set(evidence.map((e) => e.option).filter((o): o is string => !!o)),
  );

  if (options.length >= 2) {
    return buildMatrixBrief(domain, question, evidence, dims, options);
  }

  // 单方案 / 无方案：退化为证据摘要
  const verified = evidence.filter((e) => e.verified);
  const signalSummary = verified.length
    ? verified
        .map((e) => `[${e.dimension ?? e.channel}/${e.channel}] ${e.note ?? e.source}`)
        .join(' ｜ ')
    : '（无已核验证据可供决策依据）';
  const unverified = evidence
    .filter((e) => !e.verified)
    .map((e) => e.dimension ?? e.channel);
  return {
    domain,
    question,
    generatedAt: new Date().toISOString(),
    signalSummary,
    allocation: [],
    totalWeightPct: 0,
    confidence: verified.length >= 4 ? 'high' : verified.length >= 2 ? 'medium' : 'low',
    caveats: unverified.length
      ? [`未核验维度：${unverified.join('、')}（相关结论需人工 / 搜索补充后再定）`]
      : [],
    recommendation: '依据已核验证据进行裁决；各维度证据见上方信号摘要。',
    kind: 'generic',
  };
}

/**
 * 多方案决策矩阵：把每种方案在必备维度上的证据完整度算出来，叠加风险红牌惩罚后排序。
 * 排名逻辑（全部透明可解释，非黑箱）：
 *   score = 证据完整度(0~1) − (有风险红牌 ? 0.4 : 0)
 * 推荐 = 得分最高者；若并列或无人全证据，则明确说"证据不足以定"，并列出各方案缺口。
 */
function buildMatrixBrief(
  domain: string,
  question: string,
  evidence: ChannelEvidence[],
  requiredDims: EvidenceDimension[],
  options: string[],
): DecisionBrief {
  const dimOf = (e: ChannelEvidence) => e.dimension ?? e.channel;
  // 风险红牌关键词：只有风险维度证据明确指向负面结果时才算红牌，避免"已评估风险=有风险"的误判
  const RED_FLAG = /风险|红牌|危险|失败|坑|拒|不予|不能|不可|极高|极低|缺失|未核验|爆雷|诈骗|副作用|违规|不确定|收紧|低概率|落空/;
  const scored: DecisionOptionScore[] = options.map((opt) => {
    const optEv = evidence.filter((e) => e.option === opt);
    const verifiedDims = requiredDims.filter((d) => optEv.some((e) => dimOf(e) === d && e.verified));
    const missingDims = requiredDims.filter((d) => !verifiedDims.includes(d));
    const riskNotes = optEv
      .filter((e) => dimOf(e) === 'risk' && e.verified && e.note)
      .map((e) => e.note as string);
    const riskFlags = riskNotes.filter((n) => RED_FLAG.test(n));
    const coverage = requiredDims.length ? verifiedDims.length / requiredDims.length : 0;
    // 惩罚：明确风险红牌重罚(-0.4)；风险维度缺失(未评估)轻罚(-0.15)，因为"未知风险"也需谨慎
    const penalty = riskFlags.length > 0 ? 0.4 : missingDims.includes('risk') ? 0.15 : 0;
    const score = Math.max(0, coverage - penalty);
    return { option: opt, verifiedDims, missingDims, riskFlags, coverage, score };
  });

  scored.sort((a, b) => b.score - a.score);
  const top = scored[0];
  const second = scored[1];
  const tie = second && Math.abs(top.score - second.score) < 1e-9;

  const caveats: string[] = [];
  for (const s of scored) {
    if (s.missingDims.length) {
      const missingList = s.missingDims.join('、');
      caveats.push(
        s.missingDims.includes('risk')
          ? `「${s.option}」风险维度未评估（${missingList}），建议补齐风险评估后再定`
          : `「${s.option}」缺未核验维度：${missingList}（建议补齐后再定）`,
      );
    }
    if (s.riskFlags.length) {
      caveats.push(`「${s.option}」风险红牌：${s.riskFlags.join('；')}`);
    }
  }

  const allFull = top.coverage >= 1 && top.riskFlags.length === 0;
  const confidence: Confidence = allFull && !tie ? 'high' : top.coverage >= 0.6 ? 'medium' : 'low';

  let recommendation: string;
  if (tie) {
    recommendation = `「${top.option}」与「${second.option}」证据完整度并列，暂不下最终结论；建议补齐缺口维度（见警示）后再二选一。`;
  } else if (allFull) {
    recommendation = `基于当前证据完整度与风险可控度，推荐优先推进「${top.option}」（${requiredDims.length}/${requiredDims.length} 维度已核验、无未决风险）。`;
  } else {
    recommendation = `证据最充分的当前是「${top.option}」（完整度 ${(top.coverage * 100).toFixed(0)}%），但仍有缺口/风险，建议补齐后再定稿。`;
  }

  return {
    domain,
    question,
    generatedAt: new Date().toISOString(),
    signalSummary: `多方案对比（${options.length} 个方案 × ${requiredDims.length} 必备维度）：` +
      scored
        .map((s) => `${s.option} 完整度${(s.coverage * 100).toFixed(0)}%${s.riskFlags.length ? '⚠风险' : ''}`)
        .join(' ｜ '),
    allocation: [],
    totalWeightPct: 0,
    confidence,
    caveats,
    recommendation,
    kind: 'matrix',
    options: scored,
    recommendedOption: tie ? undefined : top.option,
  };
}

/**
 * 投资配置简报：把实时金融信号转成透明、可复核的仓位方案。
 *
 * 配置规则（全部可解释，非黑箱）：
 *   - 债券（美国10Y）：基准 25%；实时收益率 ≥4.5% 提到 35%（实际利率高、吸引力强），<3% 降到 15%。
 *   - 权益（标普500）：取到实时点位 → 30%；取不到 → 20% 且差额转入现金（信号缺失不敢满仓权益）。
 *   - 黄金 15% / 白银 5%：经典对冲与卫星仓，固定权重。
 *   - 比特币 5%：仅当取到实时价时才给（卫星仓，缺失则移除并警示）。
 *   - 现金（美元）：补足到 100%；并提示当前 USD/CNY 带来的汇率敞口。
 */
function buildAllocationBrief(
  domain: string,
  question: string,
  evidence: ChannelEvidence[],
): DecisionBrief {
  const fx = findCh(evidence, 'fx-usd-cny') ?? findCh(evidence, 'fx-er-api');
  const gold = findCh(evidence, 'gold-xau');
  const silver = findCh(evidence, 'silver-xag');
  const us10y = findCh(evidence, 'us10y');
  const btc = findCh(evidence, 'crypto-btc');
  const sp500 = findCh(evidence, 'sp500');

  const usdCny = val(fx);
  const goldP = val(gold);
  const silverP = val(silver);
  const y10 = val(us10y);
  const btcP = val(btc);
  const sp = val(sp500);

  const caveats: string[] = [];
  const slices: AllocationSlice[] = [];

  // 债券：以实时 10Y 收益率为锚
  let bond = 25;
  if (y10 !== undefined) {
    if (y10 >= 4.5) bond = 35;
    else if (y10 < 3) bond = 15;
  } else {
    caveats.push('未取到实时 10Y 国债收益率，债券仓位按中性 25% 假设，建议接入后复核。');
  }
  slices.push({
    asset: '美国10年期国债',
    code: 'US_TREASURY_10Y',
    weightPct: bond,
    evidenceChannel: 'us10y',
    rationale:
      y10 !== undefined
        ? `实时收益率 ${y10}%（${ts(us10y)}），收益率${y10 >= 4.5 ? '高' : y10 < 3 ? '低' : '中'}估吸引力，按 ${bond}% 配置`
        : `未取到实时收益率，按中性 ${bond}% 配置（假设，待复核）`,
  });

  // 权益：取到实时标普才给满仓
  const equity = sp !== undefined ? 30 : 20;
  if (sp === undefined) {
    caveats.push('未取到实时标普500行情，权益仓位下调至 20%，差额转入现金缓冲；接入后重估。');
  }
  slices.push({
    asset: '标普500指数',
    code: 'EQUITY_SP500',
    weightPct: equity,
    evidenceChannel: sp500 ? 'sp500' : undefined,
    rationale:
      sp !== undefined
        ? `实时点位 ${sp}（${ts(sp500)}），按 ${equity}% 配置`
        : `未取到实时股指，权益仓位降至 ${equity}%，差额转现金`,
  });

  // 黄金：固定对冲权重，必须引用实时价（缺失则警示）
  if (goldP === undefined) caveats.push('未取到实时黄金价，黄金对冲仓位按 15% 假设，建议接入后复核。');
  slices.push({
    asset: '现货黄金',
    code: 'GOLD',
    weightPct: 15,
    evidenceChannel: gold ? 'gold-xau' : undefined,
    rationale:
      goldP !== undefined
        ? `实时价 $${goldP}/oz（${ts(gold)}），作为通胀 / 尾部风险对冲，固定 ${15}%`
        : '实时金价缺失，按 15% 假设对冲仓（待复核）',
  });

  // 白银：卫星仓
  if (silverP === undefined) caveats.push('未取到实时白银价，白银仓位按 5% 假设，建议接入后复核。');
  slices.push({
    asset: '现货白银',
    code: 'SILVER',
    weightPct: 5,
    evidenceChannel: silver ? 'silver-xag' : undefined,
    rationale:
      silverP !== undefined
        ? `实时价 $${silverP}/oz（${ts(silver)}），作为黄金的补充卫星仓，固定 ${5}%`
        : '实时银价缺失，按 5% 假设卫星仓（待复核）',
  });

  // 比特币：仅取到实时价才给卫星仓
  if (btcP !== undefined) {
    slices.push({
      asset: '比特币',
      code: 'BTC',
      weightPct: 5,
      evidenceChannel: 'crypto-btc',
      rationale: `实时价 $${btcP}（${ts(btc)}），高波动卫星仓，固定 ${5}%`,
    });
  } else {
    caveats.push('未取到实时加密行情（CoinGecko 在当前网络不可达），比特币卫星仓移除，权重转入现金。');
  }

  // 现金（美元）：补足到 100%
  const allocated = slices.reduce((s, x) => s + x.weightPct, 0);
  const cashUsd = Math.max(0, 100 - allocated);
  const fxNote =
    usdCny !== undefined
      ? `当前 USD/CNY=${usdCny}（${ts(fx)}），美元资产隐含该汇率敞口`
      : '未取到实时汇率，现金仓位按中性配置';
  slices.push({
    asset: '现金(美元)',
    code: 'CASH_USD',
    weightPct: cashUsd,
    evidenceChannel: fx ? fx.channel : undefined,
    rationale: `流动性缓冲 ${cashUsd}%；${fxNote}`,
  });

  // 置信度：以"可用的实时金融信号数"衡量（FX/黄金/白银/国债/加密/股指 共 6 路）
  const liveSignals = [usdCny, goldP, silverP, y10, btcP, sp].filter((v) => v !== undefined).length;
  const confidence: Confidence = liveSignals >= 5 ? 'high' : liveSignals >= 3 ? 'medium' : 'low';
  if (confidence !== 'high') {
    caveats.push(`实时信号覆盖 ${liveSignals}/6，置信度为「${confidence}」，建议信号更全时再定稿。`);
  }

  const signalSummary = [
    usdCny !== undefined ? `USD/CNY=${usdCny}` : null,
    goldP !== undefined ? `黄金=$${goldP}/oz` : null,
    silverP !== undefined ? `白银=$${silverP}/oz` : null,
    y10 !== undefined ? `美10Y=${y10}%` : null,
    btcP !== undefined ? `BTC=$${btcP}` : null,
    sp !== undefined ? `标普=${sp}` : null,
  ]
    .filter(Boolean)
    .join(' ｜ ');

  const allocText = slices.map((s) => `${s.asset} ${s.weightPct}%`).join(' / ');
  const recommendation = `基于实时信号，建议配置（合计100%）： ${allocText}。${confidence === 'high' ? '' : '信号不足，建议复核后再定稿。'}`;

  return {
    domain,
    question,
    generatedAt: new Date().toISOString(),
    signalSummary: `实时信号：${signalSummary || '（无可用实时金融信号）'}`,
    allocation: slices,
    totalWeightPct: slices.reduce((s, x) => s + x.weightPct, 0),
    confidence,
    caveats,
    recommendation,
    kind: 'allocation',
  };
}

/** 证据时间戳取前 16 字符（YYYY-MM-DDTHH:MM） */
function ts(ev: ChannelEvidence | undefined): string {
  return ev?.capturedAt ? ev.capturedAt.slice(0, 16) : 'n/a';
}
