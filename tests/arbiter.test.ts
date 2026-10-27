import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Ledger } from '../src/ledger/store.ts';
import { MockJudge } from '../src/judge/mock.ts';
import { arbitrate, resolveArbitration, createPipelineKernel } from '../src/index.ts';
import type { Position } from '../src/index.ts';

const ACTION = { kind: 'send_email', target: 'a@b.com', reversible: false, external: true };

/** 独立第三方出的核验记录。仲裁也要求双方拿出依据 —— 空口说"都同意"不算数 */
const VERIFIED = { id: 'ev_audit', producedBy: 'bot/auditor', claim: '已核验', verified: true };

function setup(fixed: Record<string, number> = {}) {
  const ledger = new Ledger(':memory:');
  const kernel = createPipelineKernel(ledger, new MockJudge({ fixed }));
  return { ledger, kernel };
}

function position(overrides: Partial<Position> & Pick<Position, 'actor' | 'conclusion'>): Position {
  return {
    reason: `${overrides.actor} 的理由`,
    ...overrides,
  };
}

test('仲裁：立场一致 → 直接采纳，不消耗模型', async () => {
  const { kernel } = setup();
  const result = await arbitrate(kernel, {
    sessionId: 's1',
    question: '能不能发这封邮件',
    positions: [
      position({ actor: 'bot/a', conclusion: 'allow', evidence: [VERIFIED] }),
      position({ actor: 'bot/b', conclusion: 'allow', evidence: [VERIFIED] }),
    ],
    action: ACTION,
  });
  assert.equal(result.decision, 'allow');
  assert.equal(result.resolution, 'unanimous_allow');
  assert.equal(result.usedJudge, false);
});

test('仲裁：都说可以但谁也没拿证据 → 转人工，不放行', async () => {
  const { kernel } = setup();
  const result = await arbitrate(kernel, {
    sessionId: 's1',
    question: '能不能发这封邮件',
    positions: [
      position({ actor: 'bot/a', conclusion: 'allow' }),
      position({ actor: 'bot/b', conclusion: 'allow' }),
    ],
    action: ACTION,
  });
  assert.equal(result.decision, 'require_human');
  assert.equal(result.resolution, 'unanimous_allow', '阶梯上无争议，但证据规则拦下了');
});

test('仲裁：全票同意也绕不过硬规则', async () => {
  const { kernel, ledger } = setup();
  const result = await arbitrate(kernel, {
    sessionId: 's1',
    question: '能不能写生产配置',
    positions: [
      position({ actor: 'bot/a', conclusion: 'allow' }),
      position({ actor: 'bot/b', conclusion: 'allow' }),
    ],
    action: { kind: 'write_file', target: 'production/config.yaml', reversible: true, external: false },
  });
  assert.equal(result.decision, 'deny');
  assert.ok(result.verdict.hardBlocks.some((block) => block.rule === 'target.denylist'));
  assert.ok(ledger.verify().ok);
});

test('仲裁：否决方有独立核验证据而对方没有 → 采信否决', async () => {
  const { kernel } = setup();
  const result = await arbitrate(kernel, {
    sessionId: 's1',
    question: '这批数据能不能发出去',
    positions: [
      position({
        actor: 'bot/reviewer',
        conclusion: 'deny',
        evidence: [{ id: 'ev1', producedBy: 'bot/auditor', verified: true }],
      }),
      position({ actor: 'bot/sales', conclusion: 'allow' }),
    ],
    action: ACTION,
  });
  assert.equal(result.decision, 'deny');
  assert.equal(result.resolution, 'deny_evidence');
  assert.equal(result.winner?.actor, 'bot/reviewer');
  assert.equal(result.overruled.length, 1);
});

