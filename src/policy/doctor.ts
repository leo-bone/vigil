import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { SigningIdentity } from '../ledger/signing.ts';
import { generateSigningIdentity, loadSigningIdentity, saveSigningIdentity } from '../ledger/signing.ts';
import { loadPacks } from './pack.ts';
import { readKillState } from './killswitch.ts';
import { readIndex, readTrustStore, writeTrustStore, addTrustedKey, TRUST_FILE } from './registry.ts';

/**
 * 体检（Doctor）与初始化（Init）。
 *
 * 对标 ECC 的 `doctor` / `repair`：装上不等于能用，
 * "能不能用"必须能自己查出来，而不是等出事才发现。
 */

export interface CheckResult {
  name: string;
  ok: boolean;
  /** ok=false 时是问题，ok=true 时是补充说明 */
  detail: string;
  /** 能不能自己修 */
  fixable?: boolean;
}

export interface DoctorOptions {
  ledgerPath?: string;
  packsDir?: string;
  keyPath?: string;
  indexPath?: string;
  /** 信任公钥列表路径 */
  trustPath?: string;
  /** 紧急制动标记文件路径 */
  killSwitchPath?: string;
  /** Claude Code 的 settings 文件路径 */
  claudeSettingsPath?: string;
  /** Claude Code 的插件目录 */
  claudePluginDir?: string;
}

