import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { inferAuthority, classifyScript, extractScope, classifyMcpServer } from '../src/scan/classify.ts';
import { scanProject } from '../src/scan/index.ts';
import { parsePolicyConfig, savePolicyConfig, loadPolicyConfig } from '../src/policy/config.ts';
import { hookPolicy } from '../src/hook/policy.ts';
import type { DecisionRecord } from '../src/types.ts';

function fixture(): string {
  const dir = mkdtempSync(join(tmpdir(), 'vigil-scan-'));
  return dir;
}

test('能力识别：只读意图优先，不能被 github 三个字误判成 L3', () => {
  assert.equal(inferAuthority('github_search_issues').authority, 0);
  assert.equal(inferAuthority('github_create_issue').authority, 3);
  assert.equal(inferAuthority('slack_send_message').authority, 3);
  assert.equal(inferAuthority('stripe_create_charge').authority, 4);
  assert.equal(inferAuthority('filesystem').authority, 2);
  assert.equal(inferAuthority('mcp-server-memory').authority, 2);
});

test('能力识别：看不懂的名字按 L3 保守处理并标记待确认', () => {
  const result = inferAuthority('internal-crm');
  assert.equal(result.authority, 3);
  assert.equal(result.needsReview, true);
});

test('能力识别：远程 server 一律算对外，因为数据离开本机', () => {
  const cap = classifyMcpServer('analytics', { url: 'https://mcp.example.com/sse' }, '.mcp.json');
  assert.equal(cap.authority, 3);
  assert.ok(cap.reason.includes('远程'));
});

test('作用域提取：文件系统 server 的根目录是它的真实权限边界', () => {
  const scope = extractScope(['-y', '@modelcontextprotocol/server-filesystem', homedir()]);
  assert.deepEqual(scope, ['~']);
});

test('脚本识别：构建脚本不该被当成高危，越界的才升级', () => {
  const build = classifyScript('build', 'tsc -p .', 'package.json');
  assert.equal(build.authority, 2);
  assert.equal(build.needsReview, false);

  const clean = classifyScript('clean', 'rm -rf dist', 'package.json');
  assert.equal(clean.authority, 3);
  assert.ok(clean.reason.includes('递归'));

  const deploy = classifyScript('deploy', 'vercel deploy --prod', 'package.json');
  assert.equal(deploy.authority, 3);

  const opaque = classifyScript('run', 'bash -c "$CMD"', 'package.json');
  assert.equal(opaque.needsReview, true);
});

test('扫描：能识别出资金能力、凭据暴露、缺少钩子三件大事', () => {
  const dir = fixture();
  writeFileSync(
    join(dir, '.mcp.json'),
    JSON.stringify({
      mcpServers: {
        stripe: { command: 'npx', args: ['-y', '@stripe/mcp'] },
        filesystem: { command: 'npx', args: ['-y', 'server-filesystem', homedir()] },
        mystery: { command: 'node', args: ['thing.js'] },
      },
    }),
  );
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: { build: 'tsc -p .', clean: 'rm -rf dist' } }));
  writeFileSync(join(dir, '.env'), 'TOKEN=abc\n');

  const report = scanProject({ root: dir, includeUserConfig: false });

  assert.ok(report.capabilities.some((cap) => cap.id === 'stripe' && cap.authority === 4));
  assert.ok(report.capabilities.some((cap) => cap.id === 'build' && cap.authority === 2));
  assert.ok(report.capabilities.some((cap) => cap.id === 'clean' && cap.authority === 3));

  const codes = report.findings.map((finding) => finding.code);
  assert.ok(codes.includes('capability.money'));
  assert.ok(codes.includes('credential.exposed'));
  assert.ok(codes.includes('hook.missing'));
  assert.ok(codes.includes('scope.home'));

  assert.equal(report.policy.moneyCapPerAction, 0, '有资金能力时单笔上限必须归零');
  assert.ok(report.policy.denylistTargets.includes('.env'), '凭据文件要进禁止清单');
  assert.equal(report.hookInstalled, false);
});

test('扫描：挂了钩子就不再报"没有强制检查"', () => {
  const dir = fixture();
  mkdirSync(join(dir, '.claude'), { recursive: true });
  writeFileSync(
    join(dir, '.claude', 'settings.json'),
    JSON.stringify({
      hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'node vigil/src/cli.ts hook claude' }] }] },
    }),
  );
  const report = scanProject({ root: dir, includeUserConfig: false });
  assert.equal(report.hookInstalled, true);
  assert.ok(!report.findings.some((finding) => finding.code === 'hook.missing'));
});

test('扫描：把账本历史算进报告，能看出高危动作集中在谁身上', () => {
  const dir = fixture();
  const record = (overrides: Partial<DecisionRecord>): DecisionRecord =>
    ({
      decisionId: 'd',
      ts: '2026-10-27T00:00:00.000Z',
      sessionId: 's',
      actor: 'bot/outbound',
      intent: '发邮件',
      action: { kind: 'send_email', target: 'a@b.com', reversible: false, external: true },
      required: 3,
      granted: 3,
      hardBlocks: [],
      judgments: [],
      outcome: 'allow',
      evidenceIds: [],
      evidenceHash: 'h',
      costUsd: 0,
      prevHash: '0',
      hash: 'h',
      seq: 1,
      label: 'unknown',
      ...overrides,
    }) as DecisionRecord;

  const records = [
    record({ seq: 1 }),
    record({ seq: 2 }),
    record({ seq: 3 }),
    record({ seq: 4, outcome: 'require_human', action: { kind: 'delete', target: 'db', reversible: false, external: false } }),
    record({ seq: 5, outcome: 'deny', actor: 'bot/writer' }),
  ];

  const report = scanProject({ root: dir, records, includeUserConfig: false });
  assert.ok(report.observed);
  assert.equal(report.observed!.records, 5);
  assert.equal(report.observed!.highAuthority, 3);
  assert.equal(report.observed!.pendingApprovals, 1);
  assert.equal(report.observed!.deny, 1);
  assert.equal(report.observed!.actors[0]!.actor, 'bot/outbound');
});

test('配置：非法值整项丢弃，不带着半个策略跑', () => {
  const parsed = parsePolicyConfig({
    moneyCapPerAction: -5,
    moneyCapPerSession: 30,
    denylistTargets: ['.env', 3],
    grants: [{ actor: 'agent/*', authority: 9 }, { actor: 'human/*', authority: 4 }],
    allowAutonomousIrreversible: 'yes',
  });
  assert.equal(parsed?.moneyCapPerAction, undefined, '负数金额不合法');
  assert.equal(parsed?.moneyCapPerSession, 30);
  assert.equal(parsed?.denylistTargets, undefined, '含有非字符串的数组整项丢弃');
  assert.equal(parsed?.grants?.length, 1, '越界的授权等级被丢掉');
  assert.equal(parsed?.allowAutonomousIrreversible, undefined);
});

test('配置：写入再读回，禁止清单与金额上限保持一致', () => {
  const dir = fixture();
  const path = join(dir, 'vigil.config.json');
  const policy = hookPolicy({ denylistTargets: ['.env', 'customer-data'], moneyCapPerAction: 0 });
  savePolicyConfig(path, policy);

  const loaded = loadPolicyConfig(path);
  assert.deepEqual(loaded?.denylistTargets, ['.env', 'customer-data']);
  assert.equal(loaded?.moneyCapPerAction, 0);
  assert.equal(loaded?.grants?.length, policy.grants.length);
  assert.equal(loadPolicyConfig(join(dir, 'nope.json')), null);
});
