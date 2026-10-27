import { createInterface } from 'node:readline';
import type { Kernel } from '../kernel.ts';
import type { ActionSpec, DecisionRequest, Evidence, OutcomeLabel } from '../types.ts';
import { postmortem } from '../review/postmortem.ts';
import { calibrate } from '../review/calibrate.ts';
import { scanAlerts } from '../alerts.ts';
import { arbitrate } from '../pipeline/arbiter.ts';
import type { Position } from '../pipeline/arbiter.ts';
import type { Orchestrator, PipelineState } from '../pipeline/orchestrator.ts';

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
  {
    name: 'vigil_task_start',
    description:
      '开一个受监督的任务。Vigil 走止损与路由，决定下一个该谁干，并把派工指令交给你 —— 干活的是你（可以扮演不同角色），不是本进程。干完用 vigil_task_submit 交回结果。',
    inputSchema: {
      type: 'object',
      required: ['task', 'roster'],
      properties: {
        task: { type: 'string', description: '任务描述，一句话说清要达成什么' },
        roster: {
          type: 'array',
          description: '可被路由到的执行者名册。id 是身份标识，role 是这个角色该干什么',
          items: {
            type: 'object',
            required: ['id', 'role'],
            properties: {
              id: { type: 'string', description: '执行者 id，如 bot/writer' },
              role: { type: 'string', description: '角色说明，如 负责撰写初稿' },
            },
          },
        },
        taskId: { type: 'string', description: '任务 id，不填则自动生成' },
        sessionId: { type: 'string', description: '会话 id，不填则按 taskId 生成' },
      },
    },
  },
  {
    name: 'vigil_task_submit',
    description:
      '交回一轮干活的成果。Vigil 会先落账，再走质量门与验收：通过就结束任务；不过则带着具体原因重新派工。缺项不会被模型的高分掩盖。',
    inputSchema: {
      type: 'object',
      required: ['taskId', 'summary', 'claim'],
      properties: {
        taskId: { type: 'string' },
        summary: { type: 'string', description: '这一轮实际做了什么' },
        claim: { type: 'string', description: '你对完成度的主张' },
        evidence: {
          type: 'array',
          description: '支撑主张的证据。验收要求至少一份 verified=true 且 producedBy 不等于执行者本人',
          items: {
            type: 'object',
            required: ['id', 'producedBy'],
            properties: {
              id: { type: 'string' },
              producedBy: { type: 'string', description: '证据产出者，用于检测自己批自己' },
              claim: { type: 'string' },
              verified: { type: 'boolean' },
              uri: { type: 'string' },
            },
          },
        },
        deliverableUri: { type: 'string', description: '交付物位置。没有位置等于没有交付物' },
        leftoverIssues: { type: 'string', description: '遗留问题声明，必须显式给出；没有遗留问题就写空字符串' },
        costUsd: { type: 'number' },
      },
    },
  },
  {
    name: 'vigil_task_status',
    description: '查看任务当前状态：轮到谁、试了几次、每个岔路怎么走的。断线后用来恢复上下文。',
    inputSchema: {
      type: 'object',
      required: ['taskId'],
      properties: { taskId: { type: 'string' } },
    },
  },
  {
    name: 'vigil_arbitrate',
    description:
      '多个 agent 对同一件事结论相反时，用它定夺。仲裁阶梯固定：立场一致直接采纳；动作触红线一律否决；有否决立场且证据或权级占优则采信否决；分不出高下就交人工。模型只在"可以继续"与"需要人看"之间排序，且永远不能把否决变成放行。',
    inputSchema: {
      type: 'object',
      required: ['question', 'positions', 'action'],
      properties: {
        question: { type: 'string', description: '争议的是什么' },
        sessionId: { type: 'string', description: '会话 id，不填则自动生成' },
        taskId: { type: 'string' },
        positions: {
          type: 'array',
          description: '各方的立场',
          items: {
            type: 'object',
            required: ['actor', 'conclusion', 'reason'],
            properties: {
              actor: { type: 'string', description: '提出结论的 agent' },
              conclusion: { type: 'string', enum: ['allow', 'deny', 'require_human'] },
              reason: { type: 'string', description: '给出理由，仲裁记录里必须留着' },
              evidence: {
                type: 'array',
                items: {
                  type: 'object',
                  required: ['id', 'producedBy'],
                  properties: {
                    id: { type: 'string' },
                    producedBy: { type: 'string' },
                    claim: { type: 'string' },
                    verified: { type: 'boolean' },
                    uri: { type: 'string' },
                  },
                },
              },
            },
          },
        },
        action: ACTION_SCHEMA,
        forceEscalation: { type: 'boolean', description: '强制升级，跳过模型排序' },
      },
    },
  },
];

