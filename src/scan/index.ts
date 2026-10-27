import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { homedir } from 'node:os';
import type { DecisionRecord, AuthorityLevel } from '../types.ts';
import { requiredAuthority } from '../policy/authority.ts';
import type { PolicyContext } from '../policy/rules.ts';
import { hookPolicy } from '../hook/policy.ts';
import {
  classifyMcpServer,
  classifyScript,
  describeLevel,
  shortenHome,
} from './classify.ts';
import type { Capability, McpServerDef } from './classify.ts';

export type Severity = 'high' | 'medium' | 'low' | 'info';

export interface Finding {
  code: string;
  severity: Severity;
  title: string;
  detail: string;
  /** 具体该怎么做，一句话 */
  hint?: string;
}

export interface ObservedSummary {
  records: number;
  allow: number;
  escalate: number;
  deny: number;
  /** 需要 L3 以上授权的动作数量 */
  highAuthority: number;
  pendingApprovals: number;
  spendUsd: number;
  /** 实际做过 L3 以上动作的 actor，按次数排序 */
  actors: Array<{ actor: string; highAuthority: number }>;
}

export interface ScanReport {
  root: string;
  scannedAt: string;
  /** 读到了哪些配置文件 */
  sources: string[];
  capabilities: Capability[];
  findings: Finding[];
  observed: ObservedSummary | null;
  hookInstalled: boolean;
  /** 建议策略 —— 就是 `vigil scan --write` 会写进 vigil.config.json 的内容 */
  policy: PolicyContext;
}

export interface ScanOptions {
  root: string;
  /** 已有账本记录。传空数组等价于"没有历史"，null 表示账本不存在 */
  records?: DecisionRecord[] | null;
  /**
   * 是否把用户级配置（~/.claude.json 等）算进来。默认算 ——
   * agent 在本项目里实际拥有的能力，是"全局 + 本项目"的并集，
   * 只扫项目会漏掉最危险的那一半。
   */
  includeUserConfig?: boolean;
}

interface Candidate {
  /** 相对 root 的路径，用于报告展示 */
  label: string;
  path: string;
}

function readJson(path: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function mcpServersOf(raw: Record<string, unknown> | null): Record<string, McpServerDef> {
  if (!raw) return {};
  const direct = raw.mcpServers;
  if (direct && typeof direct === 'object') return direct as Record<string, McpServerDef>;
  const nested = raw.projects;
  if (nested && typeof nested === 'object') {
    const merged: Record<string, McpServerDef> = {};
    for (const value of Object.values(nested as Record<string, unknown>)) {
      const servers = (value as { mcpServers?: Record<string, McpServerDef> })?.mcpServers;
      if (servers) Object.assign(merged, servers);
    }
    return merged;
  }
  return {};
}

const CREDENTIAL_CANDIDATES = [
  '.env',
  '.env.local',
  '.env.production',
  '.npmrc',
  '.pypirc',
  'id_rsa',
  '.aws/credentials',
  '.ssh/id_rsa',
  'secrets',
  '.secrets',
  'service-account.json',
];

const HOOK_COMMAND = /vigil.*\bhook\b|hook\s+claude/;

function hookConfigured(settings: Record<string, unknown> | null): boolean {
  if (!settings) return false;
  const hooks = settings.hooks as Record<string, unknown> | undefined;
  if (!hooks) return false;
  const text = JSON.stringify(hooks);
  return HOOK_COMMAND.test(text);
}

/** 找一个项目里有哪些 agent 配置入口 */
function discoverCandidates(root: string, includeUserConfig: boolean): Candidate[] {
  const candidates: Candidate[] = [];
  const add = (label: string) => {
    if (!includeUserConfig && label.startsWith('~')) return;
    const path = label.startsWith('~') ? join(homedir(), label.slice(1)) : join(root, label);
    if (existsSync(path)) candidates.push({ label, path });
  };
  add('.mcp.json');
  add('.claude/settings.json');
  add('.claude/settings.local.json');
  add('.cursor/mcp.json');
  add('.vscode/mcp.json');
  add('.codex/config.json');
  add('claude_desktop_config.json');
  add('~/.claude.json');
  add('~/Library/Application Support/Claude/claude_desktop_config.json');
  return candidates;
}

/** 只扫项目根目录一层的脚本，别把 node_modules 拖进来 */
function discoverScripts(root: string): Candidate[] {
  const found: Candidate[] = [];
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return found;
  }
  for (const entry of entries) {
    if (!/\.(sh|bash|zsh)$/.test(entry)) continue;
    const path = join(root, entry);
    try {
      if (!statSync(path).isFile()) continue;
      if (statSync(path).size > 64 * 1024) continue;
    } catch {
      continue;
    }
    found.push({ label: entry, path });
  }
  return found;
}

