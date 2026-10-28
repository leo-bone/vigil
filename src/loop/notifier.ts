/**
 * 推送通道（Notifier）—— 把"实时知道"从拉（vigil loop --watch 回看）变成推（主动推送）。
 *
 * 决策循环每发射一个事件（goal_received → evidence → decision → gate → execute …），
 * 事件总线在落盘的同时会把事件推送到已配置的通道：
 *   - 企业微信（群机器人 webhook）
 *   - 通用 webhook（飞书 / Slack / Discord / 任何能收 JSON 的服务）
 *   - 邮件 API（Resend / Mailgun / SendGrid 等，JSON POST）
 *
 * 设计原则（与证据层一致，诚实不假推送）：
 *   - 没有配置任何通道时，bus 不推送（不假装已通知），仍照常落盘供 --watch 回看；
 *   - 推送失败只记录、不阻断决策循环（推送是旁路，不能因为企微抖动就卡死裁决）；
 *   - 所有通道凭证只来自环境变量，绝不写进代码或日志。
 */

import type { LoopEvent } from './events.ts';

/** 一个推送通道 */
export interface Notifier {
  readonly id: string;
  notify(event: LoopEvent): Promise<void>;
}

/** 把事件整理成一段可读文本（各通道共用） */
function formatEvent(event: LoopEvent): string {
  const t = event.ts.slice(11, 19);
  const icon = event.level === 'alert' ? '🔔' : event.level === 'gate' ? '⏸' : '·';
  return `[${t}] ${icon} ${event.message}`;
}

/** 企微群机器人 webhook：POST { msgtype:'text', text:{content} } */
export class WeComNotifier implements Notifier {
  readonly id = 'wecom';
  private webhookUrl: string;
  constructor(webhookUrl: string) {
    this.webhookUrl = webhookUrl;
  }

  async notify(event: LoopEvent): Promise<void> {
    const content = `Vigil 决策事件\n${formatEvent(event)}`;
    const res = await fetch(this.webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ msgtype: 'text', text: { content } }),
    });
    if (!res.ok) throw new Error(`WeCom webhook HTTP ${res.status}`);
  }
}

/** 通用 webhook：把整个事件原样 POST 出去（飞书/Slack/Discord/Zapier/Make 等） */
export class WebhookNotifier implements Notifier {
  readonly id = 'webhook';
  private url: string;
  private headers: Record<string, string>;
  constructor(url: string, headers: Record<string, string> = {}) {
    this.url = url;
    this.headers = headers;
  }

  async notify(event: LoopEvent): Promise<void> {
    const res = await fetch(this.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...this.headers },
      body: JSON.stringify({ text: formatEvent(event), event }),
    });
    if (!res.ok) throw new Error(`webhook HTTP ${res.status}`);
  }
}

/**
 * 邮件 API 通知：用交易型邮件服务的 JSON 接口（Resend / Mailgun / SendGrid 形态近似）。
 * 默认按 Resend 形态构造，需要自定义可改 endpoint/headers。
 */
export class EmailNotifier implements Notifier {
  readonly id = 'email';
  private endpoint: string;
  private apiKey?: string;
  private from: string;
  private to: string;
  private headers: Record<string, string>;
  constructor(opts: {
    endpoint: string;
    apiKey?: string;
    from: string;
    to: string;
    headers?: Record<string, string>;
  }) {
    this.endpoint = opts.endpoint;
    this.apiKey = opts.apiKey;
    this.from = opts.from;
    this.to = opts.to;
    this.headers = opts.headers ?? {};
  }

  async notify(event: LoopEvent): Promise<void> {
    const body = {
      from: this.from,
      to: this.to,
      subject: `[Vigil] ${event.stage} · ${event.level}`,
      text: formatEvent(event),
    };
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...this.headers,
    };
    if (this.apiKey) headers['Authorization'] = `Bearer ${this.apiKey}`;
    const res = await fetch(this.endpoint, { method: 'POST', headers, body: JSON.stringify(body) });
    if (!res.ok) throw new Error(`email API HTTP ${res.status}`);
  }
}

/** 多通道扇出：一次事件推给所有已配置通道 */
export class MultiNotifier implements Notifier {
  readonly id = 'multi';
  private notifiers: Notifier[];
  constructor(notifiers: Notifier[]) {
    this.notifiers = notifiers;
  }

  async notify(event: LoopEvent): Promise<void> {
    await Promise.allSettled(this.notifiers.map((n) => n.notify(event)));
  }
}

/**
 * 从环境变量构建已配置的推送通道：
 *   VIGIL_NOTIFY_WECOM       企业微信群机器人 webhook 完整 URL
 *   VIGIL_NOTIFY_WEBHOOK     通用 webhook URL（飞书/Slack/Discord…）
 *   VIGIL_NOTIFY_EMAIL_API   邮件 API endpoint
 *   VIGIL_NOTIFY_EMAIL_KEY   邮件 API key（可选）
 *   VIGIL_NOTIFY_EMAIL_FROM  发件人
 *   VIGIL_NOTIFY_EMAIL_TO    收件人
 * 未配置任何通道 → 返回空数组（bus 不推送，仅落盘）。
 */
export function buildNotifiers(env: NodeJS.ProcessEnv = process.env): Notifier[] {
  const list: Notifier[] = [];
  if (env.VIGIL_NOTIFY_WECOM) list.push(new WeComNotifier(env.VIGIL_NOTIFY_WECOM));
  if (env.VIGIL_NOTIFY_WEBHOOK) list.push(new WebhookNotifier(env.VIGIL_NOTIFY_WEBHOOK));
  if (env.VIGIL_NOTIFY_EMAIL_API && env.VIGIL_NOTIFY_EMAIL_TO && env.VIGIL_NOTIFY_EMAIL_FROM) {
    list.push(
      new EmailNotifier({
        endpoint: env.VIGIL_NOTIFY_EMAIL_API,
        apiKey: env.VIGIL_NOTIFY_EMAIL_KEY,
        from: env.VIGIL_NOTIFY_EMAIL_FROM,
        to: env.VIGIL_NOTIFY_EMAIL_TO,
      }),
    );
  }
  return list;
}
