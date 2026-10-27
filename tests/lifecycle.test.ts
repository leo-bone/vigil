import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { detectSecrets } from '../src/policy/secrets.ts';
import { engageKill, readKillState, releaseKill } from '../src/policy/killswitch.ts';
import { Ledger } from '../src/ledger/store.ts';
import { MockJudge } from '../src/judge/mock.ts';
import { Kernel, defaultPolicy, handleHookEvent } from '../src/index.ts';
import type { HookPayload } from '../src/hook/mapping.ts';

function setup() {
  const ledger = new Ledger(':memory:');
  const kernel = new Kernel({ ledger, judge: new MockJudge(), policy: defaultPolicy() });
  return { ledger, kernel };
}

test('凭据检测：认出常见形态，且不误伤占位符', () => {
  assert.equal(detectSecrets('sk-proj-AbCdEf0123456789XyZ').length, 1);
  assert.equal(detectSecrets('sk-proj-AbCdEf0123456789XyZ')[0]!.type, 'openai_key');
  assert.equal(detectSecrets('AKIAIOSFODNN7EXAMPLE')[0]!.type, 'aws_key');
  assert.equal(detectSecrets('-----BEGIN RSA PRIVATE KEY-----')[0]!.type, 'private_key');
  assert.equal(detectSecrets('password: hunter2hunter2hunter2')[0]!.type, 'password_assignment');

  // 占位符不算泄露
  assert.equal(detectSecrets('api_key=xxxxxxxxxxxxxxxx').length, 0);
  assert.equal(detectSecrets('api_key=<your-key-here>').length, 0);
  assert.equal(detectSecrets('password: placeholder').length, 0);
  assert.equal(detectSecrets('正常的中文内容，没有任何密钥').length, 0);
});

test('凭据检测：命中片段要截断，不能把完整密钥写进账本', () => {
  const finding = detectSecrets('sk-proj-AbCdEf0123456789XyZ')[0]!;
  assert.ok(finding.sample.length < 20, '样本必须被截断');
  assert.ok(finding.sample.endsWith('…'));
});

test('钩子：PostToolUse 输出含凭据 → 拦下并转人工', async () => {
  const { kernel, ledger } = setup();
  const output = await handleHookEvent(kernel, {
    session_id: 's1',
    hook_event_name: 'PostToolUse',
    tool_name: 'Read',
    tool_input: { file_path: '/etc/config' },
    tool_response: 'export OPENAI_KEY=sk-proj-AbCdEf0123456789XyZ',
  } as HookPayload);

  assert.equal(output.decision, 'block');
  assert.ok(String(output.reason).includes('凭据'));
  assert.ok(String(output.reason).includes('轮换'));
  // 落账成 require_human，会出现在待人工审批清单里
  assert.equal(ledger.pendingApprovals().length, 1);
});

test('钩子：PostToolUse 输出干净 → 正常放行，但仍然落账', async () => {
  const { kernel, ledger } = setup();
  const output = await handleHookEvent(kernel, {
    session_id: 's1',
    hook_event_name: 'PostToolUse',
    tool_name: 'Read',
    tool_input: { file_path: 'a.md' },
    tool_response: '文件内容：一切正常',
  } as HookPayload);

  assert.equal(output.decision, undefined);
  assert.equal(ledger.all().length, 1);
  assert.equal(ledger.pendingApprovals().length, 0);
});

test('钩子：PostToolUseFailure 也要落账 —— 失败也是决策的一部分', async () => {
  const { kernel, ledger } = setup();
  await handleHookEvent(kernel, {
    session_id: 's1',
    hook_event_name: 'PostToolUseFailure',
    tool_name: 'Bash',
    tool_input: { command: 'ls /nope' },
    error: 'exit code 2',
  } as HookPayload);

  assert.equal(ledger.all().length, 1);
  assert.ok(ledger.all()[0]!.intent.includes('失败'));
});

test('钩子：SessionStart 给 agent 注入本次会话的监督状态', async () => {
  const { kernel, ledger } = setup();
  const output = await handleHookEvent(kernel, {
    session_id: 's1',
    hook_event_name: 'SessionStart',
    cwd: '/tmp',
  } as HookPayload);

  assert.equal(output.hookSpecificOutput?.hookEventName, 'SessionStart');
  assert.ok(output.hookSpecificOutput?.additionalContext?.includes('Vigil'));
  assert.equal(ledger.all().length, 1);
});

