import type { Kernel } from '../kernel.ts';
import type { DecisionRequest } from '../types.ts';
import { classifyToolCall, resolveSessionId } from './mapping.ts';
import type { HookPayload } from './mapping.ts';
import { detectSecrets, describeSecrets } from '../policy/secrets.ts';

export interface ClaudeHookOptions {
  /** 影子模式：只记账不拦截。用于先观察再上拦截。 */
  shadow?: boolean;
  /** 单次裁决上限，超时按"问一下人"处理，避免卡住 agent */
  timeoutMs?: number;
  /** agent 在账本里的身份 */
  actor?: string;
}

/**
 * Claude Code 会触发这些生命周期事件。
 *
 * PreToolUse 是唯一能"拦"的动作；其余的都是事后才知道的事。
 * 但事后不等于不记 —— 凭据顺着响应流出去这种事，
 * 只有把 PostToolUse 接上才看得见。
 */
export type ClaudeHookEvent =
  | 'PreToolUse'
  | 'PostToolUse'
  | 'PostToolUseFailure'
  | 'SessionStart'
  | 'SessionEnd'
  | 'Stop'
  | 'PreCompact';

export interface ClaudeHookOutput {
  hookSpecificOutput?: {
    hookEventName: ClaudeHookEvent;
    permissionDecision?: 'allow' | 'deny' | 'ask';
    permissionDecisionReason?: string;
    additionalContext?: string;
  };
  /** PostToolUse / Stop 用这个形状告诉 Claude "别继续" */
  decision?: 'block';
  reason?: string;
  /** 诊断信息，给人看 */
  systemMessage?: string;
}

function emit(output: ClaudeHookOutput): void {
  process.stdout.write(`${JSON.stringify(output)}\n`);
}

function allow(reason: string): ClaudeHookOutput {
  return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', permissionDecisionReason: reason } };
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return '';
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(null);
      },
    );
  });
}

/** 从工具响应里抽出可读文本。Claude Code 传的对象形状不统一，这里都试一遍。 */
function extractOutput(payload: HookPayload): string {
  const response = (payload as Record<string, unknown>).tool_response ?? (payload as Record<string, unknown>).tool_output;
  if (typeof response === 'string') return response;
  if (response === undefined || response === null) return '';
  try {
    return JSON.stringify(response);
  } catch {
    return String(response);
  }
}

/** 输出可能很大，落账只留摘要 */
function clip(text: string, max = 400): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}…`;
}

/**
 * Claude Code 的钩子。
 *
 * 契约：永远退出码 0，永远输出一段 JSON。钩子本身崩了不能把用户的
 * agent 一起带崩 —— 那是我们的 bug，不该由用户承担。
 *
 * 三种结论的映射刻意做得保守：
 *   allow        → 直接放行
 *   require_human→ ask（在交互式会话里就是弹给用户确认）
 *   deny         → deny（硬拦，连确认的机会都不给）
 */
export async function runClaudeHook(kernel: Kernel, options: ClaudeHookOptions = {}): Promise<void> {
  const raw = await readStdin();
  if (!raw.trim()) {
    emit(allow('没有收到工具调用载荷，跳过'));
    return;
  }

  let payload: HookPayload;
  try {
    payload = JSON.parse(raw) as HookPayload;
  } catch {
    emit(allow('载荷无法解析，跳过'));
    return;
  }

  const output = await handleHookEvent(kernel, payload, options);
  emit(output);
}

/**
 * 处理一次钩子事件，返回该返回什么。
 *
 * 单独抽出来是为了能直接测：跑一次真实钩子要起一个子进程，
 * 而事件分派本身是纯逻辑，不该被进程开销掩盖。
 */
export async function handleHookEvent(
  kernel: Kernel,
  payload: HookPayload,
  options: ClaudeHookOptions = {},
): Promise<ClaudeHookOutput> {
  const shadow = options.shadow ?? process.env.VIGIL_SHADOW === '1';
  const timeoutMs = options.timeoutMs ?? 4000;
  const actor = options.actor ?? 'agent/claude';

  const event = (payload.hook_event_name ?? 'PreToolUse') as ClaudeHookEvent;
  const sessionId = resolveSessionId(payload);

  try {
    switch (event) {
      case 'PostToolUse':
        return await handlePostToolUse(kernel, payload, sessionId, actor);
      case 'PostToolUseFailure':
        return await handlePostToolUseFailure(kernel, payload, sessionId, actor);
      case 'SessionStart':
      case 'SessionEnd':
      case 'Stop':
      case 'PreCompact':
        return await handleLifecycle(kernel, payload, sessionId, actor, event);
      default:
        return await handlePreToolUse(kernel, payload, sessionId, actor, shadow, timeoutMs);
    }
  } catch (error) {
    // 钩子自己出错也不能把 agent 带崩
    return {
      systemMessage: `[Vigil] 钩子内部错误（${error instanceof Error ? error.message : String(error)}），已放行`,
      hookSpecificOutput: {
        hookEventName: event,
        permissionDecision: 'allow',
        permissionDecisionReason: 'Vigil 钩子内部错误，按 fail-open 放行（错误已记日志）',
      },
    };
  }
}

async function handlePreToolUse(
  kernel: Kernel,
  payload: HookPayload,
  sessionId: string,
  actor: string,
  shadow: boolean,
  timeoutMs: number,
): Promise<ClaudeHookOutput> {
  const cls = classifyToolCall(payload);

  if (!cls.classified) {
    // 分类失败是我们的问题，不是 agent 的问题。记账但放行。
    return allow(`未识别的工具 ${payload.tool_name ?? '(空)'}，已记录未拦截`);
  }

  const request: DecisionRequest = {
    sessionId,
    actor,
    intent: cls.intent,
    action: cls.action,
    evidence: [],
    state: cls.riskNotes.length > 0
      ? `工具 ${payload.tool_name}；风险特征：${cls.riskNotes.join('、')}`
      : `工具 ${payload.tool_name}，无风险特征`,
    questions: cls.questions,
  };

  const verdict = await withTimeout(kernel.decide(request), timeoutMs);

  if (verdict === null) {
    return shadow
      ? allow(`[shadow] 裁决超时（>${timeoutMs}ms），影子模式下放行`)
      : {
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'ask',
            permissionDecisionReason: `Vigil 裁决超时（>${timeoutMs}ms），按 fail-closed 转人工确认`,
          },
        };
  }

  const badge = verdict.outcome === 'allow' ? '放行' : verdict.outcome === 'deny' ? '否决' : '转人工';
  const reason = `[Vigil #${verdict.seq}] ${badge}：${verdict.reason}`;

  if (shadow) {
    return allow(`[shadow] ${reason}`);
  }

  if (verdict.outcome === 'allow') {
    return allow(reason);
  }

  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: verdict.outcome === 'deny' ? 'deny' : 'ask',
      permissionDecisionReason: reason,
    },
  };
}

