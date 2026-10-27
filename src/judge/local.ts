import { JevJudge } from './jev.ts';

/**
 * 本地决策模型适配器。
 *
 * 2026 年 10 月起，"只出概率不出文本"的决策模型不再只有闭源 Jev：
 * AWS Strands Decider 2B、Laya、Kev 都提供本地 HTTP 服务，
 * 且都说 /v1/systemone 方言（strands-decider serve 即起服务）。
 *
 * LocalJudge = 同一套线上协议 + 本地地址 + 无鉴权。
 * 意义：灰区判断从"花钱调用闭源 API"变成"本机几十毫秒、零成本、数据不出门"，
 * 而且可以对 strands-decider 用你自己的标注数据微调后再挂上来。
 *
 * 启动本地服务（示例）：
 *   pip install strands-decider && strands-decider serve <model-id> --port 8000
 */
export class LocalJudge extends JevJudge {
  /** 判断器名字进账本，本地模型和云端的 Jev 要能区分开 */
  readonly name = 'local' as const;

  constructor(options: { baseUrl?: string; model?: string; timeoutMs?: number } = {}) {
    super({
      baseUrl: options.baseUrl ?? 'http://127.0.0.1:8000/v1/systemone',
      model: options.model ?? 'local-decider',
      timeoutMs: options.timeoutMs ?? 5000,
      retries: 1, // 本地服务不值得反复重试，fail-closed 更干脆
    });
  }
}