export function scanProject(options: ScanOptions): ScanReport {
  const root = options.root;
  const capabilities: Capability[] = [];
  const sources: string[] = [];
  let hookInstalled = false;

  for (const candidate of discoverCandidates(root, options.includeUserConfig !== false)) {
    const raw = readJson(candidate.path);
    if (!raw) continue;
    sources.push(candidate.label);
    if (hookConfigured(raw)) hookInstalled = true;

    for (const [id, def] of Object.entries(mcpServersOf(raw))) {
      if (!def || typeof def !== 'object') continue;
      capabilities.push(classifyMcpServer(id, def, candidate.label));
    }
  }

  // package.json 的脚本：很多 agent 就是靠 npm run 干活的
  const pkgPath = join(root, 'package.json');
  if (existsSync(pkgPath)) {
    const pkg = readJson(pkgPath);
    sources.push('package.json');
    const scripts = (pkg?.scripts ?? {}) as Record<string, string>;
    for (const [name, command] of Object.entries(scripts)) {
      capabilities.push(classifyScript(name, command, 'package.json'));
    }
  }

  // 根目录的 shell 脚本
  for (const script of discoverScripts(root)) {
    let text = '';
    try {
      text = readFileSync(script.path, 'utf8');
    } catch {
      continue;
    }
    sources.push(script.label);
    capabilities.push(classifyScript(script.label, text.split('\n').slice(0, 40).join(' '), script.label));
  }

  // 凭据文件：存在本身就是一条发现，因为 agent 只要有文件读取能力就能读走
  const credentials = CREDENTIAL_CANDIDATES.filter((entry) => existsSync(join(root, entry)));

  const observed = summarizeObserved(options.records ?? null);
  const findings = buildFindings({ capabilities, credentials, hookInstalled, observed, root });
  const policy = buildPolicy({ capabilities, credentials });

  return {
    root,
    scannedAt: new Date().toISOString(),
    sources,
    capabilities,
    findings,
    observed,
    hookInstalled,
    policy,
  };
}

function summarizeObserved(records: DecisionRecord[] | null): ObservedSummary | null {
  if (!records || records.length === 0) return null;
  const summary: ObservedSummary = {
    records: records.length,
    allow: 0,
    escalate: 0,
    deny: 0,
    highAuthority: 0,
    pendingApprovals: 0,
    spendUsd: 0,
    actors: [],
  };
  const byActor = new Map<string, number>();
  for (const record of records) {
    if (record.outcome === 'allow') summary.allow += 1;
    else if (record.outcome === 'deny') summary.deny += 1;
    else summary.escalate += 1;
    summary.spendUsd += record.costUsd ?? 0;
    if (record.outcome === 'require_human' && !record.approval) summary.pendingApprovals += 1;
    if (requiredAuthority(record.action) >= 3 && record.outcome === 'allow') {
      summary.highAuthority += 1;
      byActor.set(record.actor, (byActor.get(record.actor) ?? 0) + 1);
    }
  }
  summary.actors = [...byActor.entries()]
    .map(([actor, count]) => ({ actor, highAuthority: count }))
    .sort((a, b) => b.highAuthority - a.highAuthority);
  return summary;
}

interface FindingInput {
  capabilities: Capability[];
  credentials: string[];
  hookInstalled: boolean;
  observed: ObservedSummary | null;
  root: string;
}

