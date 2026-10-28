/**
 * 执行适配器（Executor）—— 把"裁决通过 + 你授权"的决策真正落地。
 *
 * 关键护栏：执行器只在确认闸门放行之后被调用（deny 永远到不了这里，未确认也到不了）。
 * 因此"真实下单/开户/划转"的安全性来自闸门，而不是执行器本身。
 *
 * 提供两种执行器：
 *   - DryRunExecutor（默认）：只打印执行清单，不发生任何真实副作用；
 *   - WebhookExecutor（需配置）：把已授权的动作 POST 到你控制的端点
 *     （券商/开户系统/Zapier/Make/内部 API），由该端点完成真实下单或开户。
 *
 * 想接具体券商（Alpaca / IBKR / 富途…）时，照 WebhookExecutor 的模板写一个适配器即可，
 * 把它接到你自己的下单 API，然后让 Vigil 只负责"确认后触发"，不碰你的资金凭证。
 */

import type { ActionSpec } from '../types.ts';
import type { DecisionBrief } from './reasoning.ts';

/** 执行器收到的上下文（决策循环在授权后传入） */
export interface ExecutionContext {
  sessionId: string;
  question: string;
  action: ActionSpec;
  costUsd?: number;
  /** 证据驱动裁决得出的配置简报（invest/financing 领域含具体仓位），供券商端点消费 */
  brief?: DecisionBrief;
}

export interface ExecutionResult {
  ok: boolean;
  /** 执行结果说明（会进入账本与事件流） */
  detail: string;
  /** 外部系统返回的单号 / 引用（如券商订单号） */
  externalRef?: string;
  raw?: unknown;
}

export interface ActionExecutor {
  readonly id: string;
  execute(ctx: ExecutionContext): Promise<ExecutionResult>;
}

/**
 * 默认执行器：dry-run，绝不触碰真实系统。
 * 所有对外/不可逆动作在抵达这里之前已通过确认闸门，这里只负责"模拟闭环"并留痕。
 */
export class DryRunExecutor implements ActionExecutor {
  readonly id = 'dry-run';

  async execute(ctx: ExecutionContext): Promise<ExecutionResult> {
    const cost = ctx.costUsd !== undefined ? `（约 $${ctx.costUsd}）` : '';
    return {
      ok: true,
      detail: `dry-run：未执行真实动作「${ctx.action.kind}」${cost}。接入真实执行适配器并确认后才会真正下单/划转。`,
    };
  }
}

/**
 * 真实执行适配器：把已授权的动作 POST 到你控制的 webhook 端点。
 * 该端点背后才是真正的券商/开户/支付系统——Vigil 只负责"确认后触发"，不持有任何资金凭证。
 */
export class WebhookExecutor implements ActionExecutor {
  readonly id = 'webhook';
  private url: string;
  private headers: Record<string, string>;
  constructor(url: string, headers: Record<string, string> = {}) {
    this.url = url;
    this.headers = headers;
  }

  async execute(ctx: ExecutionContext): Promise<ExecutionResult> {
    const payload = {
      sessionId: ctx.sessionId,
      question: ctx.question,
      action: ctx.action,
      costUsd: ctx.costUsd,
      executedAt: new Date().toISOString(),
      intent: 'vigil-confirmed-action',
      decisionBrief: ctx.brief ?? null,
    };
    const res = await fetch(this.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...this.headers },
      body: JSON.stringify(payload),
    });
    if (!res.ok) throw new Error(`执行 webhook HTTP ${res.status}`);
    const raw = (await res.json().catch(() => null)) as unknown;
    const ref = (raw as { id?: string; orderId?: string } | null)?.id
      ?? (raw as { id?: string; orderId?: string } | null)?.orderId;
    return {
      ok: true,
      detail: `已通过 webhook 提交执行「${ctx.action.kind}」${ctx.costUsd !== undefined ? `（约 $${ctx.costUsd}）` : ''}`,
      externalRef: ref,
      raw,
    };
  }
}

/**
 * 按环境变量选择执行器：
 *   VIGIL_EXECUTOR_WEBHOOK   配置后启用 WebhookExecutor（真实触发你自己的下单/开户端点）
 * 未配置 → 默认 DryRunExecutor（只留痕、不落地）。
 */
export function buildExecutor(env: NodeJS.ProcessEnv = process.env): ActionExecutor {
  if (env.VIGIL_EXECUTOR_WEBHOOK) {
    const headers: Record<string, string> = {};
    if (env.VIGIL_EXECUTOR_WEBHOOK_KEY) headers['Authorization'] = `Bearer ${env.VIGIL_EXECUTOR_WEBHOOK_KEY}`;
    return new WebhookExecutor(env.VIGIL_EXECUTOR_WEBHOOK, headers);
  }
  return new DryRunExecutor();
}
