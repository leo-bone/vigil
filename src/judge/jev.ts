import type { Judge } from './index.ts';
import type { JudgeQuestion, Judgment, QuestionType } from '../types.ts';

export interface JevOptions {
  apiKey: string;
  model?: string;
  baseUrl?: string;
  timeoutMs?: number;
  retries?: number;
}

interface RawAnswer {
  type?: string;
  choice?: string;
  score?: number;
  probability?: number;
  probabilities?: Record<string, number>;
  confidence?: number;
}

/** 内部分类 → Jev 线上类型。内部用 boolean，线上叫 noul。 */
function toWireType(type: QuestionType): string {
  if (type === 'boolean') return 'noul';
  return type;
}

function pickProbability(answer: RawAnswer): number | undefined {
  if (typeof answer.probability === 'number') return answer.probability;
  const table = answer.probabilities;
  if (!table) return undefined;
  if (typeof table.true === 'number') return table.true;
  if (typeof table.yes === 'number') return table.yes;
  if (typeof table.supported === 'number') return table.supported;
  return undefined;
}

function pickConfidence(answer: RawAnswer): number {
  if (typeof answer.confidence === 'number') return answer.confidence;
  const table = answer.probabilities;
  if (table) {
    const values = Object.values(table).filter((v) => typeof v === 'number');
    if (values.length > 0) return Math.max(...values);
  }
  return 0.5;
}

/**
 * TypeSafe Jev 适配层。
 *
 * 三条纪律：
 * 1. 只发送类型化问题，从不索取自由文本 —— 模型在结构上就无法越权。
 * 2. 任何格式异常都判无效（valid=false），由内核按 fail-closed 升级人工。
 * 3. 只对 408/409/429/5xx 重试，避免不确定的重复计费。
 */
export class JevJudge implements Judge {
  readonly name = 'jev';
  #apiKey: string;
  #model: string;
  #baseUrl: string;
  #timeoutMs: number;
  #retries: number;

  constructor(options: JevOptions) {
    this.#apiKey = options.apiKey;
    this.#model = options.model ?? 'jev-latest';
    this.#baseUrl = options.baseUrl ?? 'https://api.typesafe.ai/v1/systemone';
    this.#timeoutMs = options.timeoutMs ?? 15000;
    this.#retries = options.retries ?? 2;
  }

  async decide(state: string, questions: JudgeQuestion[]): Promise<Judgment[]> {
    if (questions.length === 0) return [];
    const payload: Record<string, unknown> = {};
    for (const q of questions) {
      const entry: Record<string, unknown> = {
        type: toWireType(q.type),
        instructions: q.instructions,
      };
      if (q.criteria) entry.criteria = q.criteria;
      if (q.scale) entry.scale = q.scale;
      payload[q.name] = entry;
    }

    const started = Date.now();
    const raw = await this.#post({ model: this.#model, state, questions: payload });
    const latencyMs = Date.now() - started;
    const answers = (raw.answers ?? {}) as Record<string, RawAnswer>;

    return questions.map((q) => {
      const answer = answers[q.name];
      if (!answer) {
        return this.#invalid(q, '模型未返回该问题的答案', latencyMs);
      }
      const judgment: Judgment = {
        name: q.name,
        type: q.type,
        confidence: pickConfidence(answer),
        valid: true,
        latencyMs,
      };
      if (q.type === 'boolean') {
        const p = pickProbability(answer);
        if (typeof p !== 'number' || Number.isNaN(p)) return this.#invalid(q, 'boolean 缺少概率值', latencyMs);
        judgment.probability = p;
      } else if (q.type === 'choice') {
        if (typeof answer.choice !== 'string') return this.#invalid(q, 'choice 缺少选项值', latencyMs);
        judgment.choice = answer.choice;
        if (answer.probabilities) judgment.probabilities = answer.probabilities;
      } else {
        if (typeof answer.score !== 'number') return this.#invalid(q, 'score 缺少分数值', latencyMs);
        judgment.score = answer.score;
        if (answer.probabilities) judgment.probabilities = answer.probabilities;
      }
      return judgment;
    });
  }

  #invalid(q: JudgeQuestion, error: string, latencyMs: number): Judgment {
    return { name: q.name, type: q.type, confidence: 0, valid: false, error, latencyMs };
  }

  async #post(body: unknown): Promise<{ answers?: Record<string, RawAnswer> }> {
    let lastError: unknown = null;
    for (let attempt = 0; attempt <= this.#retries; attempt += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.#timeoutMs);
      try {
        const response = await fetch(this.#baseUrl, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${this.#apiKey}`,
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
        if (!response.ok) {
          const retryable = [408, 409, 429, 500, 502, 503, 504, 529].includes(response.status);
          const text = await response.text();
          if (!retryable || attempt === this.#retries) {
            throw new Error(`Jev 返回 ${response.status}：${text.slice(0, 200)}`);
          }
          lastError = new Error(`Jev 返回 ${response.status}`);
          await this.#backoff(attempt);
          continue;
        }
        return (await response.json()) as { answers?: Record<string, RawAnswer> };
      } catch (error) {
        lastError = error;
        const isAbort = error instanceof Error && error.name === 'AbortError';
        if (attempt === this.#retries) break;
        if (isAbort) {
          await this.#backoff(attempt);
          continue;
        }
        // 网络层不确定失败不重试，避免重复计费
        throw error;
      } finally {
        clearTimeout(timer);
      }
    }
    throw lastError instanceof Error ? lastError : new Error('Jev 调用失败');
  }

  async #backoff(attempt: number): Promise<void> {
    const delay = 250 * 2 ** attempt + Math.random() * 100;
    await new Promise((resolve) => setTimeout(resolve, delay));
  }
}
