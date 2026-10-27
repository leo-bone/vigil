/**
 * 冲突仲裁的演示。
 *
 * 多个 agent 对同一件事给出相反结论时，谁说了算？
 * 这个演示跑四个案例，把仲裁阶梯的每一级都走一遍。
 *
 * 运行：npm run demo:arbiter
 * 不需要任何 API key。
 */
import { createPipelineKernel } from '../src/pipeline/orchestrator.ts';
import { arbitrate } from '../src/pipeline/arbiter.ts';
import { Ledger } from '../src/ledger/store.ts';
import { MockJudge } from '../src/judge/mock.ts';

const ledger = new Ledger(':memory:');
// 模型给足信心（0.95）—— 看看它能不能把"否决"翻成"放行"
const judge = new MockJudge({ fixed: { proceed: 0.95 } });
const kernel = createPipelineKernel(ledger, judge);

const ACTION = { kind: 'send_email', target: 'partner@vendor.com', reversible: false, external: true };

const CASES = [
  {
    title: '案例一：立场一致 —— 直接采纳',
    question: '这批客户数据能不能发给第三方',
    positions: [
      {
        actor: 'bot/sales',
        conclusion: 'allow' as const,
        reason: '客户催得急，协议已签',
        evidence: [{ id: 'ev_contract', producedBy: 'bot/auditor', claim: '协议核对无误', verified: true }],
      },
      {
        actor: 'bot/ops',
        conclusion: 'allow' as const,
        reason: '走的是既有通道',
        evidence: [{ id: 'ev_contract', producedBy: 'bot/auditor', claim: '协议核对无误', verified: true }],
      },
    ],
  },
  {
    title: '案例二：否决方有独立核验证据 —— 采信否决',
    question: '这批客户数据能不能发给第三方',
    positions: [
      {
        actor: 'bot/sales',
        conclusion: 'allow' as const,
        reason: '客户催得急',
        evidence: [{ id: 'ev_contract', producedBy: 'bot/sales', claim: '协议已签', verified: false }],
      },
      {
        actor: 'bot/compliance',
        conclusion: 'deny' as const,
        reason: '数据含个人信息，未脱敏',
        evidence: [{ id: 'ev_audit', producedBy: 'bot/auditor', claim: '字段检查未通过', verified: true }],
      },
    ],
  },
  {
    title: '案例三：证据与权级分不出高下 —— 交人工（模型翻不了案）',
    question: '这份报告能不能对外发布',
    positions: [
      { actor: 'bot/editor', conclusion: 'deny' as const, reason: '第三方的数据没有授权书' },
      { actor: 'bot/writer', conclusion: 'allow' as const, reason: '都是公开信息' },
    ],
  },
  {
    title: '案例四：全票同意也绕不过硬规则',
    question: '能不能改生产配置',
    positions: [
      { actor: 'bot/a', conclusion: 'allow' as const, reason: '改一个参数而已' },
      { actor: 'bot/b', conclusion: 'allow' as const, reason: '没问题' },
    ],
    action: { kind: 'write_file', target: 'production/config.yaml', reversible: true, external: false },
  },
];

async function main(): Promise<void> {
  console.log('═'.repeat(72));
  console.log('冲突仲裁：多个 agent 结论相反时由谁定夺');
  console.log('═'.repeat(72));
  console.log('\n仲裁阶梯（固定，不靠模型猜）：');
  console.log('  1. 立场一致 → 直接采纳');
  console.log('  2. 同一个 agent 的多个立场 → 取最严格的那个');
  console.log('  3. 动作本身触红线 → 否决（全票同意也不行）');
  console.log('  4. 有否决立场 → 证据占优采信否决 / 权级占优采信否决 / 分不出高下交人工');
  console.log('  5. 没有否决立场 → 模型只在"放行"与"转人工"之间排序');
  console.log('\n模型本轮被喂了 0.95 的高置信度 —— 看看它能做什么、不能做什么。');

  let index = 0;
  for (const testCase of CASES) {
    index += 1;
    const result = await arbitrate(kernel, {
      sessionId: `sess_${index}`,
      question: testCase.question,
      positions: testCase.positions,
      action: testCase.action ?? ACTION,
    });

    console.log(`\n${'─'.repeat(72)}`);
    console.log(testCase.title);
    console.log('─'.repeat(72));
    for (const position of testCase.positions) {
      console.log(`  ${position.actor}：${position.conclusion} —— ${position.reason}`);
    }
    console.log(`\n  ▸ 结论：${result.decision}`);
    console.log(`  ▸ 阶梯：${result.resolution}`);
    console.log(`  ▸ 理由：${result.reason}`);
    // 阶梯说"无争议"但内核仍然否决，说明是硬规则压下来的 —— 这两件事要分开看
    if (result.resolution === 'unanimous_allow' && result.decision === 'deny') {
      console.log('  ▸ 注意：阶梯上没有分歧，是硬规则把它否决了');
    }
    if (result.winner) console.log(`  ▸ 采信：${result.winner.actor}`);
  }

  console.log(`\n${'═'.repeat(72)}`);
  console.log('账本里的仲裁记录');
  console.log('═'.repeat(72));
  for (const record of ledger.all()) {
    const badge =
      record.outcome === 'allow' ? '放行' : record.outcome === 'deny' ? '否决' : '转人工';
    console.log(`  #${record.seq} ${badge}  ${record.intent}`);
    // 记录里存的是硬规则明细，不是结论串 —— 结论可以从明细里还原
    const details = record.hardBlocks.map((block) => block.detail).join('；');
    console.log(`        └ ${details || '（无硬规则命中）'}`);
  }
  console.log(`\n共 ${ledger.all().length} 条仲裁记录，哈希链${ledger.verify().ok ? '完好' : '已损坏'}`);
  console.log(
    '\n注意案例三：模型给了 0.95 的把握，依然没能把否决翻成放行。\n' +
      '一条没被驳倒的否决立场，必须由人来推翻 —— 这是 fail-closed 在多 agent 场景的延伸。',
  );
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
