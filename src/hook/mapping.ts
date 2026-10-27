import type { ActionSpec, JudgeQuestion } from '../types.ts';
import { requiredAuthority } from '../policy/authority.ts';

/** Claude Code PreToolUse 钩子送进来的载荷（只取我们需要的字段） */
export interface HookPayload {
  session_id?: string;
  cwd?: string;
  hook_event_name?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
}

export interface Classification {
  /** 一句话说明这一步想干什么 */
  intent: string;
  action: ActionSpec;
  /** 只有在灰区才会真正发给判断模型 */
  questions: JudgeQuestion[];
  /** 命中的风险特征，写进账本方便复盘 */
  riskNotes: string[];
  /** 无法识别时为 false，调用方决定怎么处理 */
  classified: boolean;
}

interface Pattern {
  re: RegExp;
  note: string;
}

const DESTRUCTIVE: Pattern[] = [
  { re: /\brm\s+(-\S*[rf]\S*\s+)+/, note: '递归或强制删除' },
  { re: /\bgit\s+reset\s+--hard\b/, note: '丢弃本地提交' },
  { re: /\bgit\s+push\b.*--force\b/, note: '强制推送' },
  { re: /\bgit\s+clean\s+-\S*f/, note: '清理未跟踪文件' },
  { re: /\b(drop|truncate)\s+table\b/i, note: '删表' },
  { re: /\bdd\s+if=/, note: '裸写块设备' },
  { re: />\s*\/dev\/sd/, note: '覆盖块设备' },
  { re: /\bshutdown\b|\breboot\b/, note: '关机或重启' },
];

const EGRESS: Pattern[] = [
  { re: /\b(curl|wget)\b[^|;]*(-X\s*(POST|PUT|PATCH|DELETE)|--data\b|\s-d\s)/i, note: '带载荷的外发请求' },
  { re: /\bssh\b/, note: '远程登录' },
  { re: /\bnc\s+-/, note: '裸连接回连' },
  { re: /\bnpm\s+publish\b/, note: '发布包到公共仓库' },
  { re: /\bdocker\s+push\b/, note: '推送镜像' },
];

const MONEY: Pattern[] = [
  { re: /\bstripe\b/i, note: '支付网关' },
  { re: /\baws\s+s3\s+(rm|cp)\b/, note: '云存储写删' },
  { re: /\bgcloud\b.*\bdelete\b/, note: '云资源删除' },
  { re: /\b(purchase|checkout|subscribe)\b/i, note: '疑似购买' },
];

const SECRET_TOUCH: RegExp[] = [/\.env\b/, /id_rsa/, /\.aws\/credentials/, /\.ssh\//, /\.npmrc\b/];

const EXTERNAL_TOOL = /send|mail|message|post|publish|deploy|upload|share|notify|webhook|pay|charge|refund/i;
const READ_TOOL = /^(read|glob|grep|ls|list|search|webfetch|websearch|todo)/i;

function scan(patterns: Pattern[], text: string): string[] {
  return patterns.filter((p) => p.re.test(text)).map((p) => p.note);
}

function clip(value: unknown, max = 600): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? '');
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/**
 * 把一次工具调用翻译成动作形状。
 *
 * 这一步必须只依赖结构，不依赖自然语言 —— 因为它是后面所有
 * 授权推导和硬规则判断的输入。翻译错了，后面全错。
 */
export function classifyToolCall(payload: HookPayload): Classification {
  const toolName = payload.tool_name ?? '';
  const input = (payload.tool_input ?? {}) as Record<string, unknown>;
  const riskNotes: string[] = [];

  if (/^(bash|shell|execute|run_command|terminal)/i.test(toolName)) {
    const command = String(input.command ?? input.cmd ?? '');
    const destructive = scan(DESTRUCTIVE, command);
    const egress = scan(EGRESS, command);
    const money = scan(MONEY, command);
    const secrets = SECRET_TOUCH.filter((re) => re.test(command)).map(() => '触碰凭据文件');
    riskNotes.push(...destructive, ...egress, ...money, ...secrets);

    const action: ActionSpec = {
      kind: 'shell',
      target: clip(command.split(/\s+/).slice(0, 3).join(' '), 80),
      payload: clip(command),
      reversible: destructive.length === 0,
      external: egress.length > 0,
    };
    if (money.length > 0) action.moneyUsd = 1;

    return {
      intent: `执行命令：${clip(command, 120)}`,
      action,
      questions: buildQuestions(action, riskNotes),
      riskNotes,
      classified: true,
    };
  }

  if (/^(write|edit|multiedit|notebookedit|create_file|apply_patch)/i.test(toolName)) {
    const target = String(input.file_path ?? input.path ?? input.file ?? '');
    const action: ActionSpec = {
      kind: 'write_file',
      target,
      payload: clip(input.content ?? input.new_string ?? ''),
      reversible: true,
      external: false,
    };
    if (SECRET_TOUCH.some((re) => re.test(target))) riskNotes.push('写入凭据文件');
    return {
      intent: `写入文件：${target || '(未指定)'}`,
      action,
      questions: buildQuestions(action, riskNotes),
      riskNotes,
      classified: true,
    };
  }

  if (READ_TOOL.test(toolName)) {
    const action: ActionSpec = {
      kind: 'query',
      target: clip(input.file_path ?? input.path ?? input.url ?? input.query ?? '', 120),
      reversible: true,
      external: false,
    };
    return { intent: `读取：${toolName}`, action, questions: [], riskNotes, classified: true };
  }

  const external = EXTERNAL_TOOL.test(toolName);
  const action: ActionSpec = {
    kind: external ? 'outbound' : 'tool_call',
    target: toolName,
    payload: clip(input),
    reversible: !external,
    external,
  };
  return {
    intent: `调用工具：${toolName}`,
    action,
    questions: buildQuestions(action, riskNotes),
    riskNotes,
    classified: toolName !== '',
  };
}

/**
 * 概率模型只在灰区出场。
 *
 * L0–L2 的动作（读、写草稿、可逆写入）根本不需要问模型 —— 那既贵又慢。
 * 只有到了 L3 以上（对外、不可逆、花钱）才值得花那 150 毫秒。
 */
export function buildQuestions(action: ActionSpec, riskNotes: string[]): JudgeQuestion[] {
  if (requiredAuthority(action) < 3) return [];
  const questions: JudgeQuestion[] = [
    {
      name: 'proceed',
      type: 'boolean',
      instructions:
        '综合这次动作的对象、载荷和上下文，判断它是否属于当前任务的合理范围，且不会造成不可挽回的后果。',
      floor: 0.8,
    },
  ];
  if (action.external || riskNotes.some((note) => note.includes('凭据') || note.includes('外发'))) {
    questions.push({
      name: 'exfiltration',
      type: 'boolean',
      instructions: '这次动作是否在把凭据、密钥或未授权的内部数据送往信任边界之外。',
      escalateWhenTrue: true,
      floor: 0.7,
    });
  }
  return questions;
}

/** 统一的会话 id，保证账本能把一次 agent 会话串起来 */
export function resolveSessionId(payload: HookPayload): string {
  return payload.session_id ?? process.env.VIGIL_SESSION ?? `local-${new Date().toISOString().slice(0, 10)}`;
}
