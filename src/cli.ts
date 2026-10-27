#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { Ledger } from './ledger/store.ts';
import { Kernel } from './kernel.ts';
import { JevJudge } from './judge/jev.ts';
import { LocalJudge } from './judge/local.ts';
import { MockJudge } from './judge/mock.ts';
import { postmortem } from './review/postmortem.ts';
import { calibrate } from './review/calibrate.ts';
import { adviseThresholds } from './review/thresholds.ts';
import { scanAlerts } from './alerts.ts';
import { startMcpServer } from './mcp/server.ts';
import { runClaudeHook } from './hook/claude.ts';
import { runWrapped } from './hook/run.ts';
import { hookPolicy } from './hook/policy.ts';
import { exportBundle } from './bundle.ts';
import { toOtelJsonl } from './otel.ts';
import { scanProject, prioritize } from './scan/index.ts';
import { CONFIG_BASENAME, loadPolicyConfig, savePolicyConfig } from './policy/config.ts';
import { Orchestrator, createPipelineKernel } from './pipeline/orchestrator.ts';
import { arbitrate } from './pipeline/arbiter.ts';
import type { Position } from './pipeline/arbiter.ts';
import type { Judge } from './judge/index.ts';
import type { ActionSpec } from './types.ts';
import {
  generateSigningIdentity,
  loadSigningIdentity,
  saveSigningIdentity,
  signBytes,
} from './ledger/signing.ts';
import type { LedgerSigner } from './ledger/store.ts';
import type { PolicyContext } from './policy/rules.ts';
import type { DecisionRequest, OutcomeLabel } from './types.ts';

const LEDGER_PATH = process.env.VIGIL_LEDGER ?? '.vigil/ledger.ndjson';
const KEY_PATH = process.env.VIGIL_SIGNING_KEY ?? '.vigil/signing-key.json';
const THRESHOLDS_PATH = process.env.VIGIL_THRESHOLDS ?? '.vigil/thresholds.json';
const CONFIG_PATH = process.env.VIGIL_CONFIG ?? CONFIG_BASENAME;

/** 有密钥文件就签名，没有就明链。密钥的出现永远是显式动作（vigil keygen）。 */
function buildSigner(): LedgerSigner | null {
  const identity = loadSigningIdentity(KEY_PATH);
  if (!identity) return null;
  return { publicKeyPem: identity.publicKeyPem, sign: (data) => signBytes(identity.privateKeyPem, data) };
}

function loadShapeThresholds(): Record<string, number> | undefined {
  try {
    const raw = JSON.parse(readFileSync(THRESHOLDS_PATH, 'utf8')) as Record<string, number>;
    return Object.keys(raw).length > 0 ? raw : undefined;
  } catch {
    return undefined;
  }
}

function buildLedger(options: { signer?: boolean; publicKeyOnly?: boolean } = {}): Ledger {
  const identity = loadSigningIdentity(KEY_PATH);
  if (options.publicKeyOnly && identity) {
    return new Ledger(LEDGER_PATH, { publicKeyPem: identity.publicKeyPem });
  }
  const signer = options.signer === false ? undefined : buildSigner();
  return new Ledger(LEDGER_PATH, signer ? { signer } : {});
}

/**
 * 没有真实判断模型时，可以用环境变量把假判断器调到指定表现。
 *
 * 例：VIGIL_MOCK_FIXED='{"quality_sufficient":0.9,"acceptance_criteria_met":0.92,"progress":4}'
 * 这是"给假判断器喂一个剧本"，用来演示和复现事故，不是作弊——
 * 换成真模型后这些环境变量就不起作用了。
 */
function mockOptions(): { fixed?: Record<string, number>; choices?: Record<string, string> } {
  const options: { fixed?: Record<string, number>; choices?: Record<string, string> } = {};
  const fixed = process.env.VIGIL_MOCK_FIXED;
  if (fixed) {
    try {
      const parsed = JSON.parse(fixed) as Record<string, number>;
      options.fixed = parsed;
    } catch {
      process.stderr.write('[vigil] VIGIL_MOCK_FIXED 不是合法 JSON，已忽略。\n');
    }
  }
  const choices = process.env.VIGIL_MOCK_CHOICES;
  if (choices) {
    try {
      options.choices = JSON.parse(choices) as Record<string, string>;
    } catch {
      process.stderr.write('[vigil] VIGIL_MOCK_CHOICES 不是合法 JSON，已忽略。\n');
    }
  }
  return options;
}

