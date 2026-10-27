/**
 * 端到端演示：一家"AI 公司"跑一单客户开发流程，十步里踩遍所有分支。
 *
 * 运行：npm run demo
 * 不需要任何 API key —— 用确定性 MockJudge，同样的输入永远得到同样的结论。
 */
import { rmSync } from 'node:fs';
import { Ledger } from '../src/ledger/store.ts';
import { Kernel } from '../src/kernel.ts';
import { MockJudge } from '../src/judge/mock.ts';
import { defaultPolicy } from '../src/policy/rules.ts';
import { postmortem } from '../src/review/postmortem.ts';
import { calibrate } from '../src/review/calibrate.ts';
import { scanAlerts } from '../src/alerts.ts';
import type { DecisionRequest } from '../src/types.ts';

const LEDGER = '.vigil/demo.ndjson';
rmSync(LEDGER, { force: true });

const judge = new MockJudge({ fixed: { proceed: 0.85, risk: 0.2 }, latencyMs: 2 });
const kernel = new Kernel({
  ledger: new Ledger(LEDGER),
  judge,
  policy: defaultPolicy({ moneyCapPerAction: 50, moneyCapPerSession: 200 }),
});

const SESSION = 'sess_acme_outreach';
const PROCEED = {
  name: 'proceed',
  type: 'boolean' as const,
  instructions: '这一步是否应当继续执行',
  floor: 0.7,
};
const RISK = {
  name: 'risk',
  type: 'boolean' as const,
  instructions: '这次对外沟通是否构成商业承诺风险',
  escalateWhenTrue: true,
  floor: 0.75,
};

const steps: DecisionRequest[] = [
  {
    sessionId: SESSION,
    actor: 'bot/researcher',
    intent: '查目标公司的公开信息',
    action: { kind: 'query', target: 'https://example.com/pricing', reversible: true, external: false },
    costUsd: 0.02,
    state: '目标公司官网价格页，需要提取定价档位',
    questions: [PROCEED],
  },
  {
    sessionId: SESSION,
    actor: 'bot/engineer',
    intent: '把抓取结果写进生产库',
    action: { kind: 'write_file', target: 'production/leads.db', reversible: false, external: false },
    costUsd: 0.01,
  },
  {
    sessionId: SESSION,
    actor: 'bot/writer',
    intent: '起草第一封触达邮件',
    action: { kind: 'draft', target: 'outreach/email-01.md', reversible: true, external: false },
    costUsd: 0.05,
    state: '草稿内容：我们注意到贵司最近在扩招，可能对自动化有需求',
    questions: [PROCEED],
  },
  {
    sessionId: SESSION,
    actor: 'bot/outbound',
    intent: '直接把邮件发出去',
    action: { kind: 'send_email', target: 'ceo@example.com', reversible: false, external: true },
    evidence: [],
    costUsd: 0.01,
  },
  {
    sessionId: SESSION,
    actor: 'bot/outbound',
    intent: '带上研究证据再发一次',
    action: { kind: 'send_email', target: 'ceo@example.com', reversible: true, external: true },
    evidence: [
      { id: 'ev_pricing', producedBy: 'bot/researcher', claim: '对方有 3 档定价', verified: true },
      { id: 'ev_hire', producedBy: 'bot/researcher', claim: '近三月发布 12 个运营岗', verified: true },
    ],
    costUsd: 0.01,
    state: '对方在扩招运营岗，邮件里提出可以降低人力成本',
    questions: [{ ...PROCEED, floor: 0.9 }, RISK],
  },
  {
    sessionId: SESSION,
    actor: 'bot/purchaser',
    intent: '买一份第三方企业数据',
    action: { kind: 'pay', target: 'data-vendor', reversible: false, external: true, moneyUsd: 80 },
    costUsd: 80,
  },
];

const badge: Record<string, string> = { allow: '放行 ', require_human: '转人工', deny: '否决 ' };

for (const [index, step] of steps.entries()) {
  const verdict = await kernel.decide(step);
  console.log(`\n${index + 1}. ${step.actor} · ${step.intent}`);
  console.log(`   → ${badge[verdict.outcome]}  需 ${verdict.required} 级 / 持有 ${verdict.granted} 级`);
  console.log(`   ${verdict.reason}`);
}

console.log('\n7-10. bot/researcher · 反复检索同一页面（疑似在打转）');
for (let i = 0; i < 4; i += 1) {
  const verdict = await kernel.decide({
    sessionId: SESSION,
    actor: 'bot/researcher',
    intent: `第 ${i + 1} 次重试同一页面的价格表`,
    action: { kind: 'query', target: 'https://example.com/pricing', reversible: true, external: false },
    costUsd: 0.4,
  });
  console.log(`   → ${badge[verdict.outcome]}  会话累计 ${kernel.ledger.sessionSpend(SESSION).toFixed(2)} 美元`);
}

console.log('\n' + '='.repeat(70));
const records = kernel.ledger.all();
const allowed = records.filter((r) => r.outcome === 'allow');

// 事后回填：只给被放行的动作打标签，这是校准闭环的原料
kernel.ledger.label(allowed[0]!.decisionId, 'correct', '定价信息确实存在');
kernel.ledger.label(allowed[1]!.decisionId, 'wrong', '邮件把扩招误读成自动化需求，客户回复否认');

console.log('\n事后梳理\n');
const report = postmortem(kernel.ledger, SESSION);
console.log(`决策 ${report.decisions} 条，花费 ${report.spendUsd.toFixed(2)} 美元，哈希链${report.chainOk ? '完好' : '已损坏'}`);
console.log('\n转折点：');
report.turningPoints.forEach((line) => console.log(`  · ${line}`));
if (report.missingEvidence.length > 0) {
  console.log('\n缺失证据：');
  report.missingEvidence.forEach((line) => console.log(`  · ${line}`));
}
console.log('\n指标：');
const m = report.metrics;
console.log(`  放行 ${(m.allowRate * 100).toFixed(0)}% / 转人工 ${(m.escalateRate * 100).toFixed(0)}% / 否决 ${(m.denyRate * 100).toFixed(0)}%`);
console.log(`  可追溯率 ${(m.traceableRate * 100).toFixed(0)}%   虚假完成率 ${(m.falseDoneRate * 100).toFixed(0)}%`);
console.log('\n结论：');
report.findings.forEach((line) => console.log(`  · ${line}`));

console.log('\n' + '='.repeat(70));
console.log('\n置信度校准（模型说 0.85 的时候，实际有多准）\n');
const cal = calibrate(kernel.ledger.all(), { question: 'proceed' });
console.log(`样本 ${cal.samples} 条，Brier ${cal.brier}，ECE ${cal.ece}`);
if (cal.sweep.length > 0) {
  console.log('\n阈值扫描：');
  cal.sweep.forEach((p) => console.log(`  floor ${p.floor.toFixed(2)} → 覆盖率 ${(p.coverage * 100).toFixed(0)}%，正确率 ${(p.precision * 100).toFixed(0)}%`));
}
console.log(`结论：${cal.verdict}`);

console.log('\n' + '='.repeat(70));
console.log('\n预警\n');
const alerts = scanAlerts(kernel.ledger, { windowMs: 60 * 60 * 1000, costCapUsd: 1 });
if (alerts.length === 0) console.log('无预警。');
for (const alert of alerts) console.log(`[${alert.severity.toUpperCase()}] ${alert.title}\n  ${alert.detail}`);

console.log(`\n账本已写入 ${LEDGER}，可用 vigil ledger / vigil verify 查看。\n`);
