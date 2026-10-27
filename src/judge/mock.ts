import type { Judge } from './index.ts';
import type { JudgeQuestion, Judgment } from '../types.ts';
import { sha256 } from '../util/canonical.ts';

/**
 * 确定性的假判断器。
 *
 * 用途：没有 API key 时跑通全链路、写测试、复现事故。
 * 它对同样的输入永远给出同样的答案 —— 这一点比"像不像模型"重要得多。
 */
export class MockJudge implements Judge {
  readonly name = 'mock';
  #fixed: Record<string, number>;
  #latencyMs: number;

  constructor(options: { fixed?: Record<string, number>; latencyMs?: number } = {}) {
    this.#fixed = options.fixed ?? {};
    this.#latencyMs = options.latencyMs ?? 1;
  }

  async decide(state: string, questions: JudgeQuestion[]): Promise<Judgment[]> {
    if (questions.length === 0) return [];
    if (this.#latencyMs > 0) await new Promise((r) => setTimeout(r, this.#latencyMs));
    return questions.map((q) => this.#one(state, q));
  }

  #one(state: string, q: JudgeQuestion): Judgment {
    const value = this.#unit(state, q.name);
    const judgment: Judgment = { name: q.name, type: q.type, confidence: 0.5, valid: true, latencyMs: this.#latencyMs };

    if (q.type === 'boolean') {
      const p = this.#fixed[q.name] ?? value;
      judgment.probability = p;
      judgment.confidence = Math.max(p, 1 - p);
      judgment.probabilities = { true: p, false: 1 - p };
      return judgment;
    }
    if (q.type === 'choice') {
      const labels = Object.keys(q.criteria ?? { ok: 'ok', bad: 'bad' });
      const index = Math.min(labels.length - 1, Math.floor(value * labels.length));
      judgment.choice = labels[index]!;
      const share = 1 / labels.length;
      judgment.probabilities = Object.fromEntries(
        labels.map((label, i) => [label, i === index ? Math.max(share, 0.55) : (1 - Math.max(share, 0.55)) / Math.max(1, labels.length - 1)]),
      );
      judgment.confidence = Math.max(share, 0.55);
      return judgment;
    }
    const levels = q.scale?.length ?? 5;
    const score = Math.min(levels, 1 + Math.floor(value * levels));
    judgment.score = score;
    judgment.confidence = 0.7;
    return judgment;
  }

  /** 从内容哈希取一个 0..1 的确定值 */
  #unit(state: string, name: string): number {
    const digest = sha256(`${name}::${state}`);
    const slice = parseInt(digest.slice(0, 8), 16);
    return slice / 0xffffffff;
  }
}
