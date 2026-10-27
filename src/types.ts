/**
 * Vigil 的核心类型。
 *
 * 设计前提：一个"决定"（Decision）不是一条日志，也不是一个 span。
 * 它是一次带责任归属的判断，必须能被拦截、被追溯、被事后校准。
 * 所以这里的每个类型都围绕这三个动作设计。
 */

/**
 * 五级授权阶梯。数字越大，破坏面越大。
 *
 * 相对原方案做了一处调整：把"不可逆"和"对外"合并到 L3，把钱单独提到 L4。
 * 理由是内网删库和对外发信一旦发生都收不回来，破坏半径相近；
 * 而钱出去了就是出去了，没有任何技术手段能挽回，必须独占一级。
 */
export type AuthorityLevel = 0 | 1 | 2 | 3 | 4;

export const AUTHORITY_LABELS: Record<AuthorityLevel, string> = {
  0: 'read_only',
  1: 'draft',
  2: 'reversible_write',
  3: 'external_or_irreversible',
  4: 'money',
};

/** 证据。没有证据的"已完成"一律不放行。 */
export interface Evidence {
  id: string;
  /** 谁产出的这份证据。用于"研究员不能批自己的卷子"。 */
  producedBy: string;
  /** 这份证据支持的结论 */
  claim?: string;
  /** 是否已经过独立核验 */
  verified?: boolean;
  uri?: string;
}

/** 一个动作的具体形状。硬规则只看这个结构，不看自然语言。 */
export interface ActionSpec {
  kind: string;
  target?: string;
  payload?: unknown;
  /** 是否可逆。删除、支付、对外发送通常不可逆。 */
  reversible: boolean;
  /** 是否离开本机信任边界 */
  external: boolean;
  moneyUsd?: number;
}

export type QuestionType = 'choice' | 'score' | 'boolean';

/** 丢给概率判断模型的类型化问题。它只能在这些选项里选，无法越权生成。 */
export interface JudgeQuestion {
  name: string;
  type: QuestionType;
  instructions: string;
  /** choice 类型的可选标签 */
  criteria?: Record<string, string>;
  /** score 类型的档位描述，从低到高 */
  scale?: string[];
  /** 低于该值即升级人工。boolean 比概率，choice/score 比置信度。 */
  floor?: number;
  /** 是否参与放行判定。false 表示只记录不拦截。 */
  gating?: boolean;
  /** choice：命中这些标签就升级人工 */
  escalateIf?: string[];
  /** score：低于该分就升级人工 */
  escalateIfBelow?: number;
  /**
   * boolean 的方向。默认 false，表示"概率高 = 可以继续"（例如"是否应当放行"）。
   * 置为 true 表示"概率高 = 有问题"（例如"是否存在商业承诺风险"）。
   */
  escalateWhenTrue?: boolean;
}

export interface Judgment {
  name: string;
  type: QuestionType;
  choice?: string;
  score?: number;
  /** boolean 为真的概率 */
  probability?: number;
  probabilities?: Record<string, number>;
  /** 模型自报的置信度 */
  confidence: number;
  /** false 表示返回格式不可用，按 fail-closed 处理 */
  valid: boolean;
  error?: string;
  latencyMs?: number;
}

/** 确定性规则命中。这条链路里唯一的"必拦"来源。 */
export interface HardBlock {
  rule: string;
  severity: 'deny' | 'escalate';
  detail: string;
}

export type Outcome = 'allow' | 'require_human' | 'deny';

export interface DecisionRequest {
  sessionId: string;
  /** 谁在做这个决定 */
  actor: string;
  /** 它自己说想干什么 */
  intent: string;
  action: ActionSpec;
  evidence?: Evidence[];
  /** 交给概率模型判断的原始材料 */
  state?: string;
  questions?: JudgeQuestion[];
  /** 本次动作产生的成本，用于会话预算核算 */
  costUsd?: number;
}

export interface Verdict {
  decisionId: string;
  outcome: Outcome;
  /** 动作本身要求的授权等级 */
  required: AuthorityLevel;
  /** 该 actor 实际被授予的等级 */
  granted: AuthorityLevel;
  hardBlocks: HardBlock[];
  judgments: Judgment[];
  reason: string;
  recordHash: string;
  seq: number;
}

export type OutcomeLabel = 'correct' | 'wrong' | 'unknown';

/** 账本里的一条决定记录。哈希链保证不可篡改。 */
export interface DecisionRecord {
  seq: number;
  decisionId: string;
  ts: string;
  sessionId: string;
  actor: string;
  intent: string;
  action: ActionSpec;
  required: AuthorityLevel;
  granted: AuthorityLevel;
  hardBlocks: HardBlock[];
  judgments: Judgment[];
  outcome: Outcome;
  evidenceIds: string[];
  /** 证据内容的指纹。事后可验证当时依据有没有被换掉。 */
  evidenceHash: string;
  costUsd: number;
  prevHash: string;
  hash: string;
  /** 事后回填的标签，默认为 unknown */
  label: OutcomeLabel;
  labelNote?: string;
  labelTs?: string;
}
