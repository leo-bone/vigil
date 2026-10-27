/**
 * 一家 AI 公司的完整决策演示。
 *
 * 一个统筹助理带着四名 AI 工人跑三个任务，覆盖五种岔路的全部走向：
 *
 *   任务一  常规交付：第一轮产出不合格 → 质量门/验收退回 → 带反馈重做 → 交付
 *   任务二  自产自验：工人给自己的证据打"已核验" → 验收识破 → 纠正后交付
 *   任务三  虚假完成：反复声称完成却拿不出交付物 → 止损触发，停止烧钱
 *
 * 运行：node examples/company.ts   （不需要任何 API key）
 */
import { Ledger } from '../src/ledger/store.ts';
import { MockJudge } from '../src/judge/mock.ts';
import { createPipelineKernel, Orchestrator } from '../src/pipeline/orchestrator.ts';
import type { VigilWorker, WorkerOutput } from '../src/pipeline/orchestrator.ts';
import { postmortem } from '../src/review/postmortem.ts';
import { scanAlerts } from '../src/alerts.ts';
import type { Evidence } from '../src/types.ts';

const runTag = Date.now().toString(36);

/** 概率判断固定为"优秀"：演示的重点是确定性规则怎么拦人，不是模型水平 */
const judge = new MockJudge({
  fixed: { quality_sufficient: 0.9, acceptance_criteria_met: 0.92, progress: 4 },
  // 路由剧本：三个任务都先派写手 —— 初稿不过验收、自验被识破、虚假完成，都在写手身上发生
  choices: { next_worker: () => 'bot/writer' },
});

const ledger = new Ledger('.vigil/company.ndjson');
const kernel = createPipelineKernel(ledger, judge);
const company = new Orchestrator(kernel, { maxAttempts: 3, failureThreshold: 2 });

/** 检查员的核验记录：验收要求的"独立核验"只能由别人产出 */
function checkerProof(claim: string): Evidence {
  return { id: `ev-check-${runTag}-${claim.length}`, producedBy: 'bot/checker', verified: true, claim };
}

const workers: VigilWorker[] = [
  {
    id: 'bot/pm',
    role: '项目经理，拆解任务',
    async run({ attempt }): Promise<WorkerOutput> {
      return {
        summary: attempt === 1 ? '拆解需求，输出执行计划' : '计划已细化到可执行粒度',
        claim: '计划完成',
        evidence: [{ id: `ev-plan-${runTag}-${attempt}`, producedBy: 'bot/pm', claim: '执行计划' }],
        deliverableUri: attempt >= 2 ? 'plans/plan.md' : undefined,
        leftoverIssues: attempt >= 2 ? '' : undefined,
        costUsd: 0.01,
      };
    },
  },
  {
    id: 'bot/researcher',
    role: '研究员，搜集资料',
    async run({ attempt }): Promise<WorkerOutput> {
      if (attempt === 1) {
        return {
          summary: '完成行业资料搜集，整理成研究笔记',
          claim: '研究完成',
          evidence: [{ id: `ev-research-${runTag}`, producedBy: 'bot/researcher', claim: '研究笔记' }],
          costUsd: 0.03,
        };
      }
      return {
        summary: '研究定稿并交检查员核验',
        claim: '研究完成，已通过独立核验',
        evidence: [
          { id: `ev-research-${runTag}`, producedBy: 'bot/researcher', claim: '研究笔记' },
          checkerProof('research'),
        ],
        deliverableUri: 'deliverables/research.md',
        leftoverIssues: '数据源 B 的时效性存疑，已在附录标注',
        costUsd: 0.03,
      };
    },
  },
  {
    id: 'bot/writer',
    role: '写手，成稿交付',
    async run({ taskId, attempt }): Promise<WorkerOutput> {
      // 任务二第一轮：自产自验 —— 自己给自己的证据打"已核验"，验收必须识破
      if (taskId === 'task-cheat' && attempt === 1) {
        return {
          summary: '写完报告，顺手自己核验了一遍',
          claim: '报告完成',
          evidence: [{ id: `ev-draft-${runTag}`, producedBy: 'bot/writer', verified: true, claim: '报告终稿' }],
          deliverableUri: 'deliverables/cheat-report.md',
          leftoverIssues: '',
          costUsd: 0.02,
        };
      }
      if (taskId === 'task-doomed') {
        // 死任务：永远拿不出交付物
        return {
          summary: '继续修改，声称快完成了',
          claim: '接近完成',
          evidence: [{ id: `ev-doomed-${runTag}-${attempt}`, producedBy: 'bot/writer', claim: '阶段性成果' }],
          costUsd: 0.02,
        };
      }
      const final = attempt >= 2;
      return {
        summary: final ? '报告定稿并交检查员核验' : '完成报告初稿',
        claim: final ? '报告完成，已通过独立核验' : '报告初稿完成',
        evidence: final
          ? [
              { id: `ev-draft-${runTag}`, producedBy: 'bot/writer', claim: '报告草稿' },
              checkerProof('report'),
            ]
          : [{ id: `ev-draft-${runTag}`, producedBy: 'bot/writer', claim: '报告草稿' }],
        deliverableUri: final ? 'deliverables/report.md' : 'drafts/report.md',
        leftoverIssues: final ? '' : undefined,
        costUsd: 0.02,
      };
    },
  },
  {
    id: 'bot/checker',
    role: '检查员，独立核验',
    async run(): Promise<WorkerOutput> {
      return {
        summary: '核验了他人的产出',
        claim: '核验完成',
        evidence: [checkerProof('ad-hoc')],
        deliverableUri: 'deliverables/verification.md',
        leftoverIssues: '',
        costUsd: 0.01,
      };
    },
  },
];