/** 找 Claude Code 的 settings 文件。优先项目级，再找用户级。 */
export function findClaudeSettings(cwd: string): string | null {
  const candidates = [
    join(cwd, '.claude', 'settings.json'),
    join(process.env.HOME ?? '', '.claude', 'settings.json'),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * 体检。
 *
 * 顺序按"出问题后影响多大"排：账本写不进去最致命，
 * 钩子没装次之，规则包没加载最轻。
 */
export function doctor(options: DoctorOptions = {}): CheckResult[] {
  const results: CheckResult[] = [];
  const ledgerPath = options.ledgerPath ?? '.vigil/ledger.ndjson';
  const packsDir = options.packsDir ?? '.vigil/packs';
  const keyPath = options.keyPath ?? '.vigil/signing-key.json';

  // 1. 账本
  const ledgerDir = dirname(ledgerPath);
  if (!existsSync(ledgerDir)) {
    results.push({
      name: '账本目录',
      ok: false,
      detail: `${ledgerDir} 不存在，内核会自己创建，但确认一下路径对不对`,
      fixable: true,
    });
  } else {
    results.push({ name: '账本目录', ok: true, detail: ledgerDir });
  }

  // 2. 签名密钥
  let identity: SigningIdentity | null = null;
  try {
    identity = loadSigningIdentity(keyPath);
  } catch (error) {
    results.push({
      name: '签名密钥',
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
      fixable: true,
    });
  }
  if (identity) {
    results.push({
      name: '签名密钥',
      ok: true,
      detail: `${keyPath}（创建于 ${identity.createdAt ?? '未知'}）`,
    });
  } else if (!results.some((item) => item.name === '签名密钥')) {
    results.push({
      name: '签名密钥',
      ok: false,
      detail: '还没有签名密钥。没有它账本能写，但改了没人能发现。跑 vigil init 生成',
      fixable: true,
    });
  }

  // 3. 规则包
  const packs = loadPacks(packsDir);
  if (packs.errors.length > 0) {
    results.push({
      name: '规则包',
      ok: false,
      detail: `${packs.errors.length} 个包加载失败：${packs.errors[0]}`,
    });
  } else if (packs.packs.length === 0) {
    results.push({
      name: '规则包',
      ok: true,
      detail: `没装任何规则包（${packsDir}）——默认规则仍在生效`,
    });
  } else {
    results.push({
      name: '规则包',
      ok: true,
      detail: `${packs.packs.length} 个：${packs.packs.map((pack) => pack.id).join('、')}`,
    });
  }

  // 4. 紧急制动状态
  const kill = readKillState(options.killSwitchPath ?? '.vigil/killed');
  results.push({
    name: '紧急制动',
    ok: !kill.active,
    detail: kill.active
      ? `已启用（自 ${kill.since ?? '未知'}）${kill.reason ? `：${kill.reason}` : ''} —— 所有动作都在转人工`
      : '未启用',
  });

  // 5. 信任的公钥
  const trustPath = options.trustPath ?? '.vigil/trusted-keys.json';
  const trust = readTrustStore(trustPath);
  results.push({
    name: '信任的公钥',
    ok: trust.keys.length > 0,
    detail:
      trust.keys.length > 0
        ? `${trust.keys.length} 个：${trust.keys.map((key) => key.name).join('、')}`
        : '信任列表是空的 —— 带签名的规则包一律装不了（这是故意的）',
  });

  // 6. 规则包索引
  const indexPath = options.indexPath ?? 'vigil.rules.json';
  try {
    const index = readIndex(indexPath);
    results.push({
      name: '规则包索引',
      ok: true,
      detail: `${indexPath}，${index.packs.length} 个包`,
    });
  } catch (error) {
    results.push({
      name: '规则包索引',
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
    });
  }

  // 7. Claude Code 钩子
  const settingsPath = options.claudeSettingsPath ?? findClaudeSettings(process.cwd());
  if (!settingsPath) {
    results.push({
      name: 'Claude Code 钩子',
      ok: false,
      detail: '没找到 .claude/settings.json —— 钩子没装的话，agent 的动作根本不会经过 Vigil。跑 vigil init 生成配置',
      fixable: true,
    });
  } else {
    try {
      const raw = readFileSync(settingsPath, 'utf8');
      const settings = JSON.parse(raw) as {
        hooks?: Record<string, Array<{ matcher?: string; hooks?: Array<{ command?: string }> }>>;
      };
      const commands = Object.values(settings.hooks ?? {})
        .flat()
        .flatMap((entry) => entry.hooks ?? [])
        .map((entry) => entry.command ?? '')
        .filter((command) => command.includes('vigil'));
      if (commands.length === 0) {
        results.push({
          name: 'Claude Code 钩子',
          ok: false,
          detail: `${settingsPath} 里没有 vigil 钩子。跑 vigil init 接入`,
          fixable: true,
        });
      } else {
        const events = Object.entries(settings.hooks ?? {})
          .filter(([, entries]) =>
            entries.some((entry) => (entry.hooks ?? []).some((hook) => (hook.command ?? '').includes('vigil'))),
          )
          .map(([event]) => event);
        results.push({
          name: 'Claude Code 钩子',
          ok: true,
          detail: `${settingsPath}，已接入 ${events.length} 个生命周期点：${events.join('、')}`,
        });
      }
    } catch (error) {
      results.push({
        name: 'Claude Code 钩子',
        ok: false,
        detail: `${settingsPath} 读不出来：${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }

  return results;
}

/**
 * 初始化。
 *
 * 一次做完三件事：生成签名密钥、写入规则包目录、
 * 生成 Claude Code 钩子配置片段（默认写到一个文件里让人自己合并，
 * 因为直接改用户的 .claude/settings.json 风险太大）。
 */
export interface InitOptions {
  cwd?: string;
  keyPath?: string;
  packsDir?: string;
  /** 是否直接改 Claude Code 的 settings.json。默认 false —— 只产出片段。 */
  writeClaudeSettings?: boolean;
  /** 钩子命令模板。默认走 npx 之外的本地路径。 */
  hookCommand?: string;
}

export interface InitResult {
  keyPath?: string;
  packsDir: string;
  settingsSnippetPath?: string;
  settingsPath?: string;
  createdKey: boolean;
  notes: string[];
}

export function init(options: InitOptions = {}): InitResult {
  const cwd = options.cwd ?? process.cwd();
  const keyPath = options.keyPath ?? join(cwd, '.vigil', 'signing-key.json');
  const packsDir = options.packsDir ?? join(cwd, '.vigil', 'packs');
  const notes: string[] = [];

  // 1. 签名密钥
  let createdKey = false;
  if (!existsSync(keyPath)) {
    const identity = generateSigningIdentity();
    saveSigningIdentity(identity, keyPath);
    createdKey = true;
    notes.push(`已生成签名密钥：${keyPath}（私钥别外传）`);
  } else {
    notes.push(`签名密钥已存在：${keyPath}`);
  }

  // 1.5 自己的公钥进信任列表 —— 否则自己签的包自己都装不了
  try {
    const identity = loadSigningIdentity(keyPath);
    if (identity) {
      const trustPath = join(cwd, '.vigil', 'trusted-keys.json');
      const store = readTrustStore(trustPath);
      const result = addTrustedKey(store, '本机', identity.publicKeyPem);
      if (result.added) {
        writeTrustStore(result.store, trustPath);
        notes.push('已把本机公钥加入信任列表');
      }
    }
  } catch {
    /* 信任列表写不进去不算致命 */
  }

  // 2. 规则包目录
  if (!existsSync(packsDir)) {
    mkdirSync(packsDir, { recursive: true });
    notes.push(`已创建规则包目录：${packsDir}`);
  }

  // 3. Claude Code 钩子
  const hookCommand = options.hookCommand ?? 'node /absolute/path/to/vigil/src/cli.ts hook claude';
  const events = ['PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'SessionStart', 'Stop', 'SessionEnd'];
  const snippet = {
    _comment:
      '把下面这段合并进 .claude/settings.json 的 hooks 里。command 里的路径改成你本机的绝对路径。',
    hooks: Object.fromEntries(
      events.map((event) => [
        event,
        [
          {
            matcher: event === 'PreToolUse' ? 'Bash|Write|Edit|MultiEdit|NotebookEdit|WebFetch|WebSearch|mcp__.*' : '.*',
            hooks: [{ type: 'command', command: hookCommand, timeout: 10 }],
          },
        ],
      ]),
    ),
  };

  let settingsSnippetPath: string | undefined;
  let settingsPath: string | undefined;
  const target = findClaudeSettings(cwd);
  if (options.writeClaudeSettings && target) {
    // 明确要求才改用户的 settings.json：先把现有的读出来再合并
    const existing = JSON.parse(readFileSync(target, 'utf8')) as Record<string, unknown>;
    const merged = {
      ...existing,
      hooks: {
        ...((existing.hooks as Record<string, unknown>) ?? {}),
        ...snippet.hooks,
      },
    };
    writeFileSync(target, `${JSON.stringify(merged, null, 2)}\n`, 'utf8');
    settingsPath = target;
    notes.push(`已写入 Claude Code 钩子配置：${target}`);
  } else {
    const snippetPath = join(cwd, '.vigil', 'claude-hooks.json');
    if (!existsSync(dirname(snippetPath))) mkdirSync(dirname(snippetPath), { recursive: true });
    writeFileSync(snippetPath, `${JSON.stringify(snippet, null, 2)}\n`, 'utf8');
    settingsSnippetPath = snippetPath;
    notes.push(`已生成钩子配置片段：${snippetPath}`);
    notes.push(
      target
        ? `合并到 ${target}（可以用 --write-claude-settings 直接写入）`
        : '没找到 .claude/settings.json，把片段手动合并进去',
    );
  }

  return { keyPath: createdKey ? keyPath : undefined, packsDir, settingsSnippetPath, settingsPath, createdKey, notes };
}
