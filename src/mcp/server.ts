import { createInterface } from 'node:readline';
import type { Kernel } from '../kernel.ts';
import type { DecisionRequest, OutcomeLabel } from '../types.ts';
import { postmortem } from '../review/postmortem.ts';
import { calibrate } from '../review/calibrate.ts';
import { scanAlerts } from '../alerts.ts';

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: number | string;
  method: string;
  params?: Record<string, unknown>;
}

const PROTOCOL_VERSION = '2025-06-18';

const ACTION_SCHEMA = {
  type: 'object',
  required: ['kind', 'reversible', 'external'],
  properties: {
    kind: { type: 'string', description: '动作类型，如 send_email / write_file / pay / query' },
    target: { type: 'string', description: '作用对象：域名、路径、账号' },
    payload: { description: '动作载荷，任意 JSON' },
    reversible: { type: 'boolean', description: '是否可撤销' },
    external: { type: 'boolean', description: '是否越过本机信任边界' },
    moneyUsd: { type: 'number', description: '涉及金额（美元）' },
  },
} as const;

const QUESTIONS_SCHEMA = {
  type: 'array',
  description: '交给概率判断模型的类型化问题，最多 6 个',
  items: {
    type: 'object',
    required: ['name', 'type', 'instructions'],
    properties: {
      name: { type: 'string' },
      type: { type: 'string', enum: ['boolean', 'choice', 'score'] },
      instructions: { type: 'string' },
      criteria: { type: 'object', description: 'choice 的可选标签' },
      scale: { type: 'array', items: { type: 'string' }, description: 'score 的档位，从低到高' },
      floor: { type: 'number', description: '低于此值升级人工' },
      gating: { type: 'boolean', description: 'false 表示只记录不拦截' },
      escalateIf: { type: 'array', items: { type: 'string' } },
      escalateIfBelow: { type: 'number' },
      escalateWhenTrue: { type: 'boolean', description: 'true 表示概率高即为风险' },
    },
  },
} as const;

const TOOLS = [
  {
    name: 'vigil_decide',
    description:
      '在动作被执行前请求裁决。返回 allow / require_human / deny，并把这次决定写入只追加的决策账本。硬约束由确定性规则判断，灰区才交给概率模型。',
    inputSchema: {
      type: 'object',
      required: ['sessionId', 'actor', 'intent', 'action'],
      properties: {
        sessionId: { type: 'string', description: '会话 id，用于串联整条决策链' },
        actor: { type: 'string', description: '谁在做这个决定，如 bot/researcher' },
        intent: { type: 'string', description: '用一句话说明想达成什么' },
        action: ACTION_SCHEMA,
        evidence: {
          type: 'array',
          description: '这次动作依据的证据。没有证据就别声明完成。',
          items: {
            type: 'object',
            required: ['id', 'producedBy'],
            properties: {
              id: { type: 'string' },
              producedBy: { type: 'string', description: '证据的产出者，用于检测自己批自己' },
              claim: { type: 'string' },
              verified: { type: 'boolean' },
              uri: { type: 'string' },
            },
          },
        },
        state: { type: 'string', description: '交给概率模型的原始材料' },
        questions: QUESTIONS_SCHEMA,
        costUsd: { type: 'number', description: '本次动作的成本' },
      },
    },
  },
  {
    name: 'vigil_postmortem',
    description: '事后梳理：输入会话 id，返回转折点、缺失证据、被证伪的决定、四项指标和结论句。',
    inputSchema: {
      type: 'object',
      required: ['sessionId'],
      properties: { sessionId: { type: 'string' } },
    },
  },
  {
    name: 'vigil_verify',
    description: '重算整条哈希链，检查账本是否被篡改或截断。',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'vigil_alerts',
    description: '扫描预警：成本失控、反复越权、置信度塌陷、证据荒漠、被证伪的完成声明。',
    inputSchema: {
      type: 'object',
      properties: {
        windowMs: { type: 'number', description: '观察窗口，默认 30 分钟' },
        costCapUsd: { type: 'number' },
      },
    },
  },
  {
    name: 'vigil_calibrate',
    description: '置信度校准：用事后标签算出 Brier 分数和 ECE，并给出阈值扫描，告诉你 floor 该设多少。',
    inputSchema: {
      type: 'object',
      properties: {
        question: { type: 'string', description: '要校准的判断名，默认 proceed' },
      },
    },
  },
  {
    name: 'vigil_label',
    description: '回填事后结果。这是校准闭环的入口，没有标签就没有校准。',
    inputSchema: {
      type: 'object',
      required: ['decisionId', 'label'],
      properties: {
        decisionId: { type: 'string' },
        label: { type: 'string', enum: ['correct', 'wrong', 'unknown'] },
        note: { type: 'string' },
      },
    },
  },
];

function textResult(payload: unknown) {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
  };
}

async function handle(method: string, params: Record<string, unknown>, kernel: Kernel): Promise<unknown> {
  switch (method) {
    case 'initialize':
      return {
        protocolVersion: typeof params.protocolVersion === 'string' ? params.protocolVersion : PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: 'vigil', version: '0.1.0' },
      };
    case 'ping':
      return {};
    case 'tools/list':
      return { tools: TOOLS };
    case 'tools/call': {
      const name = String(params.name ?? '');
      const args = (params.arguments ?? {}) as Record<string, unknown>;
      const ledger = kernel.ledger;
      switch (name) {
        case 'vigil_decide':
          return textResult(await kernel.decide(args as unknown as DecisionRequest));
        case 'vigil_postmortem':
          return textResult(postmortem(ledger, String(args.sessionId ?? '')));
        case 'vigil_verify':
          return textResult(ledger.verify());
        case 'vigil_alerts':
          return textResult(
            scanAlerts(ledger, {
              windowMs: args.windowMs as number | undefined,
              costCapUsd: args.costCapUsd as number | undefined,
            }),
          );
        case 'vigil_calibrate':
          return textResult(calibrate(ledger.all(), { question: args.question as string | undefined }));
        case 'vigil_label': {
          ledger.label(
            String(args.decisionId ?? ''),
            String(args.label ?? 'unknown') as OutcomeLabel,
            args.note as string | undefined,
          );
          return textResult({ ok: true });
        }
        default:
          throw new Error(`未知工具：${name}`);
      }
    }
    default:
      throw new Error(`未知方法：${method}`);
  }
}

/**
 * 极简 MCP stdio 服务端。
 *
 * 刻意不引入 SDK：整个项目运行时零依赖，`npx` 起来就能用。
 * 协议只实现 initialize / tools/list / tools/call / ping，
 * 这已经覆盖了 99% 的客户端场景。
 */
export function startMcpServer(kernel: Kernel): void {
  const rl = createInterface({ input: process.stdin });
  let queue: Promise<void> = Promise.resolve();

  const write = (message: unknown) => {
    process.stdout.write(`${JSON.stringify(message)}\n`);
  };

  rl.on('line', (line) => {
    queue = queue.then(async () => {
      const trimmed = line.trim();
      if (!trimmed) return;
      let message: JsonRpcRequest;
      try {
        message = JSON.parse(trimmed) as JsonRpcRequest;
      } catch {
        return;
      }
      // 通知类消息没有 id，不需要回包
      if (message.id === undefined) return;
      try {
        const result = await handle(message.method, message.params ?? {}, kernel);
        write({ jsonrpc: '2.0', id: message.id, result });
      } catch (error) {
        write({
          jsonrpc: '2.0',
          id: message.id,
          error: { code: -32603, message: error instanceof Error ? error.message : String(error) },
        });
      }
    });
  });
}