function printReport(title: string, report: Awaited<ReturnType<Orchestrator['runTask']>>): void {
  console.log(`\n${'='.repeat(72)}\n■ ${title}\n  任务 ${report.taskId}：${report.task}`);
  for (const step of report.steps) console.log(`   · ${step}`);
  for (const line of report.workerTrace) console.log(`   › ${line}`);
  console.log(
    `  ⇒ ${report.status.toUpperCase()}（${report.attempts} 轮，$${report.spendUsd.toFixed(2)}）—— ${report.reason}`,
  );
}

// ── 任务一：常规交付，第一轮被打回，第二轮带着反馈交付 ──
const r1 = await company.runTask(`sess-ok-${runTag}`, 'task-ok', '写一份行业标准调研报告', workers);
printReport('任务一：常规交付（退回 → 重做 → 通过）', r1);

// ── 任务二：自产自验被验收识破，纠正后交付 ──
const r2 = await company.runTask(`sess-cheat-${runTag}`, 'task-cheat', '写一份竞品分析报告', workers);
printReport('任务二：自产自验（识破 → 纠正 → 通过）', r2);

// ── 任务三：虚假完成，止损退出 ──
const r3 = await company.runTask(`sess-doomed-${runTag}`, 'task-doomed', '做一个永远做不出来的功能', workers);
printReport('任务三：虚假完成（止损退出）', r3);

// ── 全局视角：账本校验 + 预警 + 事后梳理 ──
console.log(`\n${'='.repeat(72)}\n■ 账本完整性`);
const chain = ledger.verify();
console.log(`   ${chain.ok ? '✓' : '✗'} ${chain.count} 条决策记录，哈希链${chain.ok ? '完整' : `在 ${chain.brokenAt} 断裂`}`);

console.log('\n■ 预警扫描');
for (const alert of scanAlerts(ledger)) console.log(`   ⚠ [${alert.kind}] ${alert.detail}`);

console.log('\n■ 事后梳理（任务三）');
const pm = postmortem(ledger, `sess-doomed-${runTag}`);
for (const f of pm.findings) console.log(`   · ${f}`);
console.log(`   虚假完成率 ${(pm.metrics.falseDoneRate * 100).toFixed(0)}% · 升级率 ${(pm.metrics.escalateRate * 100).toFixed(0)}%`);