test('钩子：Stop / SessionEnd 给会话封口，记录成本与条数', async () => {
  const { kernel, ledger } = setup();
  for (const event of ['Stop', 'SessionEnd', 'PreCompact']) {
    await handleHookEvent(kernel, {
      session_id: 's1',
      hook_event_name: event,
    } as HookPayload);
  }
  assert.equal(ledger.all().length, 3);
  assert.ok(ledger.all().every((record) => record.action.kind === 'session_lifecycle'));
});

test('钩子：PreToolUse 仍然按授权等级裁决', async () => {
  const { kernel } = setup();
  const output = await handleHookEvent(kernel, {
    session_id: 's1',
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    tool_input: { command: 'rm -rf /' },
  } as HookPayload);

  assert.ok(output.hookSpecificOutput);
  assert.ok(['deny', 'ask'].includes(output.hookSpecificOutput!.permissionDecision ?? ''));
});

test('内核 observe：命中告警级规则 → 记成 require_human 并进审批清单', async () => {
  const { ledger, kernel } = setup();
  const verdict = await kernel.observe({
    sessionId: 's1',
    actor: 'agent/claude',
    intent: '工具执行完成：Read',
    action: { kind: 'tool_result', target: 'Read', payload: '…', reversible: false, external: false },
    extras: { toolOutput: 'token=ghp_AbCdEf0123456789XyZ0123456789' },
  });
  assert.equal(verdict.outcome, 'require_human');
  assert.ok(verdict.warnings?.length);
  assert.equal(ledger.pendingApprovals().length, 1);
});

test('内核 observe：干净输出 → 只记录，不打扰人', async () => {
  const { ledger, kernel } = setup();
  const verdict = await kernel.observe({
    sessionId: 's1',
    actor: 'agent/claude',
    intent: '工具执行完成：Read',
    action: { kind: 'tool_result', target: 'Read', payload: '正常', reversible: false, external: false },
    extras: { toolOutput: '一切正常' },
  });
  assert.equal(verdict.outcome, 'allow');
  assert.equal(ledger.pendingApprovals().length, 0);
  assert.equal(ledger.all().length, 1, '观察事件也要落账');
});

test('内核 decide：告警级规则不改变放行判定', async () => {
  const { kernel } = setup();
  const verdict = await kernel.decide({
    sessionId: 's1',
    actor: 'bot/eng',
    intent: '普通动作',
    action: { kind: 'draft', reversible: true, external: false },
  });
  assert.equal(verdict.outcome, 'allow');
});

test('紧急制动：拉闸后所有动作转人工，解除后恢复', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'vigil-kill-'));
  const killPath = join(dir, 'killed');
  const ledger = new Ledger(':memory:');
  const kernel = new Kernel({
    ledger,
    judge: new MockJudge(),
    policy: defaultPolicy({ grants: [{ actor: 'agent/eng', authority: 2 }] }),
    killSwitchPath: killPath,
  });

  const request = {
    sessionId: 's1',
    actor: 'agent/eng',
    intent: '改配置',
    action: { kind: 'write_file', target: 'src/a.ts', reversible: true, external: false },
  };

  // 未制动：放行
  assert.equal((await kernel.decide(request)).outcome, 'allow');

  // 拉闸：一律转人工
  engageKill('agent 在批量改生产配置', killPath);
  const killed = await kernel.decide(request);
  assert.equal(killed.outcome, 'require_human');
  assert.ok(killed.reason.includes('紧急制动'));
  assert.ok(killed.reason.includes('批量改生产配置'), '原因要写清楚，否则人不知道为什么被拦');
  assert.equal(kernel.killed, true);

  // 解除：恢复放行
  releaseKill(killPath);
  assert.equal(readKillState(killPath).active, false);
  assert.equal((await kernel.decide(request)).outcome, 'allow');
});

test('紧急制动：文件在但读不出来时，宁可当成已制动', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vigil-kill2-'));
  const killPath = join(dir, 'killed');
  engageKill('正常原因', killPath);
  assert.equal(readKillState(killPath).active, true);
  assert.equal(readKillState(join(dir, 'not-exist')).active, false);
});
