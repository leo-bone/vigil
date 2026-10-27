import { homedir } from 'node:os';
import type { AuthorityLevel } from '../types.ts';
import { AUTHORITY_LABELS } from '../types.ts';
import { analyzeShell } from '../hook/mapping.ts';

export type CapabilityKind = 'mcp_server' | 'script' | 'credential';

export interface Capability {
  /** server 名或脚本名 */
  id: string;
  kind: CapabilityKind;
  /** 从哪个文件里读到的（审计用，别丢） */
  source: string;
  authority: AuthorityLevel;
  /** 为什么定这一级。人看得懂的一句话，比等级数字重要。 */
  reason: string;
  /** 从启动参数里看出来的作用范围，比如文件系统 server 的根目录 */
  scope?: string[];
  /** 名字看不出干什么，需要人确认 */
  needsReview: boolean;
  /** 具体命令或路径 */
  detail?: string;
}

export interface InferredLevel {
  authority: AuthorityLevel;
  reason: string;
  needsReview: boolean;
}

/**
 * 工具名基本是 snake_case 或 camelCase。
 *
 * 不能直接对原名用 `\b` 正则：下划线是单词字符，`github_search_issues`
 * 里的 `search` 左右都没有词边界，`\bsearch\b` 匹配不到 —— 这是我在
 * 第一次跑扫描时踩到的坑（六个脚本全被判成高危其实就是同一类错）。
 */
export function tokenize(text: string): string[] {
  return text
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .map((token) => token.toLowerCase())
    .filter(Boolean);
}

/** 只读词：同时出现改动词时作废 */
const READ_WORDS = new Set([
  'read', 'get', 'list', 'search', 'query', 'fetch', 'view', 'inspect',
  'show', 'describe', 'status', 'health', 'lookup', 'head', 'stat', 'check', 'find',
]);

/** 改动词：有它就绝不能算只读 */
const WRITE_WORDS = new Set([
  'write', 'create', 'update', 'delete', 'remove', 'send', 'post', 'push',
  'merge', 'close', 'reopen', 'set', 'put', 'patch', 'execute', 'exec', 'run',
  'deploy', 'publish', 'upload', 'pay', 'transfer', 'approve', 'grant', 'invoke',
]);

interface LevelRule {
  re: RegExp;
  level: AuthorityLevel;
  reason: string;
}

/**
 * 顺序即优先级。资金最先判，因为钱出去没有任何技术手段能挽回。
 *
 * 这里刻意不追求"聪明"：名字分类永远会错，所以宁可判重一点，
 * 并把看不准的标成 needsReview 交给人，而不是猜一个刚好够用的等级。
 */
const LEVEL_RULES: LevelRule[] = [
  { re: /pay|payment|stripe|billing|invoice|checkout|refund|purchase|transfer|wire|trading|broker|charge/i, level: 4, reason: '涉及资金流动' },
  { re: /deploy|release|publish|prod(uction)?\b|rollback|migrate/i, level: 3, reason: '可影响线上环境或对外发布' },
  { re: /send|email|gmail|smtp|imap|slack|discord|telegram|wechat|wecom|webhook|tweet|notify|sms|post_message|message_send/i, level: 3, reason: '可对外发送消息' },
  { re: /delete|remove|drop|destroy|truncate|purge|erase|revoke/i, level: 3, reason: '可删除数据且不可逆' },
  { re: /shell|exec|terminal|command|bash|subprocess|kubectl|ssh|terraform|ansible/i, level: 3, reason: '可在主机上执行任意命令' },
  { re: /sql|database|postgres|mysql|sqlite|mongo|redis|dynamo|supabase/i, level: 3, reason: '可改写业务数据' },
  { re: /browser|playwright|puppeteer|selenium|scrape|crawl/i, level: 3, reason: '可操作外部网站' },
  { re: /\bgit\b|github|gitlab|gitea|bitbucket/i, level: 3, reason: '可改动代码与 CI' },
  { re: /upload|s3|storage|drive|onedrive|dropbox|oss\b|gcs\b/i, level: 3, reason: '可外传文件' },
  { re: /write|edit|create|apply_patch|filesystem|file_system|fs\b/i, level: 2, reason: '可写本地文件（一般可逆）' },
  { re: /memory|note|todo|task|scratch|journal/i, level: 2, reason: '可读写本地记忆或笔记' },
  { re: /read|get|list|search|fetch|query|glob|grep|lookup|time|date|weather|calc/i, level: 0, reason: '只读' },
];

/**
 * 按名字推断一个能力的授权等级。
 *
 * 两条判据：先看是不是纯只读（只读优先，否则 github_search 会被误判成 L3），
 * 再按风险词表从高到低匹配。都不中就是 L3 + 待人工确认 —— deny-by-default。
 */
