import { createHash } from 'node:crypto';
import type { DecisionRecord } from './types.ts';

/**
 * OTel GenAI span 导出。
 *
 * 策略明确：不和 Langfuse/Phoenix/AgentOps 竞争观测层，而是把每条决策
 * 导出成 OTel JSONL（GenAI 语义约定），让它们照单全收 ——
 * Vigil 记"做了什么决定"，它们记"发生了什么"，拼起来才是完整的真相。
 *
 * traceId 由 sessionId 派生（同会话同 trace），spanId 由 decisionId 派生，
 * 父子关系按账本顺序串联 —— 一条决策链在 Langfuse 里就是一条完整 trace。
 */

function spanId(decisionId: string): string {
  return createHash('sha256').update(`span:${decisionId}`).digest('hex').slice(0, 16);
}

function traceId(sessionId: string): string {
  return createHash('sha256').update(`trace:${sessionId}`).digest('hex').slice(0, 32);
}

export interface OtelSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: 'internal';
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: Record<string, string | number | boolean>;
}

export function toOtelSpans(records: DecisionRecord[]): OtelSpan[] {
  const lastSpanBySession = new Map<string, string>();
  return records.map((record) => {
    const tid = traceId(record.sessionId);
    const sid = spanId(record.decisionId);
    const startNano = String(BigInt(Date.parse(record.ts)) * 1_000_000n);
    const span: OtelSpan = {
      traceId: tid,
      spanId: sid,
      name: record.intent.slice(0, 160),
      kind: 'internal',
      startTimeUnixNano: startNano,
      endTimeUnixNano: startNano,
      attributes: {
        'gen_ai.system': 'vigil',
        'gen_ai.operation.name': 'decision',
        'vigil.decision.id': record.decisionId,
        'vigil.session.id': record.sessionId,
        'vigil.actor': record.actor,
        'vigil.action.kind': record.action.kind,
        'vigil.action.target': record.action.target ?? '',
        'vigil.outcome': record.outcome,
        'vigil.authority.required': record.required,
        'vigil.authority.granted': record.granted,
        'vigil.hard_blocks': record.hardBlocks.length,
        'vigil.judgments': record.judgments.length,
        'vigil.evidence.count': record.evidenceIds.length,
        'vigil.cost.usd': record.costUsd,
        'vigil.label': record.label,
        'vigil.seq': record.seq,
        'vigil.hash': record.hash,
      },
    };
    const parent = lastSpanBySession.get(record.sessionId);
    if (parent) span.parentSpanId = parent;
    lastSpanBySession.set(record.sessionId, sid);
    return span;
  });
}

export function toOtelJsonl(records: DecisionRecord[]): string {
  return toOtelSpans(records)
    .map((span) => JSON.stringify(span))
    .join('\n');
}