function buildJudge(): Judge {
  const localUrl = process.env.VIGIL_LOCAL_JUDGE;
  const apiKey = process.env.TYPESAFE_API_KEY;
  if (localUrl) {
    return new LocalJudge({ baseUrl: localUrl, model: process.env.VIGIL_MODEL ?? 'local-decider' });
  }
  if (apiKey) {
    return new JevJudge({ apiKey, model: process.env.VIGIL_MODEL ?? 'jev-latest' });
  }
  if (process.env.VIGIL_QUIET !== '1') {
    process.stderr.write('[vigil] 未检测到 VIGIL_LOCAL_JUDGE 或 TYPESAFE_API_KEY，使用确定性 MockJudge。\n');
  }
  return new MockJudge(mockOptions());
}

function buildKernel(policy?: PolicyContext): Kernel {
  const ledger = buildLedger();
  const judge = buildJudge();
  return new Kernel({ ledger, judge, policy, shapeThresholds: loadShapeThresholds() });
}

/**
 * 实际生效的策略：内置保守默认 ← 覆盖以 vigil.config.json。
 *
 * 顺序很重要：配置文件只能收紧或调整默认值，不能凭空造出一套策略，
 * 这样即使文件被删掉，内核仍然是有策略的。
 */
function currentPolicy(): PolicyContext {
  const config = loadPolicyConfig(CONFIG_PATH);
  if (!config) return hookPolicy();
  return hookPolicy(config);
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

function pad(value: string, width: number): string {
  const visual = [...value].reduce((n, ch) => n + (ch.charCodeAt(0) > 255 ? 2 : 1), 0);
  return value + ' '.repeat(Math.max(0, width - visual));
}

function outcomeBadge(outcome: string): string {
  if (outcome === 'allow') return '放行';
  if (outcome === 'deny') return '否决';
  return '转人工';
}

function levelLabel(level: number): string {
  const labels: Record<number, string> = {
    0: 'L0 只读',
    1: 'L1 草稿',
    2: 'L2 可逆写入',
    3: 'L3 对外/不可逆',
    4: 'L4 资金',
  };
  return labels[level] ?? `L${level}`;
}

function usage(): void {
  process.stdout.write(`vigil — AI 决策账本与熔断内核

用法：
  vigil scan [目录] [--write] [--json]  扫描 agent 能力并生成治理配置（--write 立即生效）
  vigil arbitrate <文件.json|->    多 agent 结论冲突时定夺
  vigil decide <文件.json|->     请求裁决，结果写入账本
  vigil run -- <命令>            包住一条 shell 命令，先裁决再执行
  vigil hook claude [--shadow]  作为 Claude Code 的 PreToolUse 钩子运行
  vigil ledger [--json]          列出全部决策
  vigil verify                   校验哈希链与签名完整性
  vigil keygen                   生成 Ed25519 签名身份（之后的记录全部签名）
  vigil bundle [文件]            导出离线验证包（含公钥，配 verify-standalone.mjs 用）
  vigil thresholds [--write]     按题型推荐置信度阈值；--write 写入配置立即生效
  vigil approvals                列出待人工审批的升级项
  vigil approve <id> <approved|rejected> [备注] [--by 审批人]
  vigil export-otel [文件]       导出 OTel GenAI JSONL（喂给 Langfuse/Phoenix）
  vigil postmortem <sessionId>   事后梳理
  vigil calibrate [问题名]        置信度校准（默认 proceed）
  vigil alerts                   扫描预警
  vigil label <decisionId> <correct|wrong|unknown> [备注]
  vigil mcp                      以 MCP stdio 服务端方式运行

环境变量：
  TYPESAFE_API_KEY     有则使用 Jev；VIGIL_LOCAL_JUDGE 优先
  VIGIL_LOCAL_JUDGE    本地决策服务地址（strands-decider/laya），如 http://127.0.0.1:8000/v1/systemone
  VIGIL_MOCK_FIXED     给 MockJudge 喂剧本，如 {"progress":4,"quality_sufficient":0.9}
  VIGIL_MOCK_CHOICES   给 MockJudge 指定选择题答案，如 {"next_worker":"bot/writer"}
  VIGIL_LEDGER         账本路径，默认 .vigil/ledger.ndjson
  VIGIL_CONFIG         策略配置路径，默认 vigil.config.json
  VIGIL_SIGNING_KEY    签名密钥路径，默认 .vigil/signing-key.json
  VIGIL_THRESHOLDS     按题型阈值配置，默认 .vigil/thresholds.json
  VIGIL_MODEL          模型名，默认 jev-latest
  VIGIL_SHADOW=1     影子模式：只记账不拦截
  VIGIL_ACTOR        agent 在账本里的身份，默认 agent/claude
`);
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);

  switch (command) {
    case 'decide': {
      const source = rest[0];
      let raw: string;
      if (!source || source === '-') raw = await readStdin();
      else raw = readFileSync(source, 'utf8');
      const request = JSON.parse(raw) as DecisionRequest;
      const kernel = buildKernel();
      const verdict = await kernel.decide(request);
      process.stdout.write(`${JSON.stringify(verdict, null, 2)}\n`);
      if (verdict.outcome !== 'allow') process.exitCode = 2;
      return;
    }

    case 'ledger': {
      const ledger = buildLedger({ publicKeyOnly: true });
      const records = ledger.all();
      if (rest.includes('--json')) {
        process.stdout.write(`${JSON.stringify(records, null, 2)}\n`);
        return;
      }
      process.stdout.write(`${pad('#', 4)}${pad('结论', 8)}${pad('actor', 20)}${pad('动作', 26)}意图\n`);
      for (const record of records) {
        process.stdout.write(
          `${pad(String(record.seq), 4)}${pad(outcomeBadge(record.outcome), 8)}${pad(record.actor, 20)}${pad(record.action.kind, 26)}${record.intent}\n`,
        );
      }
      process.stdout.write(`\n共 ${records.length} 条，账本 ${LEDGER_PATH}\n`);
      return;
    }

    case 'verify': {
      const ledger = buildLedger({ publicKeyOnly: true });
      const result = ledger.verify();
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      if (!result.ok) process.exitCode = 1;
      return;
    }

    case 'keygen': {
      const identity = generateSigningIdentity();
      saveSigningIdentity(identity, KEY_PATH);
      process.stdout.write(`已生成签名身份：${KEY_PATH}\n公钥：\n${identity.publicKeyPem}\n`);
      process.stdout.write('此后所有新记录都会被 Ed25519 签名。私钥务必备份——丢了就不能再追加能通过验签的记录。\n');
      return;
    }

    case 'bundle': {
      const ledger = buildLedger({ publicKeyOnly: true });
      const identity = loadSigningIdentity(KEY_PATH);
      const bundle = exportBundle(ledger, identity?.publicKeyPem);
      const out = rest[0] ?? 'vigil-bundle.json';
      writeFileSync(out, JSON.stringify(bundle, null, 2) + '\n', 'utf8');
      process.stdout.write(`已导出 ${bundle.count} 条记录到 ${out}\n离线验证：node verify-standalone.mjs ${out}\n`);
      return;
    }

    case 'thresholds': {
      const ledger = buildLedger({ publicKeyOnly: true });
      const report = adviseThresholds(ledger.all());
      if (rest.includes('--json')) {
        process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
        return;
      }
      if (report.advices.length === 0) process.stdout.write('暂无可建议：先回填标签（vigil label），每题型至少 5 条。\n');
      process.stdout.write(`${pad('题型', 12)}${pad('样本', 8)}${pad('推荐floor', 12)}${pad('实测精度', 12)}自动放行率\n`);
      for (const advice of report.advices) {
        process.stdout.write(
          `${pad(advice.shape, 12)}${pad(String(advice.samples), 8)}${pad(advice.floor.toFixed(2), 12)}${pad((advice.precision * 100).toFixed(0) + '%', 12)}${(advice.coverage * 100).toFixed(0)}%\n`,
        );
      }
      for (const item of report.insufficient) {
        process.stdout.write(`· ${item.shape}：样本 ${item.samples} 条，不足或达不到目标精度，暂不自动放行\n`);
      }
      if (rest.includes('--write')) {
        writeFileSync(THRESHOLDS_PATH, JSON.stringify(report.suggested, null, 2) + '\n', 'utf8');
        process.stdout.write(`\n已写入 ${THRESHOLDS_PATH} —— 内核下次启动即按题型生效。\n`);
      }
      return;
    }

    case 'approvals': {
      const ledger = buildLedger({ publicKeyOnly: true });
      const pending = ledger.pendingApprovals();
      if (pending.length === 0) {
        process.stdout.write('没有待审批的升级项。\n');
        return;
      }
      for (const record of pending) {
        process.stdout.write(`[${record.decisionId}] #${record.seq} ${record.actor}：${record.intent}\n  └ ${record.hardBlocks.map((b) => b.detail).join('；') || '概率判断把握不足'}\n`);
      }
      return;
    }

    case 'approve':
    case 'reject': {
      const decisionId = rest[0];
      const noteIndex = rest.findIndex((item) => item === '--by');
      const by = noteIndex >= 0 ? (rest[noteIndex + 1] ?? 'human/unknown') : 'human/unknown';
      const note = rest.slice(1, noteIndex >= 0 ? noteIndex : undefined).filter((item) => item !== '--by').join(' ') || undefined;
      if (!decisionId) throw new Error(`用法：vigil ${command} <decisionId> [备注] [--by 审批人]`);
      const ledger = buildLedger({ publicKeyOnly: true });
      const info = ledger.approve({ decisionId, decision: command === 'approve' ? 'approved' : 'rejected', approver: by, note });
      process.stdout.write(`已落账：${decisionId} = ${info.decision}（审批人 ${info.approver}，绑定哈希 ${info.boundHash.slice(0, 12)}…）\n`);
      return;
    }

    case 'export-otel': {
      const ledger = buildLedger({ publicKeyOnly: true });
      const jsonl = toOtelJsonl(ledger.all());
      const out = rest[0];
      if (out) writeFileSync(out, jsonl + '\n', 'utf8');
      else process.stdout.write(jsonl + '\n');
      if (out) process.stdout.write(`已导出 OTel span 到 ${out}\n`);
      return;
    }

    case 'postmortem': {
      const sessionId = rest[0];
      if (!sessionId) throw new Error('缺少 sessionId');
      const ledger = buildLedger({ publicKeyOnly: true });
      const report = postmortem(ledger, sessionId);
      if (rest.includes('--json')) {
        process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
        return;
      }
      process.stdout.write(`会话 ${report.sessionId}\n`);
      process.stdout.write(`决策 ${report.decisions} 条，花费 ${report.spendUsd.toFixed(4)} 美元，哈希链${report.chainOk ? '完好' : '已损坏'}\n\n`);
      process.stdout.write('时间线：\n');
      for (const entry of report.timeline) {
        process.stdout.write(`  ${pad(`#${entry.seq}`, 6)}${pad(outcomeBadge(entry.outcome), 8)}${pad(entry.actor, 18)}${entry.intent}\n`);
        process.stdout.write(`        └ ${entry.reason}\n`);
      }
      process.stdout.write('\n转折点：\n');
      report.turningPoints.forEach((line) => process.stdout.write(`  · ${line}\n`));
      if (report.missingEvidence.length > 0) {
        process.stdout.write('\n缺失证据：\n');
        report.missingEvidence.forEach((line) => process.stdout.write(`  · ${line}\n`));
      }
      if (report.falsified.length > 0) {
        process.stdout.write('\n被证伪：\n');
        report.falsified.forEach((item) => process.stdout.write(`  · [${item.decisionId}] ${item.intent}${item.note ? `（${item.note}）` : ''}\n`));
      }
      process.stdout.write('\n指标：\n');
      const m = report.metrics;
      process.stdout.write(`  放行 ${(m.allowRate * 100).toFixed(0)}%  转人工 ${(m.escalateRate * 100).toFixed(0)}%  否决 ${(m.denyRate * 100).toFixed(0)}%\n`);
      process.stdout.write(`  可追溯率 ${(m.traceableRate * 100).toFixed(0)}%  虚假完成率 ${(m.falseDoneRate * 100).toFixed(0)}%  已回填 ${m.labeled} 条\n`);
      process.stdout.write('\n结论：\n');
      report.findings.forEach((line) => process.stdout.write(`  · ${line}\n`));
      return;
    }

    case 'calibrate': {
      const ledger = buildLedger({ publicKeyOnly: true });
      const report = calibrate(ledger.all(), { question: rest[0] });
      if (rest.includes('--json')) {
        process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
        return;
      }
      process.stdout.write(`判断「${report.question}」，已标注样本 ${report.samples} 条\n`);
      if (report.brier !== null) process.stdout.write(`Brier ${report.brier}，ECE ${report.ece}\n\n`);
      if (report.bins.length > 0) {
        process.stdout.write(`${pad('区间', 12)}${pad('样本', 8)}${pad('自报概率', 12)}实际正确率\n`);
        for (const bin of report.bins) {
          process.stdout.write(`${pad(bin.range, 12)}${pad(String(bin.n), 8)}${pad(bin.predicted.toFixed(3), 12)}${bin.actual.toFixed(3)}\n`);
        }
      }
      if (report.sweep.length > 0) {
        process.stdout.write(`\n阈值扫描（floor 设多少合适）：\n${pad('floor', 10)}${pad('覆盖率', 10)}通过后正确率\n`);
        for (const point of report.sweep) {
          process.stdout.write(`${pad(point.floor.toFixed(2), 10)}${pad((point.coverage * 100).toFixed(0) + '%', 10)}${(point.precision * 100).toFixed(0)}%\n`);
        }
      }
      process.stdout.write(`\n结论：${report.verdict}\n`);
      return;
    }

    case 'alerts': {
      const ledger = buildLedger({ publicKeyOnly: true });
      const alerts = scanAlerts(ledger, {
        windowMs: rest[0] ? Number(rest[0]) : undefined,
        costCapUsd: process.env.VIGIL_COST_CAP ? Number(process.env.VIGIL_COST_CAP) : undefined,
      });
      if (alerts.length === 0) {
        process.stdout.write('无预警。\n');
        return;
      }
      for (const alert of alerts) {
        process.stdout.write(`[${alert.severity.toUpperCase()}] ${alert.title}\n  ${alert.detail}\n  关联：${alert.refs.join(', ') || '无'}\n\n`);
      }
      if (alerts.some((a) => a.severity === 'critical')) process.exitCode = 1;
      return;
    }

    case 'label': {
      const [decisionId, label, note] = rest;
      if (!decisionId || !label) throw new Error('用法：vigil label <decisionId> <correct|wrong|unknown> [备注]');
      const ledger = buildLedger({ publicKeyOnly: true });
      ledger.label(decisionId, label as OutcomeLabel, note);
      process.stdout.write(`已回填 ${decisionId} = ${label}\n`);
      return;
    }

    case 'scan': {
      const target = rest.find((item) => !item.startsWith('-'));
      const root = target ?? '.';
      const records = existsSync(LEDGER_PATH) ? buildLedger({ publicKeyOnly: true }).all() : null;
      const report = scanProject({ root, records });

      if (rest.includes('--json')) {
        process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      } else {
        process.stdout.write(`扫描 ${report.root}\n`);
        process.stdout.write(`读取配置：${report.sources.length > 0 ? report.sources.join('、') : '未发现任何 agent 配置'}\n\n`);

        if (report.capabilities.length > 0) {
          // 只把真正需要看的摆出来：L3 以上、或不确认就有风险的能力。
          // 满屏 L2 的 build/test 只会让人关掉这个命令。
          const notable = report.capabilities
            .filter((cap) => cap.authority >= 3 || cap.needsReview)
            .sort((a, b) => b.authority - a.authority);
          const quiet = report.capabilities.length - notable.length;

          if (notable.length > 0) {
            process.stdout.write('值得注意的能力：\n');
            process.stdout.write(`${pad('等级', 18)}${pad('名称', 26)}${pad('来源', 22)}说明\n`);
            for (const cap of notable) {
              const badge = cap.needsReview ? `${levelLabel(cap.authority)}?` : levelLabel(cap.authority);
              const scope = cap.scope ? `（作用域 ${cap.scope.join(' ')}）` : '';
              process.stdout.write(
                `${pad(badge, 18)}${pad(cap.id, 26)}${pad(cap.source, 22)}${cap.reason}${scope}\n`,
              );
            }
            process.stdout.write('\n');
          }
          if (quiet > 0) {
            process.stdout.write(`另有 ${quiet} 项 L2 及以下能力（本地脚本等），只在 JSON 里列出。\n\n`);
          }
        }

        if (report.observed) {
          const o = report.observed;
          process.stdout.write(
            `账本历史：${o.records} 条决策，放行 ${o.allow} / 转人工 ${o.escalate} / 否决 ${o.deny}，高危动作 ${o.highAuthority} 次，花费 ${o.spendUsd.toFixed(2)} 美元\n\n`,
          );
        }

        if (report.findings.length > 0) {
          process.stdout.write('发现：\n');
          const order: Record<string, number> = { high: 0, medium: 1, low: 2, info: 3 };
          const sorted = [...report.findings].sort((a, b) => order[a.severity]! - order[b.severity]!);
          for (const finding of sorted) {
            process.stdout.write(`[${finding.severity.toUpperCase()}] ${finding.title}\n  ${finding.detail}\n`);
            if (finding.hint) process.stdout.write(`  → ${finding.hint}\n`);
          }
          process.stdout.write('\n');
        }

        process.stdout.write('先做这些：\n');
        prioritize(report).forEach((line) => process.stdout.write(`  · ${line}\n`));

        if (rest.includes('--write')) {
          if (existsSync(CONFIG_PATH) && !rest.includes('--force')) {
            process.stdout.write(`\n${CONFIG_PATH} 已存在，未覆盖。确认要重写就加 --force。\n`);
          } else {
            savePolicyConfig(CONFIG_PATH, report.policy);
            process.stdout.write(`\n已写入 ${CONFIG_PATH} —— 下次启动的钩子与 run 会按它执行。\n`);
            process.stdout.write(`单笔金额上限 ${report.policy.moneyCapPerAction} 美元，禁止清单 ${report.policy.denylistTargets.length} 项。\n`);
          }
        } else {
          process.stdout.write('\n（加 --write 把上面的建议策略写进 vigil.config.json 并立即生效）\n');
        }
      }

      if (report.findings.some((finding) => finding.severity === 'high')) process.exitCode = 2;
      return;
    }

    case 'mcp': {
      // 统筹循环与仲裁用带流水线规则的内核（验收清单、仲裁结论等确定性规则），
      // 与对外动作的内核共用同一本账本。
      const ledger = buildLedger();
      const judge = buildJudge();
      const kernel = new Kernel({
        ledger,
        judge,
        policy: currentPolicy(),
        shapeThresholds: loadShapeThresholds(),
      });
      const pipelineKernel = createPipelineKernel(ledger, judge, currentPolicy(), {
        shapeThresholds: loadShapeThresholds(),
      });
      const orchestrator = new Orchestrator(pipelineKernel);
      startMcpServer(kernel, { orchestrator, pipelineKernel });
      return;
    }

    case 'arbitrate': {
      const source = rest[0];
      let raw: string;
      if (!source || source === '-') raw = await readStdin();
      else raw = readFileSync(source, 'utf8');
      const input = JSON.parse(raw) as {
        sessionId?: string;
        taskId?: string;
        question?: string;
        positions?: Position[];
        action?: ActionSpec;
        forceEscalation?: boolean;
      };
      const ledger = buildLedger();
      const judge = buildJudge();
      const pipelineKernel = createPipelineKernel(ledger, judge, currentPolicy(), {
        shapeThresholds: loadShapeThresholds(),
      });
      const result = await arbitrate(pipelineKernel, {
        sessionId: input.sessionId ?? `sess_arb_${Date.now().toString(36)}`,
        taskId: input.taskId,
        question: input.question ?? '未说明争议内容',
        positions: input.positions ?? [],
        action: input.action ?? { kind: 'arbitrate', reversible: true, external: false },
        forceEscalation: input.forceEscalation,
      });
      if (rest.includes('--json')) {
        process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      } else {
        process.stdout.write(`仲裁结论：${result.decision}\n`);
        process.stdout.write(`走的阶梯：${result.resolution}\n`);
        process.stdout.write(`理由：${result.reason}\n`);
        if (result.winner) {
          process.stdout.write(`采信：${result.winner.actor}（${result.winner.conclusion}）—— ${result.winner.reason}\n`);
        }
        for (const item of result.overruled) {
          process.stdout.write(`压下：${item.actor}（${item.conclusion}）—— ${item.reason}\n`);
        }
        process.stdout.write(`\n决策号 ${result.verdict.decisionId}，记录哈希 ${result.verdict.recordHash.slice(0, 12)}…\n`);
      }
      if (result.decision !== 'allow') process.exitCode = 2;
      return;
    }

    case 'hook': {
      const target = rest[0];
      if (target !== 'claude') throw new Error(`不支持的钩子目标：${target ?? '(空)'}。目前支持：claude`);
      await runClaudeHook(buildKernel(currentPolicy()), {
        shadow: rest.includes('--shadow'),
        timeoutMs: process.env.VIGIL_HOOK_TIMEOUT ? Number(process.env.VIGIL_HOOK_TIMEOUT) : undefined,
        actor: process.env.VIGIL_ACTOR,
      });
      return;
    }

    case 'run': {
      const separator = rest.indexOf('--');
      const command = (separator >= 0 ? rest.slice(separator + 1) : rest).join(' ').trim();
      if (!command) throw new Error('用法：vigil run -- <命令>');
      const code = await runWrapped(buildKernel(currentPolicy()), command, {
        shadow: process.env.VIGIL_SHADOW === '1',
        actor: process.env.VIGIL_ACTOR,
      });
      process.exitCode = code;
      return;
    }

    default:
      usage();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`vigil: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