function textResult(payload: unknown) {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
  };
}

/** 任务状态的对外摘要：够外部 agent 判断下一步，又不至于把内部结构全抖出来 */
function stateSummary(state: PipelineState | undefined): unknown {
  if (!state) return null;
  return {
    taskId: state.taskId,
    sessionId: state.sessionId,
    task: state.task,
    status: state.status ?? 'running',
    attempts: state.attempts,
    consecutiveFailures: state.consecutiveFailures,
    pending: state.pending,
    escalatedTo: state.escalatedTo,
    reason: state.reason,
    steps: state.steps,
    workerTrace: state.trace,
  };
}

/**
 * 传给 MCP 服务端的附加能力。
 *
 * 统筹循环和仲裁都需要带流水线规则的内核（验收清单、仲裁结论等确定性规则），
 * 与对外动作用的内核共用同一本账本。
 */
export interface McpOptions {
  orchestrator?: Orchestrator;
  pipelineKernel?: Kernel;
}

/** 导出以便测试直接驱动协议层，不必起子进程 */
export async function handleMcpRequest(
  method: string,
  params: Record<string, unknown>,
  kernel: Kernel,
  options: McpOptions = {},
): Promise<unknown> {
  return handle(method, params, kernel, options);
}

async function handle(
  method: string,
  params: Record<string, unknown>,
  kernel: Kernel,
  options: McpOptions = {},
): Promise<unknown> {
  const { orchestrator, pipelineKernel } = options;
  switch (method) {
    case 'initialize':
      return {
        protocolVersion: typeof params.protocolVersion === 'string' ? params.protocolVersion : PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: 'vigil', version: '0.2.0' },
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
        case 'vigil_task_start': {
          if (!orchestrator) throw new Error('当前未启用统筹循环');
          const roster = (args.roster ?? []) as Array<{ id: string; role: string }>;
          if (roster.length === 0) throw new Error('名册不能为空：至少列出一个可以被路由到的执行者');
          const taskId = String(args.taskId ?? `task_${Date.now().toString(36)}`);
          const sessionId = String(args.sessionId ?? `sess_${taskId}`);
          const turn = await orchestrator.begin({
            sessionId,
            taskId,
            task: String(args.task ?? ''),
            roster,
          });
          return textResult({ turn, state: stateSummary(orchestrator.state(taskId)) });
        }
        case 'vigil_task_submit': {
          if (!orchestrator) throw new Error('当前未启用统筹循环');
          const taskId = String(args.taskId ?? '');
          const turn = await orchestrator.submit(taskId, {
            summary: String(args.summary ?? ''),
            claim: String(args.claim ?? ''),
            evidence: ((args.evidence ?? []) as Evidence[]),
            deliverableUri: args.deliverableUri as string | undefined,
            leftoverIssues: args.leftoverIssues as string | undefined,
            costUsd: args.costUsd as number | undefined,
          });
          return textResult({ turn, state: stateSummary(orchestrator.state(taskId)) });
        }
        case 'vigil_task_status': {
          if (!orchestrator) throw new Error('当前未启用统筹循环');
          const taskId = String(args.taskId ?? '');
          const state = orchestrator.state(taskId);
          if (!state) throw new Error(`未知任务 ${taskId}`);
          return textResult(stateSummary(state));
        }
        case 'vigil_arbitrate': {
          const arbiterKernel = pipelineKernel ?? kernel;
          const positions = (args.positions ?? []) as Position[];
          if (positions.length === 0) throw new Error('至少要有一个立场才能仲裁');
          const result = await arbitrate(arbiterKernel, {
            sessionId: String(args.sessionId ?? `sess_arb_${Date.now().toString(36)}`),
            taskId: args.taskId as string | undefined,
            question: String(args.question ?? ''),
            positions,
            action: (args.action ?? { kind: 'arbitrate', reversible: true, external: false }) as ActionSpec,
            forceEscalation: args.forceEscalation as boolean | undefined,
          });
          return textResult({
            decision: result.decision,
            resolution: result.resolution,
            winner: result.winner,
            overruled: result.overruled.map((position) => ({
              actor: position.actor,
              conclusion: position.conclusion,
              reason: position.reason,
            })),
            reason: result.reason,
            usedJudge: result.usedJudge,
            decisionId: result.verdict.decisionId,
            recordHash: result.verdict.recordHash,
          });
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
 *
 * 传入 options.orchestrator 就同时开放统筹循环的三个工具，
 * 传入 options.pipelineKernel 就开放仲裁工具。外部 agent 可以扮演工人，
 * 把整条决策回路跑起来。
 */
export function startMcpServer(kernel: Kernel, options: McpOptions = {}): void {
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
        const result = await handle(message.method, message.params ?? {}, kernel, options);
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