test('仲裁：权级更高的一方说不行 → 采信否决', async () => {
  const { kernel } = setup();
  const result = await arbitrate(kernel, {
    sessionId: 's1',
    question: '能不能发布',
    positions: [
      position({ actor: 'bot/junior', conclusion: 'allow', authority: 1 }),
      position({ actor: 'bot/compliance', conclusion: 'deny', authority: 3 }),
    ],
    action: ACTION,
  });
  assert.equal(result.decision, 'deny');
  assert.equal(result.resolution, 'deny_authority');
});

test('仲裁：证据与权级都分不出高下 → 交人工，模型不能翻案', async () => {
  // 模型给足信心（0.95），也不能把一条未被驳倒的否决立场变成放行
  const { kernel } = setup({ proceed: 0.95 });
  const result = await arbitrate(kernel, {
    sessionId: 's1',
    question: '这份数据能不能发',
    positions: [
      position({ actor: 'bot/a', conclusion: 'deny', authority: 2 }),
      position({ actor: 'bot/b', conclusion: 'allow', authority: 2 }),
    ],
    action: ACTION,
  });
  assert.equal(result.decision, 'require_human');
  assert.equal(result.resolution, 'deny_unresolved');
  assert.ok(result.reason.includes('交人工'));
});

test('仲裁：没有否决立场时，模型只在"放行"与"转人工"之间排序', async () => {
  const { kernel } = setup({ proceed: 0.9 });
  const result = await arbitrate(kernel, {
    sessionId: 's1',
    question: '要不要继续推进',
    positions: [
      position({ actor: 'bot/a', conclusion: 'allow', evidence: [VERIFIED] }),
      position({ actor: 'bot/b', conclusion: 'require_human', evidence: [VERIFIED] }),
    ],
    action: ACTION,
  });
  assert.equal(result.decision, 'allow');
  assert.equal(result.resolution, 'model_tiebreak');
  assert.equal(result.usedJudge, true);
  assert.equal(result.winner?.conclusion, 'allow');
});

test('仲裁：模型没把握时，转人工而不是猜', async () => {
  const { kernel } = setup({ proceed: 0.4 });
  const result = await arbitrate(kernel, {
    sessionId: 's1',
    question: '要不要继续推进',
    positions: [
      position({ actor: 'bot/a', conclusion: 'allow', evidence: [VERIFIED] }),
      position({ actor: 'bot/b', conclusion: 'require_human', evidence: [VERIFIED] }),
    ],
    action: ACTION,
  });
  assert.equal(result.decision, 'require_human');
  assert.equal(result.resolution, 'model_tiebreak');
});

test('仲裁：同一个 agent 改主意只取最严格的那个', () => {
  const policy = {
    moneyCapPerAction: 50,
    moneyCapPerSession: 200,
    allowAutonomousIrreversible: false,
    denylistTargets: [],
    grants: [{ actor: 'bot/*', authority: 2 }],
  };
  const resolved = resolveArbitration(
    [
      { actor: 'bot/a', conclusion: 'allow', reason: '一开始说可以' },
      { actor: 'bot/a', conclusion: 'deny', reason: '后来发现不对' },
    ],
    policy,
  );
  assert.equal(resolved.resolution, 'unanimous_deny');
});

test('仲裁：结论落进账本，和普通决策无法区分', async () => {
  const { kernel, ledger } = setup();
  await arbitrate(kernel, {
    sessionId: 's1',
    question: '能不能发',
    positions: [
      position({ actor: 'bot/a', conclusion: 'allow' }),
      position({ actor: 'bot/b', conclusion: 'deny', authority: 3 }),
    ],
    action: ACTION,
  });
  const records = ledger.bySession('s1');
  assert.equal(records.length, 1);
  assert.equal(records[0]!.actor, 'vigil/arbiter');
  assert.ok(records[0]!.intent.startsWith('仲裁：'));
  assert.ok(ledger.verify().ok);
});

test('仲裁：没有立场就直接报错，不做默认决定', async () => {
  const { kernel } = setup();
  await assert.rejects(
    () => arbitrate(kernel, { sessionId: 's1', question: 'x', positions: [], action: ACTION }),
    /没有立场/,
  );
});
