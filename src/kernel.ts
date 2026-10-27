import type {
  DecisionRecord,
  DecisionRequest,
  HardBlock,
  JudgeQuestion,
  Judgment,
  Outcome,
  Verdict,
} from './types.ts';
import { Ledger } from './ledger/store.ts';
import type { Judge } from './judge/index.ts';
import { describeAuthority, requiredAuthority } from './policy/authority.ts';
import { defaultPolicy, grantedAuthority, runRules } from './policy/rules.ts';
import type { PolicyContext, Rule } from './policy/rules.ts';
import { hashObject, shortId } from './util/canonical.ts';

export interface KernelOptions {
  ledger: Ledger;
  judge: Judge;
  policy?: PolicyContext;
  rules?: Rule[];
  /** 全局置信度下限，未在问题上单独声明 floor 时使用 */
  confidenceFloor?: number;
  /** 判断器故障时是否放行。默认 false —— fail-closed 是底线。 */
  failOpen?: boolean;
}

interface GateResult {
  escalate: boolean;
  reasons: string[];
}

/**
 * 监督内核。
 *
 * 一次 decide() 只做四件事，顺序不能换：
 *   1. 从动作形状推导所需授权，与授予对比
 *   2. 跑确定性规则，拿到一票否决项
 *   3. 只在灰区调用概率模型，且只接受类型化答案
 *   4. 合成结论并落账
 *
 * 关键取舍：概率模型永远没有"否决权"，也没有"放行权"。
 * 它只能让一个本来会放行的动作变成需要人看。否决只来自确定性规则。
 */
export class Kernel {
  #ledger: Ledger;
  #judge: Judge;
  #policy: PolicyContext;
  #rules: Rule[];
  #confidenceFloor: number;
  #failOpen: boolean;

  constructor(options: KernelOptions) {
    this.#ledger = options.ledger;
    this.#judge = options.judge;
    this.#policy = options.policy ?? defaultPolicy();
    this.#rules = options.rules ?? [];
    this.#confidenceFloor = options.confidenceFloor ?? 0.7;
    this.#failOpen = options.failOpen ?? false;
  }

  get ledger(): Ledger {
    return this.#ledger;
  }

  get judgeName(): string {
    return this.#judge.name;
  }

  async decide(req: DecisionRequest): Promise<Verdict> {
    const ctx: PolicyContext = {
      ...this.#policy,
      sessionSpendUsd: this.#ledger.sessionSpend(req.sessionId),
    };

    const required = requiredAuthority(req.action);
    const granted = grantedAuthority(req.actor, ctx);

    const hardBlocks: HardBlock[] = runRules(req, ctx, this.#rules.length > 0 ? this.#rules : undefined);

    const { judgments, judgeError } = await this.#runJudge(req);
    const gate = this.#evaluateGate(req.questions ?? [], judgments);

    const reasons: string[] = [];
    let outcome: Outcome = 'allow';

    const denial = hardBlocks.find((b) => b.severity === 'deny');
    const escalations = hardBlocks.filter((b) => b.severity === 'escalate');

    if (denial) {
      outcome = 'deny';
      reasons.push(`硬规则否决：${denial.detail}`);
    }

    if (required > granted) {
      if (outcome !== 'deny') outcome = 'require_human';
      reasons.push(
        `授权不足：动作需要 ${describeAuthority(required)}，${req.actor} 仅持有 ${describeAuthority(granted)}`,
      );
    }

    if (escalations.length > 0) {
      if (outcome !== 'deny') outcome = 'require_human';
      for (const block of escalations) reasons.push(`需要人工：${block.detail}`);
    }

    if (judgeError) {
      if (outcome !== 'deny') outcome = this.#failOpen ? outcome : 'require_human';
      reasons.push(`判断器异常（${judgeError}），按 fail-closed 处理`);
    }

    if (gate.escalate) {
      if (outcome !== 'deny') outcome = 'require_human';
      reasons.push(...gate.reasons);
    }

    if (reasons.length === 0) {
      reasons.push(`通过 ${hardBlocks.length === 0 ? '确定性规则' : '剩余规则'}，授权 ${describeAuthority(granted)} 足够`);
    }

    const decisionId = shortId('dec');
    const record = this.#ledger.append({
      decisionId,
      ts: new Date().toISOString(),
      sessionId: req.sessionId,
      actor: req.actor,
      intent: req.intent,
      action: req.action,
      required,
      granted,
      hardBlocks,
      judgments,
      outcome,
      evidenceIds: (req.evidence ?? []).map((e) => e.id),
      evidenceHash: hashObject(req.evidence ?? []),
      // 被拦下的动作没有真正发生，不该计入会话支出
      costUsd: outcome === 'allow' ? (req.costUsd ?? 0) : 0,
    });

    return {
      decisionId,
      outcome,
      required,
      granted,
      hardBlocks,
      judgments,
      reason: reasons.join('；'),
      recordHash: record.hash,
      seq: record.seq,
    };
  }

  async #runJudge(req: DecisionRequest): Promise<{ judgments: Judgment[]; judgeError?: string }> {
    const questions = req.questions ?? [];
    if (questions.length === 0) return { judgments: [] };
    const state = req.state ?? `${req.intent}\n${JSON.stringify(req.action)}`;
    try {
      const judgments = await this.#judge.decide(state, questions);
      return { judgments };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        judgments: questions.map((q) => ({
          name: q.name,
          type: q.type,
          confidence: 0,
          valid: false,
          error: message,
        })),
        judgeError: message,
      };
    }
  }

  #evaluateGate(questions: JudgeQuestion[], judgments: Judgment[]): GateResult {
    const reasons: string[] = [];
    let escalate = false;

    for (const judgment of judgments) {
      const question = questions.find((q) => q.name === judgment.name);
      if (!question) continue;
      if (question.gating === false) continue;

      if (!judgment.valid) {
        escalate = true;
        reasons.push(`判断「${question.name}」返回不可用（${judgment.error ?? '格式异常'}）`);
        continue;
      }

      const floor = question.floor ?? this.#confidenceFloor;

      if (judgment.type === 'boolean') {
        const p = judgment.probability ?? 0.5;
        if (question.escalateWhenTrue) {
          if (p >= floor) {
            escalate = true;
            reasons.push(`判断「${question.name}」命中风险（p=${p.toFixed(2)} ≥ ${floor}）`);
          }
        } else if (p < floor) {
          escalate = true;
          reasons.push(`判断「${question.name}」把握不足（p=${p.toFixed(2)} < ${floor}）`);
        }
      } else if (judgment.type === 'choice') {
        if (question.escalateIf?.includes(judgment.choice ?? '')) {
          escalate = true;
          reasons.push(`判断「${question.name}」选择了需人工的选项：${judgment.choice}`);
        } else if (judgment.confidence < floor) {
          escalate = true;
          reasons.push(`判断「${question.name}」置信度不足（${judgment.confidence.toFixed(2)} < ${floor}）`);
        }
      } else if (judgment.type === 'score') {
        const score = judgment.score ?? 0;
        if (question.escalateIfBelow !== undefined && score < question.escalateIfBelow) {
          escalate = true;
          reasons.push(`判断「${question.name}」评分过低（${score} < ${question.escalateIfBelow}）`);
        }
      }
    }

    return { escalate, reasons };
  }
}