/**
 * 工具执行完之后。
 *
 * 这是"凭据顺着响应流出去"唯一能被看见的地方 ——
 * 请求侧再严也看不见输出里的东西。
 */
async function handlePostToolUse(
  kernel: Kernel,
  payload: HookPayload,
  sessionId: string,
  actor: string,
): Promise<ClaudeHookOutput> {
  const output = extractOutput(payload);
  const toolName = payload.tool_name ?? '(未知工具)';

  const verdict = await kernel.observe({
    sessionId,
    actor,
    intent: `工具执行完成：${toolName}`,
    action: {
      kind: 'tool_result',
      target: toolName,
      payload: clip(output, 400),
      reversible: false,
      external: false,
    },
    extras: { toolOutput: output },
  });

  if (verdict.outcome === 'require_human') {
    // 动作已经发生，拦不住，但要让 agent 知道，也要把人叫醒
    return {
      decision: 'block',
      reason:
        `[Vigil] ${verdict.warnings?.join('；') ?? '工具输出存在风险'}。` +
        `请立即处理：确认该凭据是否已经外流，必要时立刻轮换；不要把这段输出再转发给任何第三方。`,
    };
  }

  return {};
}

/** 工具执行失败：失败也是决策的一部分，必须落账 */
async function handlePostToolUseFailure(
  kernel: Kernel,
  payload: HookPayload,
  sessionId: string,
  actor: string,
): Promise<ClaudeHookOutput> {
  const output = extractOutput(payload);
  const toolName = payload.tool_name ?? '(未知工具)';
  const error = String((payload as Record<string, unknown>).error ?? '');

  await kernel.observe({
    sessionId,
    actor,
    intent: `工具执行失败：${toolName}`,
    action: {
      kind: 'tool_failure',
      target: toolName,
      payload: clip(error || output, 400),
      reversible: false,
      external: false,
    },
    extras: { toolOutput: output },
  });

  return {};
}

/**
 * 会话生命周期事件。
 *
 * SessionStart / SessionEnd / Stop / PreCompact 本身没有风险，
 * 但它们是"这次会话到底花了多少钱、做了多少事"的天然锚点 ——
 * 没有它们，成本只能事后靠聚合算。
 */
async function handleLifecycle(
  kernel: Kernel,
  payload: HookPayload,
  sessionId: string,
  actor: string,
  event: ClaudeHookEvent,
): Promise<ClaudeHookOutput> {
  const spend = kernel.ledger.sessionSpend(sessionId);
  const records = kernel.ledger.bySession(sessionId).length;

  await kernel.observe({
    sessionId,
    actor,
    intent: `会话事件：${event}`,
    action: {
      kind: 'session_lifecycle',
      target: event,
      payload: `本次会话累计 ${records} 条决策，花费 ${spend.toFixed(4)} 美元`,
      reversible: true,
      external: false,
    },
    extras: { lifecycle: event, sessionSpendUsd: spend, sessionRecords: records },
  });

  if (event === 'SessionStart') {
    return {
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext:
          `[Vigil] 本次会话的每个动作都会被记录并按授权等级裁决；需要人工确认的动作会被拦下。` +
          `当前会话累计 ${records} 条决策，花费 ${spend.toFixed(4)} 美元。`,
      },
    };
  }

  return {};
}
