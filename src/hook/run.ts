import { spawnSync } from 'node:child_process';
import type { Kernel } from '../kernel.ts';
import { classifyToolCall } from './mapping.ts';
import type { ClaudeHookOptions } from './claude.ts';

/**
 * 通用命令包装器。
 *
 * 给不支持 hook 的客户端用的：只要能改命令行，就能被管住。
 *   vigil run -- rm -rf build
 *   vigil run -- git push --force
 *
 * 与 hook 的区别：这里没有"问一下人"这个选项 —— 没有交互界面。
 * 所以 require_human 会直接变成拒绝，并且退出码 3，方便脚本区分。
 */
export async function runWrapped(
  kernel: Kernel,
  command: string,
  options: ClaudeHookOptions & { sessionId?: string } = {},
): Promise<number> {
  const shadow = options.shadow ?? process.env.VIGIL_SHADOW === '1';
  const cls = classifyToolCall({ tool_name: 'Bash', tool_input: { command } });

  const verdict = await kernel.decide({
    sessionId: options.sessionId ?? process.env.VIGIL_SESSION ?? `wrap-${new Date().toISOString().slice(0, 10)}`,
    actor: options.actor ?? 'agent/cli',
    intent: cls.intent,
    action: cls.action,
    evidence: [],
    state: cls.riskNotes.length > 0 ? `风险特征：${cls.riskNotes.join('、')}` : '无风险特征',
    questions: cls.questions,
  });

  const badge = verdict.outcome === 'allow' ? '放行' : verdict.outcome === 'deny' ? '否决' : '需人工';
  process.stderr.write(`[vigil #${verdict.seq}] ${badge}：${verdict.reason}\n`);

  if (shadow) {
    process.stderr.write('[vigil] 影子模式，不拦截\n');
  } else if (verdict.outcome === 'deny') {
    return 2;
  } else if (verdict.outcome === 'require_human') {
    process.stderr.write('[vigil] 该动作需要人工确认。确需执行请人工运行，或临时设置 VIGIL_SHADOW=1 观察（不推荐）。\n');
    return 3;
  }

  const result = spawnSync(command, {
    shell: true,
    stdio: 'inherit',
    env: process.env,
  });
  return result.status ?? 1;
}
