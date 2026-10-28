/**
 * 证据维度与决策领域注册表。
 *
 * 这一层把 Vigil 从"只会买电脑的决策器"升级为"覆盖人一生的决策系统"：
 * 衣食住行、工作、购物、旅行、融资、医疗、教育…… 每个领域都定义清楚——
 * 要下一个负责任的结论，必须先把哪些证据维度跑全。
 *
 * 维度是通用词汇（跨领域复用），领域只是从中挑选"本决策必备"的子集。
 * 缺任一必备维度 = 证据不完整 = 禁止裁决（这正是首轮漏国补翻车的根治）。
 */

/** 跨领域通用的证据维度词汇表 */
export const EVIDENCE_DIMENSIONS = [
  'authoritative', // 官方/权威来源：政策、法规、官方定价、官方指南、官方数据
  'market', // 市场/商业：价格、供应、竞品、行情、渠道比价
  'peer', // 用户/社群真实经验：口碑、踩坑、长期持有反馈
  'expert', // 专业人士/专家：医生、律师、行业人士、顾问、在职者
  'regulatory', // 合规/政策/资质：牌照、认证、补贴、入学/入境政策、法律风险
  'financial', // 成本/财务影响：总拥有成本、隐性费用、现金流、利率、报销
  'risk', // 风险/安全：健康、安全、退出成本、爆雷、诈骗、副作用
  'alternative', // 替代方案对比：更好 / 更便宜 / 更稳 / 更合规的选择
] as const;

export type EvidenceDimension = (typeof EVIDENCE_DIMENSIONS)[number];

export interface ChannelEvidence {
  channel: EvidenceDimension;
  source: string;
  /** 该维度关联的实付价/成本（如适用，单位 RMB） */
  priceRMB?: number;
  /** 是否已独立核验 */
  verified: boolean;
  note?: string;
}

export interface EvidenceSpec {
  /** 该决策类型必须覆盖的证据维度；缺一类即禁止裁决 */
  required: EvidenceDimension[];
  /** 软提示：这些维度即使出现也不算证据（如医疗/融资领域排除"商业推销一面之词"） */
  excludeHint?: EvidenceDimension[];
}

export interface CompletenessOptions {
  /** 为 true 时，必备维度若未 verified 也视为缺失（强制"真实"而不只是"有"） */
  requireVerified?: boolean;
}

/**
 * 证据完整性校验：按决策规格检查必备维度是否全跑到。
 * requireVerified 为 true 时，覆盖了但没核验的维度也算缺失 —— 强制"真实完整"。
 */
export function checkCompleteness(
  evidence: ChannelEvidence[],
  spec: EvidenceSpec,
  opts: CompletenessOptions = {},
): { complete: boolean; missing: EvidenceDimension[] } {
  const covered = new Map<EvidenceDimension, boolean>();
  for (const item of evidence) {
    const existing = covered.get(item.channel);
    // 同一维度多条证据：只要有一条 verified 即算已核验
    covered.set(item.channel, existing === true ? true : item.verified);
  }
  const missing = spec.required.filter((dim) => {
    const mark = covered.get(dim);
    if (mark === undefined) return true; // 根本没覆盖
    if (opts.requireVerified && mark === false) return true; // 覆盖了但没核验
    return false;
  });
  return { complete: missing.length === 0, missing };
}

export interface DomainSpec {
  label: string;
  description: string;
  required: EvidenceDimension[];
  excludeHint?: EvidenceDimension[];
}

/**
 * 决策领域注册表 —— 覆盖人一生的衣食住行与工作、购物、旅行、融资、医疗、教育。
 * 想加新领域（保险/婚恋/移民/养老…），往这里加一项即可，闸门自动生效。
 */
export const DECISION_DOMAINS: Record<string, DomainSpec> = {
  purchase: {
    label: '购物消费',
    description: '买设备 / 家电 / 数码等有形商品',
    required: ['authoritative', 'market', 'regulatory', 'financial', 'alternative', 'peer'],
  },
  medical: {
    label: '医疗健康',
    description: '就医 / 用药 / 治疗 / 体检方案',
    required: ['authoritative', 'expert', 'regulatory', 'risk', 'financial', 'alternative'],
    excludeHint: ['market'], // 商业推销不算证据
  },
  education: {
    label: '教育升学',
    description: '升学 / 择校 / 专业 / 培训 / 留学',
    required: ['authoritative', 'expert', 'regulatory', 'financial', 'alternative', 'risk'],
  },
  travel: {
    label: '旅行出行',
    description: '机票 / 住宿 / 路线 / 签证 / 目的地',
    required: ['authoritative', 'market', 'regulatory', 'risk', 'financial', 'alternative'],
  },
  financing: {
    label: '融资理财',
    description: '借贷 / 投资 / 筹款 / 保险',
    required: ['authoritative', 'regulatory', 'financial', 'risk', 'expert', 'alternative'],
    excludeHint: ['market'], // 推销方一面之词不算证据
  },
  work: {
    label: '求职职业',
    description: 'Offer / 跳槽 / 创业 / 职业发展',
    required: ['authoritative', 'expert', 'financial', 'risk', 'alternative', 'regulatory'],
  },
  housing: {
    label: '居住置业',
    description: '购房 / 租房 / 装修 / 地段',
    required: ['authoritative', 'market', 'regulatory', 'financial', 'risk', 'alternative'],
  },
};

/** 把领域 key 解析成证据规格；未知领域抛错并列出已支持项 */
export function resolveDomainSpec(key: string): EvidenceSpec {
  const domain = DECISION_DOMAINS[key];
  if (!domain) {
    throw new Error(`未知决策领域：${key}（已支持：${Object.keys(DECISION_DOMAINS).join(' / ')}）`);
  }
  return { required: domain.required, excludeHint: domain.excludeHint };
}

/** 列出所有支持的决策领域（供 `vigil domains` 与文档使用） */
export function listDomains(): Array<DomainSpec & { key: string }> {
  return Object.entries(DECISION_DOMAINS).map(([key, d]) => ({ key, ...d }));
}

/** 向后兼容别名：购买类决策默认证据规格 */
export const PURCHASE_EVIDENCE_SPEC = resolveDomainSpec('purchase');
