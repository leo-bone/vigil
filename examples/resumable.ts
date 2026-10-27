/**
 * 可续跑统筹循环的演示。
 *
 * 跟 examples/company.ts 的区别：这里没有进程内 worker，
 * 每一轮都由"外部 agent"接手 —— 模拟 MCP 客户端的行为。
 *
 * 运行：npm run demo:resumable
 * 不需要任何 API key。
 */
import { Orchestrator, createPipelineKernel } from '../src/pipeline/orchestrator.ts';
import { Ledger } from '../src/ledger/store.ts';
import { MockJudge } from '../src/judge/mock.ts';

const ROSTER = [
  { id: 'bot/writer', role: '写手，负责起草' },
  { id: 'bot/checker', role: '复核，负责独立验证' },
];

const ledger = new Ledger(':memory:');
const judge = new MockJudge({
  fixed: { quality_sufficient: 0.9, acceptance_criteria_met: 0.92, progress: 4 },
  choices: { next_worker: 'bot/writer' },
});
const orchestrator = new Orchestrator(createPipelineKernel(ledger, judge));

function line(char = '─', width = 72): string {
  return char.repeat(width);
}

async function main(): Promise<void> {
  console.log(line('═'));
  console.log('可续跑统筹循环：外部 agent 扮演工人');
  console.log(line('═'));

  // 第一步：开任务。Vigil 决定下一个该谁干。
  let turn = await orchestrator.begin({
    sessionId: 'sess_demo',
    taskId: 'task_demo',
    task: '给客户 ACME 写一封报价邮件',
    roster: ROSTER,
  });

  let round = 0;
  while (turn.kind === 'work') {
    round += 1;
    console.log(`\n${line()}`);
    console.log(`第 ${round} 轮｜Vigil 派工给 ${turn.workerId}（${turn.role}）`);
    console.log(line());
    console.log(turn.instructions);
    console.log('\n交回时必须包含：');
    turn.requirements.forEach((requirement, index) => console.log(`  ${index + 1}. ${requirement}`));

    if (turn.feedback) {
      console.log(`\n⚠ 上一轮被退回：${turn.feedback}`);
    }

    // 模拟外部 agent 的回应：
    // 第一轮偷懒，不给交付物位置、不给独立核验、不声明遗留问题；
    // 第二轮补齐。
    const sloppy = round === 1;
    const output = sloppy
      ? {
          summary: '写了一版草稿',
          claim: '报价邮件已完成',
          evidence: [{ id: 'ev_draft', producedBy: 'bot/writer', claim: '草稿已写', verified: false }],
        }
      : {
          summary: '补齐交付物，请复核人独立核验',
          claim: '报价邮件已写好并交付',
          deliverableUri: 'drafts/quote-acme.md',
          leftoverIssues: '',
          evidence: [
            { id: 'ev_draft', producedBy: 'bot/writer', claim: '草稿已写', verified: false },
            { id: 'ev_check', producedBy: 'bot/checker', claim: '已核对价格与折扣', verified: true },
          ],
        };

    turn = await orchestrator.submit('task_demo', output);
  }

  const state = orchestrator.state('task_demo')!;
  console.log(`\n${line('═')}`);
  console.log(`终态：${state.status}`);
  console.log(line('═'));
  console.log('\n每一步的判断：');
  state.steps.forEach((step) => console.log(`  ${step}`));

  console.log('\n工人实际做了什么：');
  state.trace.forEach((entry) => console.log(`  ${entry}`));

  console.log('\n账本记录：');
  for (const record of ledger.bySession('sess_demo')) {
    const badge =
      record.outcome === 'allow' ? '放行' : record.outcome === 'deny' ? '否决' : '转人工';
    console.log(`  #${record.seq} ${badge}  ${record.intent}`);
  }
  console.log(`\n共 ${ledger.all().length} 条决策，哈希链${ledger.verify().ok ? '完好' : '已损坏'}`);
  console.log(
    '\n注意：验收被拒的那一轮里，模型给的分数很高（acceptance_criteria_met=0.92），\n' +
      '但缺项就是缺项 —— 清单是一票否决，概率不能覆盖它。',
  );
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
