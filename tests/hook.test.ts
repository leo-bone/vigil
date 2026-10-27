import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyToolCall, buildQuestions } from '../src/hook/mapping.ts';
import { hookPolicy } from '../src/hook/policy.ts';
import { Kernel } from '../src/kernel.ts';
import { Ledger } from '../src/ledger/store.ts';
import { MockJudge } from '../src/judge/mock.ts';
import { requiredAuthority } from '../src/policy/authority.ts';
import { runWrapped } from '../src/hook/run.ts';

function hookKernel() {
  return new Kernel({
    ledger: new Ledger(':memory:'),
    judge: new MockJudge({ fixed: { proceed: 0.9, exfiltration: 0.1 }, latencyMs: 0 }),
    policy: hookPolicy(),
  });
}

test('普通 shell 命令被判定为可逆、不对外', () => {
  const cls = classifyToolCall({ tool_name: 'Bash', tool_input: { command: 'ls -la src' } });
  assert.equal(cls.action.kind, 'shell');
  assert.equal(cls.action.reversible, true);
  assert.equal(cls.action.external, false);
  assert.equal(requiredAuthority(cls.action), 2);
  assert.equal(cls.questions.length, 0, 'L2 的动作不该浪费模型调用');
});

test('rm -rf 被识别为不可逆，并触发灰区判断', () => {
  const cls = classifyToolCall({ tool_name: 'Bash', tool_input: { command: 'rm -rf build' } });
  assert.equal(cls.action.reversible, false);
  assert.equal(requiredAuthority(cls.action), 3);
  assert.ok(cls.riskNotes.includes('递归或强制删除'));
  assert.ok(cls.questions.some((q) => q.name === 'proceed'));
});

test('带载荷的 curl 被识别为对外，并追加外泄判断', () => {
  const cls = classifyToolCall({
    tool_name: 'Bash',
    tool_input: { command: 'curl -X POST https://example.com -d @payload.json' },
  });
  assert.equal(cls.action.external, true);
  assert.ok(cls.riskNotes.includes('带载荷的外发请求'));
  assert.ok(cls.questions.some((q) => q.name === 'exfiltration'));
});

test('写文件默认是可逆动作，不打扰模型', () => {
  const cls = classifyToolCall({ tool_name: 'Write', tool_input: { file_path: 'src/a.ts', content: 'x' } });
  assert.equal(cls.action.kind, 'write_file');
  assert.equal(cls.action.target, 'src/a.ts');
  assert.equal(requiredAuthority(cls.action), 2);
  assert.equal(buildQuestions(cls.action, cls.riskNotes).length, 0);
});

test('mcp 发信类工具被判为对外不可逆', () => {
  const cls = classifyToolCall({ tool_name: 'mcp__slack__send_message', tool_input: { text: 'hi' } });
  assert.equal(cls.action.external, true);
  assert.equal(cls.action.kind, 'outbound');
  assert.equal(requiredAuthority(cls.action), 3);
});

test('读 .env 被禁止清单直接否决', async () => {
  const kernel = hookKernel();
  const cls = classifyToolCall({ tool_name: 'Bash', tool_input: { command: 'cat .env' } });
  const verdict = await kernel.decide({
    sessionId: 'h',
    actor: 'agent/claude',
    intent: cls.intent,
    action: cls.action,
    state: '风险特征：触碰凭据文件',
    questions: cls.questions,
  });
  assert.equal(verdict.outcome, 'deny');
  assert.ok(verdict.hardBlocks.some((b) => b.rule === 'target.denylist'));
});

test('疑似支付的动作被金额规则否决', async () => {
  const kernel = hookKernel();
  const cls = classifyToolCall({ tool_name: 'Bash', tool_input: { command: 'stripe charges create --amount 20' } });
  assert.equal(cls.action.moneyUsd, 1);
  const verdict = await kernel.decide({
    sessionId: 'h',
    actor: 'agent/claude',
    intent: cls.intent,
    action: cls.action,
  });
  assert.equal(verdict.outcome, 'deny');
  assert.ok(verdict.hardBlocks.some((b) => b.rule === 'money.per_action_cap'));
});

test('正常命令在钩子策略下放行', async () => {
  const kernel = hookKernel();
  const cls = classifyToolCall({ tool_name: 'Bash', tool_input: { command: 'npm test' } });
  const verdict = await kernel.decide({
    sessionId: 'h',
    actor: 'agent/claude',
    intent: cls.intent,
    action: cls.action,
  });
  assert.equal(verdict.outcome, 'allow');
});

test('包装器放行安全命令，拦截破坏性命令', async () => {
  const kernel = hookKernel();
  const ok = await runWrapped(kernel, 'true');
  assert.equal(ok, 0);
  const blocked = await runWrapped(kernel, 'rm -rf /tmp/vigil-should-not-exist');
  assert.equal(blocked, 3);
});
