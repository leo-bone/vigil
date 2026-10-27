import type { JudgeQuestion, Judgment } from '../types.ts';

/**
 * 概率判断模型的抽象。
 *
 * 内核只依赖这个接口，不依赖 Jev。这样换模型不用改内核，
 * 也方便在没有 API key 的环境里用 MockJudge 跑通全链路。
 */
export interface Judge {
  readonly name: string;
  decide(state: string, questions: JudgeQuestion[]): Promise<Judgment[]>;
}
