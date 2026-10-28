import type { Kernel } from '../kernel.ts';
import type { ActionSpec, AuthorityLevel, Evidence, Verdict } from '../types.ts';
import { grantedAuthority } from '../policy/rules.ts';
import type { PolicyContext } from '../policy/rules.ts';
import type { DecisionBrief } from '../loop/reasoning.ts';

/**
 * 冲突仲裁（Arbiter）。
 *
 * 多个 agent 对同一件事给出相反结论时，谁说了算？
 * 这个问题的答案不能靠"再问一次模型" —— 那只是把分歧往后推。
 * 所以仲裁的阶梯是固定的，模型只出现在最后一步，且只能做选择不能造结论：
 *
 *   1. 立场一致            → 直接采纳，没有争议
 *   2. 同一个 agent 的多个立场 → 取最严格的那个（它自己改主意不算数，取最保守的）
 *   3. 动作本身触红线      → 否决。硬规则压过一切，包括全票同意
 *   4. 有"否决"立场：
 *      a. 它有独立核验证据而对方没有 → 采信否决（证据优势）
 *      b. 它的授权等级严格高于对方     → 采信否决（权级）
 *      c. 分不出高下                    → 升级人工（deny_unresolved）
 *   5. 没有"否决"立场，只是"可以继续"与"需要人看"打架 → 模型排序，达门槛才放行
 *
 * 第 4c 条是这套设计的骨头：**一条没被驳倒的否决立场，永远不会被自动放行。**
 * 模型没有权力把 deny 变成 allow，它只能帮你在"都同意放行"和"需要人看"之间排序。
 */

export const ARBITER = 'vigil/arbiter';

export type Conclusion = 'allow' | 'deny' | 'require_human';

export interface Position {
  /** 提出这个结论的 agent */
  actor: string;
  conclusion: Conclusion;
  /** 给出理由 —— 仲裁记录里必须留着 */
  reason: string;
  /** 支撑这个立场的证据 */
  evidence?: Evidence[];
  /** 显式指定授权等级；不填则按策略里这个 actor 的授权算 */
  authority?: AuthorityLevel;
}

/** 仲裁走过的哪一级阶梯 */
export type Resolution =
  | 'unanimous_allow'
  | 'unanimous_deny'
  | 'unanimous_human'
  | 'deny_evidence'
  | 'deny_authority'
  | 'deny_unresolved'
  | 'model_tiebreak';

export interface ArbitrationInput {
  sessionId: string;
  taskId?: string;
  /** 争议的是什么 */
  question: string;
  /** 各方的立场 */
  positions: Position[];
  /** 被争议的动作形状。硬规则照常对它跑：全票同意也绕不过禁止清单 */
  action: ActionSpec;
  /** 强制升级，跳过模型排序 */
  forceEscalation?: boolean;
  /** 证据驱动裁决得出的配置简报（invest/financing 领域含具体仓位），透传到账本与执行 */
  brief?: DecisionBrief;
}

export interface ArbitrationResult {
  /** 最终结论。与内核裁决一致 —— 账本上写的就是它 */
  decision: 'allow' | 'require_human' | 'deny';
  /** 走的是哪一级阶梯 */
  resolution: Resolution;
  /** 被采信的立场 */
  winner?: Position;
  /** 被压下的立场 */
  overruled: Position[];
  /** 人能读懂的仲裁理由 */
  reason: string;
  /** 是否动用了概率排序 */
  usedJudge: boolean;
  /** 落账的裁决 */
  verdict: Verdict;
}

/** 严格程度：同一 agent 改主意时取最保守的那个 */
const STRICTNESS: Record<Conclusion, number> = {
  allow: 0,
  require_human: 1,
  deny: 2,
};

function normalize(positions: Position[], policy: PolicyContext): Position[] {
  const byActor = new Map<string, Position>();
  for (const position of positions) {
    const authority = position.authority ?? grantedAuthority(position.actor, policy);
    const enriched: Position = { ...position, authority };
    const existing = byActor.get(position.actor);
    if (!existing) {
      byActor.set(position.actor, enriched);
      continue;
    }
    // 同一个 agent 给出多个立场：取更严格的那个
    if (STRICTNESS[enriched.conclusion] > STRICTNESS[existing.conclusion]) {
      byActor.set(position.actor, enriched);
    } else if (enriched.conclusion === existing.conclusion) {
      byActor.set(position.actor, { ...enriched, evidence: [...(existing.evidence ?? []), ...(enriched.evidence ?? [])] });
    }
  }
  return [...byActor.values()];
}

function hasVerifiedEvidence(position: Position): boolean {
  return (position.evidence ?? []).some((item) => item.verified === true);
}

function mergeEvidence(positions: Position[]): Evidence[] {
  const seen = new Map<string, Evidence>();
  for (const position of positions) {
    for (const item of position.evidence ?? []) {
      if (!seen.has(item.id)) seen.set(item.id, item);
    }
  }
  return [...seen.values()];
}

function topBy<T>(items: T[], score: (item: T) => number): T {
  return items.reduce((best, item) => (score(item) > score(best) ? item : best));
}

/**
 * 走一遍仲裁阶梯，得出该走哪条路。
 * 纯函数，不碰内核 —— 便于单独测试和复盘。
 *
 * 返回的 positions 是归一化之后的立场：同一个 agent 的多个立场只留最严格的那个。
 */