export function inferAuthority(name: string, extra = ''): InferredLevel {
  const tokens = tokenize(name);
  const hasRead = tokens.some((token) => READ_WORDS.has(token));
  const hasWrite = tokens.some((token) => WRITE_WORDS.has(token));

  if (hasRead && !hasWrite) {
    return { authority: 0, reason: '名字表明只读取信息', needsReview: false };
  }

  const normalized = tokens.join(' ');
  for (const rule of LEVEL_RULES) {
    if (rule.re.test(name) || rule.re.test(normalized)) {
      return { authority: rule.level, reason: rule.reason, needsReview: false };
    }
  }

  if (extra && tokenize(extra).some((token) => WRITE_WORDS.has(token))) {
    return { authority: 3, reason: '启动命令里出现改动意图', needsReview: false };
  }
  return { authority: 3, reason: '名字看不出能力边界，按最坏情况计', needsReview: true };
}

const ABSOLUTE_PATH = /(^|\s)(\/[^\s;|&]+)/g;

/** 从启动参数里捞出绝对路径 —— 文件系统类 server 的根目录就是它的实际权限边界 */
export function extractScope(args: string[]): string[] {
  const found: string[] = [];
  for (const arg of args) {
    const matches = arg.match(ABSOLUTE_PATH);
    if (!matches) continue;
    for (const raw of matches) {
      const path = raw.trim();
      if (path.length <= 1) continue;
      if (/^\/(bin|usr|opt|tmp|dev)\b/.test(path)) continue;
      found.push(shortenHome(path));
    }
  }
  return [...new Set(found)];
}

export function shortenHome(path: string): string {
  const home = homedir();
  return home && path.startsWith(home) ? `~${path.slice(home.length)}` : path;
}

export interface McpServerDef {
  command?: string;
  args?: string[];
  url?: string;
  type?: string;
}

/** 把一个 MCP server 定义翻译成能力项 */
export function classifyMcpServer(id: string, def: McpServerDef, source: string): Capability {
  const commandLine = [def.command, ...(def.args ?? []), def.url].filter(Boolean).join(' ');
  const inferred = inferAuthority(id, commandLine);
  const scope = extractScope([def.command ?? '', ...(def.args ?? [])]);

  // 远程 server：没有本地进程，数据直接出本机，按对外处理
  const remote = !def.command && Boolean(def.url);
  const authority = remote ? (Math.max(inferred.authority, 3) as typeof inferred.authority) : inferred.authority;
  const reason = remote ? `${inferred.reason}；远程服务，数据离开本机` : inferred.reason;

  return {
    id,
    kind: 'mcp_server',
    source,
    authority,
    reason,
    scope: scope.length > 0 ? scope : undefined,
    needsReview: inferred.needsReview,
    detail: commandLine || '(未声明启动命令)',
  };
}

/** 把 package.json 里的一条脚本翻译成能力项 */
export function classifyScript(name: string, command: string, source: string): Capability {
  const risk = analyzeShell(command);

  // 脚本默认按可逆的本地动作算 —— 这是你自己写的构建脚本，
  // 不需要"待人工确认"。只有它真的越界（删、发、花钱）才升级。
  let authority: AuthorityLevel = 2;
  let reason = '本地脚本，只影响工作目录';

  if (risk.destructive.length > 0) {
    authority = 3;
    reason = `包含${risk.destructive.join('、')}`;
  } else if (risk.money.length > 0) {
    authority = 4;
    reason = `包含${risk.money.join('、')}`;
  } else if (risk.egress.length > 0) {
    authority = 3;
    reason = `包含${risk.egress.join('、')}`;
  }

  // 名字本身就说明是发布/部署类的，即使命令文本看不出来也要抬上去
  const byName = inferAuthority(name);
  if (!byName.needsReview && byName.authority > authority) {
    authority = byName.authority;
    reason = byName.reason;
  }

  // 把控制权交给变量或 eval 时，静态分析看不到它到底会做什么
  const opaque = /\b(sh|bash|zsh)\s+-c\b|\beval\b|\$\(|\$\{/.test(command);
  const needsReview = opaque || command.trim() === '';

  return {
    id: name,
    kind: 'script',
    source,
    authority,
    reason: opaque ? `${reason}；命令含变量或 eval，静态看不出实际动作` : reason,
    needsReview,
    detail: command.length > 160 ? `${command.slice(0, 160)}…` : command,
  };
}

export function describeLevel(level: AuthorityLevel): string {
  return `L${level} ${AUTHORITY_LABELS[level]}`;
}
