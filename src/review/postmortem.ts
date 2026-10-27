import type { DecisionRecord } from '../types.ts';
import { actionSummary } from '../policy/rules.ts';
import type { LedgerBackend } from '../ledger/backend.ts';

export interface TimelineEntry {
  seq: number;
  ts: string;
  actor: string;
  intent: string;
  action: string;
  outcome: string;
  reason: string;
}

export interface Postmortem {
  sessionId: string;
  decisions: number;
  chainOk: boolean;
  spendUsd: number;
  timeline: TimelineEntry[];
  /** 走向发生改变的那几步 */
  turningPoints: string[];
  /** 声称完成却没有证据的动作 */
  missingEvidence: string[];
  /** 事后被证伪的决定 */
  falsified: Array<{ decisionId: string; intent: string; note?: string }>;
  metrics: {
    allowRate: number;
    escalateRate: number;
    denyRate: number;
    /** 被放行的动作里，能追到证据链的比例 */
    traceableRate: number;
    /** 被放行、事后被证明是错的比例 —— 虚假完成率 */
    falseDoneRate: number;
    labeled: number;
  };
  /** 可以直接贴进事故报告的结论句 */
  findings: string[];
}

function summarizeReason(record: DecisionRecord): string {
  const blocks = record.hardBlocks.map((b) => b.detail);
  const judged = record.judgments.map((j) => {
    if (j.type === 'boolean') return `${j.name}=${(j.probability ?? 0).toFixed(2)}`;
    if (j.type === 'choice') return `${j.name}=${j.choice}`;
    return `${j.name}=${j.score}`;
  });
  const parts = [...blocks, ...judged];
  return parts.length > 0 ? parts.join('；') : '无异常';
}

/**
 * 事后梳理。
 *
 * 目标不是"回放日志"，而是回答四个问题：
 * 哪一步开始走偏、当时缺了什么证据、哪些决定被证明是错的、以后该改哪条规则。
 */
export function postmortem(ledger: LedgerBackend, sessionId: string): Postmortem {
  const records = ledger.bySession(sessionId);
  const chain = ledger.verify();

  const allow = records.filter((r) => r.outcome === 'allow');
  const escalate = records.filter((r) => r.outcome === 'require_human');
  const deny = records.filter((r) => r.outcome === 'deny');
  const labeled = records.filter((r) => r.label !== 'unknown');
  const wrong = records.filter((r) => r.label === 'wrong');

  const timeline: TimelineEntry[] = records.map((r) => ({
    seq: r.seq,
    ts: r.ts,
    actor: r.actor,
    intent: r.intent,
    action: actionSummary(r.action),
    outcome: r.outcome,
    reason: summarizeReason(r),
  }));

  const turningPoints: string[] = [];
  const firstBlock = records.find((r) => r.outcome !== 'allow');
  if (firstBlock) {
    turningPoints.push(
      `第 ${firstBlock.seq} 步首次被拦：${firstBlock.actor} 试图「${firstBlock.intent}」，结论 ${firstBlock.outcome}（${summarizeReason(firstBlock)}）`,
    );
  }
  const lowConfidenceAllowed = allow
    .filter((r) => r.judgments.some((j) => j.valid && j.type === 'boolean'))
    .sort((a, b) => {
      const min = (r: DecisionRecord) =>
        Math.min(...r.judgments.filter((j) => j.valid && j.type === 'boolean').map((j) => j.probability ?? 1));
      return min(a) - min(b);
    })[0];
  if (lowConfidenceAllowed) {
    turningPoints.push(
      `第 ${lowConfidenceAllowed.seq} 步最可疑：放行时的判断把握是全流程最低的一个（${summarizeReason(lowConfidenceAllowed)}）`,
    );
  }

  const missingEvidence = allow
    .filter((r) => r.action.external && r.evidenceIds.length === 0)
    .map((r) => `第 ${r.seq} 步「${r.intent}」对外动作没有任何证据支撑`);

  // 可追溯率只统计对外动作：内部岔路（路由/质量门/止损）本就不需要证据链
  const externalAllow = allow.filter((r) => r.action.external);
  const traceable = externalAllow.filter((r) => r.evidenceIds.length > 0).length;
  const falseDone = allow.filter((r) => r.label === 'wrong').length;

  const findings: string[] = [];
  if (records.length === 0) findings.push('该会话没有任何决策记录，无法复盘。');
  if (wrong.length > 0) {
    findings.push(`${wrong.length} 个被放行的决定事后被证伪，说明当时的判断依据不足或规则太松。`);
  }
  if (missingEvidence.length > 0) {
    findings.push(`${missingEvidence.length} 个对外动作缺少证据，违反"禁止无证据的已完成"。`);
  }
  const deniedByAuthority = deny.filter((r) => r.hardBlocks.some((b) => b.rule.startsWith('money.')));
  if (deniedByAuthority.length > 0) {
    findings.push(`${deniedByAuthority.length} 次因金额规则被拦，考虑收紧该 actor 的预算或改走人工审批。`);
  }
  if (externalAllow.length > 0 && traceable / externalAllow.length < 0.8) {
    findings.push(`可追溯率仅 ${((traceable / allow.length) * 100).toFixed(0)}%，建议把证据要求从"鼓励"改成"必须"。`);
  }
  if (findings.length === 0) findings.push('未发现结构性问题。');

  return {
    sessionId,
    decisions: records.length,
    chainOk: chain.ok,
    spendUsd: records.reduce((sum, r) => sum + r.costUsd, 0),
    timeline,
    turningPoints,
    missingEvidence,
    falsified: wrong.map((r) => ({ decisionId: r.decisionId, intent: r.intent, note: r.labelNote })),
    metrics: {
      allowRate: records.length ? allow.length / records.length : 0,
      escalateRate: records.length ? escalate.length / records.length : 0,
      denyRate: records.length ? deny.length / records.length : 0,
      traceableRate: externalAllow.length ? traceable / externalAllow.length : 1,
      falseDoneRate: allow.length ? falseDone / allow.length : 0,
      labeled: labeled.length,
    },
    findings,
  };
}