export function resolveArbitration(
  rawPositions: Position[],
  policy: PolicyContext,
  forceEscalation = false,
): {
  resolution: Resolution;
  winner?: Position;
  detail: string;
  positions: Position[];
} {
  const positions = normalize(rawPositions, policy);
  if (positions.length === 0) throw new Error('没有立场，无法仲裁');

  const conclusions = new Set(positions.map((position) => position.conclusion));
  if (conclusions.size === 1) {
    const only = positions[0]!.conclusion;
    const resolution: Resolution =
      only === 'allow' ? 'unanimous_allow' : only === 'deny' ? 'unanimous_deny' : 'unanimous_human';
    return {
      resolution,
      winner: positions[0],
      detail: `各方结论一致（${only}），无争议`,
      positions,
    };
  }

  const denies = positions.filter((position) => position.conclusion === 'deny');
  if (denies.length > 0) {
    // 证据优势：否决方有独立核验证据，而反对方没有
    const denyWithEvidence = denies.find(hasVerifiedEvidence);
    const otherWithEvidence = positions.some(
      (position) => position.conclusion !== 'deny' && hasVerifiedEvidence(position),
    );
    if (denyWithEvidence && !otherWithEvidence) {
      return {
        resolution: 'deny_evidence',
        winner: denyWithEvidence,
        detail: `否决方 ${denyWithEvidence.actor} 有独立核验证据而反对方没有，采信否决`,
        positions,
      };
    }

    // 权级：否决方授权严格更高
    const topDeny = topBy(denies, (position) => position.authority ?? 0);
    const others = positions.filter((position) => position.conclusion !== 'deny');
    const topOther = topBy(others, (position) => position.authority ?? 0);
    if ((topDeny.authority ?? 0) > (topOther.authority ?? 0)) {
      return {
        resolution: 'deny_authority',
        winner: topDeny,
        detail: `否决方 ${topDeny.actor} 授权 L${topDeny.authority} 高于反对方 L${topOther.authority}，采信否决`,
        positions,
      };
    }

    // 分不出高下：一条没被驳倒的否决立场，不能靠投票推翻
    return {
      resolution: 'deny_unresolved',
      detail: `存在否决立场（${denies.map((p) => p.actor).join('、')}），但证据与权级无法区分谁对，交人工裁决`,
      positions,
    };
  }

  if (forceEscalation) {
    return { resolution: 'deny_unresolved', detail: '调用方要求强制升级', positions };
  }

  // 只剩"可以继续"与"需要人看"打架：这才是模型该出手的灰区
  return {
    resolution: 'model_tiebreak',
    detail: '无否决立场，冲突在"可以继续"与"需要人看"之间，交由概率模型排序',
    positions,
  };
}

/**
 * 执行仲裁。
 *
 * 走的是一次完整的内核裁决：硬规则先跑，模型只在灰区出场，结论落同一本账。
 * 所以仲裁记录和普通决策记录无法区分 —— 这正是要的：仲裁也是一次决定。
 */
export async function arbitrate(kernel: Kernel, input: ArbitrationInput): Promise<ArbitrationResult> {
  const policy = kernel.policy;
  const resolution = resolveArbitration(input.positions, policy, input.forceEscalation);
  const positions = resolution.positions;

  const questions =
    resolution.resolution === 'model_tiebreak'
      ? [
          {
            name: 'proceed',
            type: 'boolean' as const,
            instructions:
              '两方对同一件事给出不同结论，且都没有否决立场。评估是否应当采信「可以继续」这一方，' +
              '还是应当转人工处理。',
            floor: 0.75,
          },
        ]
      : [];

  const state = [
    `争议：${input.question}`,
    ...positions.map(
      (position) =>
        `- ${position.actor}（授权 L${position.authority}）主张「${position.conclusion}」：${position.reason}`,
    ),
  ].join('\n');

  const verdict = await kernel.decide({
    sessionId: input.sessionId,
    actor: ARBITER,
    intent: `仲裁：${input.question}`,
    action: input.action,
    evidence: mergeEvidence(positions),
    state,
    questions,
    extras: {
      arbitration: {
        resolution: resolution.resolution,
        detail: resolution.detail,
        positions: positions.map((position) => ({
          actor: position.actor,
          conclusion: position.conclusion,
          reason: position.reason,
          authority: position.authority,
        })),
      },
      decisionBrief: input.brief ?? null,
    },
  });

  const decision = verdict.outcome;
  let winner = resolution.winner;
  let overruled: Position[] = [];

  if (resolution.resolution === 'model_tiebreak') {
    const permissive = positions.find((position) => position.conclusion === 'allow');
    const cautious = positions.find((position) => position.conclusion === 'require_human');
    winner = decision === 'allow' ? permissive : cautious;
    overruled = positions.filter((position) => position !== winner);
  } else if (winner) {
    overruled = positions.filter((position) => position !== winner);
  }

  return {
    decision,
    resolution: resolution.resolution,
    winner,
    overruled,
    reason: `${resolution.detail}；内核裁决：${verdict.reason}`,
    usedJudge: questions.length > 0,
    verdict,
  };
}
