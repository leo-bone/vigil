import type { Kernel } from '../kernel.ts';
import type { DecisionRequest } from '../types.ts';
import { classifyToolCall, resolveSessionId } from './mapping.ts';
import type { HookPayload } from './mapping.ts';

export interface ClaudeHookOptions {
  /** 影子模式：只记账不拦截。用于先观察再上拦截。 */
  shadow?: boolean;
  /** 单次裁决上限，超时按"问一下人"处理，避免卡住 agent */
  timeoutMs?: number;
  /** agent 在账本里的身份 */
  actor?: string;
}

export interface ClaudeHookOutput {
  hookSpecificOutput: {
    hookEventName: 'PreToolUse';
    permissionDecision: 'allow' | 'deny' | 'ask';
    permissionDecisionReason: string;
  };
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

/**
 * Claude Code 的 PreToolUse 钩子。
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
  const shadow = options.shadow ?? process.env.VIGIL_SHADOW === '1';
  const timeoutMs = options.timeoutMs ?? 4000;
  const actor = options.actor ?? 'agent/claude';

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

  const cls = classifyToolCall(payload);

  if (!cls.classified) {
    // 分类失败是我们的问题，不是 agent 的问题。记账但放行。
    emit(allow(`未识别的工具 ${payload.tool_name ?? '(空)'}，已记录未拦截`));
    return;
  }

  const request: DecisionRequest = {
    sessionId: resolveSessionId(payload),
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
    emit(
      shadow
        ? allow(`[shadow] 裁决超时（>${timeoutMs}ms），影子模式下放行`)
        : {
            hookSpecificOutput: {
              hookEventName: 'PreToolUse',
              permissionDecision: 'ask',
              permissionDecisionReason: `Vigil 裁决超时（>${timeoutMs}ms），按 fail-closed 转人工确认`,
            },
          },
    );
    return;
  }

  const badge = verdict.outcome === 'allow' ? '放行' : verdict.outcome === 'deny' ? '否决' : '转人工';
  const reason = `[Vigil #${verdict.seq}] ${badge}：${verdict.reason}`;

  if (shadow) {
    emit(allow(`[shadow] ${reason}`));
    return;
  }

  if (verdict.outcome === 'allow') {
    emit(allow(reason));
    return;
  }

  emit({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: verdict.outcome === 'deny' ? 'deny' : 'ask',
      permissionDecisionReason: reason,
    },
  });
}