function buildFindings(input: FindingInput): Finding[] {
  const findings: Finding[] = [];
  const { capabilities, credentials, hookInstalled, observed } = input;

  if (!hookInstalled) {
    findings.push({
      code: 'hook.missing',
      severity: 'high',
      title: '没有检测到执行边界的强制检查',
      detail: '当前配置里没有挂 Vigil 钩子。这意味着 agent 的动作只会被"记录"，不会在动手前被拦下——约束还停留在提示词层面。',
      hint: '把 examples/claude-settings.json 合并进 .claude/settings.json，先开 VIGIL_SHADOW=1 跑一周看误杀率',
    });
  }

  const money = capabilities.filter((cap) => cap.authority === 4);
  if (money.length > 0) {
    findings.push({
      code: 'capability.money',
      severity: 'high',
      title: `发现 ${money.length} 项资金类能力`,
      detail: `涉及：${money.map((cap) => cap.id).join('、')}。资金动作一旦执行不可挽回，必须走审批而不是靠概率判断放行。`,
      hint: '生成的策略已把单笔金额上限压到 0，所有资金动作都会转人工',
    });
  }

  const fsLike = capabilities.filter((cap) => cap.authority >= 2);
  if (credentials.length > 0 && fsLike.length > 0) {
    findings.push({
      code: 'credential.exposed',
      severity: 'high',
      title: `项目内有 ${credentials.length} 个凭据文件，且存在可读文件的能力`,
      detail: `凭据：${credentials.join('、')}。同时有 ${fsLike.length} 项能力（server 与脚本）具备文件或命令访问，理论上足以把这些内容读走。`,
      hint: '已加入禁止清单；更彻底的做法是把凭据移出工作目录',
    });
  } else if (credentials.length > 0) {
    findings.push({
      code: 'credential.present',
      severity: 'medium',
      title: `项目内有 ${credentials.length} 个凭据文件`,
      detail: `凭据：${credentials.join('、')}。当前没有发现可读它们的能力，但一旦新增文件系统或命令类能力就会暴露。`,
      hint: '已加入禁止清单，作为预防',
    });
  }

  const broad = capabilities.filter((cap) =>
    cap.scope?.some((path) => path === '~' || path === '~/'),
  );
  if (broad.length > 0) {
    findings.push({
      code: 'scope.home',
      severity: 'medium',
      title: `${broad.length} 项能力的作用域是整个用户目录`,
      detail: `${broad.map((cap) => cap.id).join('、')} 的启动参数把根目录设成了 ~，等于把整个 home 交给它。`,
      hint: '把根目录收到具体项目路径，权限边界就自然收窄',
    });
  }

  const review = capabilities.filter((cap) => cap.needsReview);
  if (review.length > 0) {
    findings.push({
      code: 'capability.unclear',
      severity: 'medium',
      title: `${review.length} 项能力无法从名字判断边界`,
      detail: `${review.map((cap) => cap.id).join('、')} 已按 L3 保守处理。这些需要你确认一次，否则会一直被当成高危。`,
      hint: '在 vigil.config.json 里为它单独写授权，或者给它改个说得清的名字',
    });
  }

  if (observed) {
    if (observed.pendingApprovals > 0) {
      findings.push({
        code: 'approval.pending',
        severity: 'medium',
        title: `${observed.pendingApprovals} 条升级还在等人批`,
        detail: '账本里有转人工的决策没有对应的审批记录，说明有人在绕过审批流程，或者根本没人在看。',
        hint: 'vigil approvals 看清单，vigil approve <id> approved 落账',
      });
    }
    if (observed.deny > 0) {
      findings.push({
        code: 'observed.denied',
        severity: 'info',
        title: `历史上被否决 ${observed.deny} 次`,
        detail: '这些是最真实的规则验证样本：如果被否决的动作其实是合理业务，说明规则误杀；如果是真的危险，说明规则在起作用。',
        hint: 'vigil postmortem <sessionId> 看当时为什么被拦',
      });
    }
    const top = observed.actors[0];
    if (top && top.highAuthority >= 5) {
      findings.push({
        code: 'actor.concentrated',
        severity: 'medium',
        title: `${top.actor} 独自执行了 ${top.highAuthority} 次高危动作`,
        detail: '高危动作集中在单一 actor 上，一旦它判断出错就是系统性风险，没有交叉校验。',
        hint: '把这类动作拆给两个 actor，或用 Orchestrator 的独立复核',
      });
    }
  }

  if (capabilities.length === 0) {
    findings.push({
      code: 'capability.none',
      severity: 'info',
      title: '没有扫描到任何 agent 能力声明',
      detail: '可能是这个项目还没接 MCP，也可能是配置文件在别处。用 vigil scan <目录> 指定位置再试。',
    });
  }

  return findings;
}

function buildPolicy(input: { capabilities: Capability[]; credentials: string[] }): PolicyContext {
  const base = hookPolicy();
  const extra: string[] = [];
  for (const path of input.credentials) {
    // 目录型凭据按前缀匹配才管用，文件按全名
    extra.push(path);
  }
  const denylistTargets = [...new Set([...base.denylistTargets, ...extra])];
  const hasMoney = input.capabilities.some((cap) => cap.authority === 4);
  return {
    ...base,
    denylistTargets,
    moneyCapPerAction: hasMoney ? 0 : base.moneyCapPerAction,
  };
}

/** 报告里最有用的那几行 —— 让人三十秒内知道该先干什么 */
export function prioritize(report: ScanReport): string[] {
  const lines: string[] = [];
  if (!report.hookInstalled) lines.push('先挂钩子：现在只有记录，没有拦截。');
  const money = report.capabilities.filter((cap) => cap.authority === 4);
  if (money.length > 0) lines.push(`资金能力 ${money.length} 项，上限必须归零走审批。`);
  if (report.findings.some((f) => f.code === 'credential.exposed')) lines.push('凭据文件在工作目录里，先把它们移出去。');
  if (report.observed && report.observed.pendingApprovals > 0) {
    lines.push(`${report.observed.pendingApprovals} 条升级没人批，审批链路是断的。`);
  }
  if (lines.length === 0) lines.push('没有高危项。保持现状，把精力放在积累规则和标签上。');
  return lines;
}

export function levelHistogram(capabilities: Capability[]): Array<{ level: AuthorityLevel; count: number; label: string }> {
  const counts = new Map<AuthorityLevel, number>();
  for (const cap of capabilities) counts.set(cap.authority, (counts.get(cap.authority) ?? 0) + 1);
  return ([4, 3, 2, 1, 0] as AuthorityLevel[])
    .filter((level) => counts.has(level))
    .map((level) => ({ level, count: counts.get(level) ?? 0, label: describeLevel(level) }));
}

export function relativeTo(root: string, path: string): string {
  const rel = relative(root, path);
  return rel === '' ? '.' : shortenHome(rel);
}
