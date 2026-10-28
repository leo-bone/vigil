/**
 * 证据渠道分类。
 *
 * 首轮买 MacBook Neo 翻车的根因：只查了官方/电商线上价，漏掉 国补/学生补贴/线下/以旧换新，
 * 于是基于 5499 的线上价误判"超预算否决"。
 *
 * 所以决策前必须把所有相关渠道类都跑到，缺一类就禁止裁决——
 * 这是"证据必须真实完整"这条需求的工程落地。
 */
export const CHANNEL_CLASSES = [
  'official', // 品牌官网 / 直营
  'ecommerce', // 天猫 / 京东等线上电商
  'education', // 教育优惠
  'national_subsidy', // 国补
  'student_subsidy', // 学生补贴
  'offline', // 线下授权店
  'trade_in', // 以旧换新
  'other',
] as const;

export type ChannelClass = (typeof CHANNEL_CLASSES)[number];

export interface ChannelEvidence {
  channel: ChannelClass;
  source: string;
  /** 该渠道实付价（如适用，单位 RMB） */
  priceRMB?: number;
  /** 是否已独立核验 */
  verified: boolean;
  note?: string;
}

export interface EvidenceSpec {
  /** 该决策类型必须覆盖的渠道类；缺一类即禁止裁决 */
  required: ChannelClass[];
}

export function checkCompleteness(
  evidence: ChannelEvidence[],
  spec: EvidenceSpec,
): { complete: boolean; missing: ChannelClass[] } {
  const covered = new Set(evidence.map((item) => item.channel));
  const missing = spec.required.filter((channel) => !covered.has(channel));
  return { complete: missing.length === 0, missing };
}

/** 购买类决策的默认证据规格：必须覆盖全部价格相关渠道 */
export const PURCHASE_EVIDENCE_SPEC: EvidenceSpec = {
  required: [
    'official',
    'ecommerce',
    'education',
    'national_subsidy',
    'student_subsidy',
    'offline',
    'trade_in',
  ],
};
