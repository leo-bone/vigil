import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { hashObject } from '../util/canonical.ts';
import type { DecisionRecord, OutcomeLabel } from '../types.ts';

export const GENESIS_HASH = '0'.repeat(64);

type NewRecord = Omit<
  DecisionRecord,
  'seq' | 'prevHash' | 'hash' | 'label' | 'labelNote' | 'labelTs'
>;

interface LabelEvent {
  kind: 'label';
  decisionId: string;
  label: OutcomeLabel;
  note?: string;
  ts: string;
}

interface DecisionEvent {
  kind: 'decision';
  record: DecisionRecord;
}

type LedgerEvent = DecisionEvent | LabelEvent;

/**
 * 只追加的决策账本。
 *
 * 三条硬约束：
 * 1. 只追加。任何修改都是新增一条事件，绝不改写历史。
 * 2. 哈希链。每条记录包含上一条的哈希，改任何一条都会断链。
 * 3. 可回放。给定 sessionId 就能重放当时的判断过程。
 *
 * 单进程写入，够用于个人和小团队。要并发就得换存储层，
 * 但哈希链的语义不会变 —— 这是刻意留的替换点。
 */
export class Ledger {
  #path: string;
  #decisions: DecisionRecord[] = [];
  #labels = new Map<string, LabelEvent>();
  #lastHash: string = GENESIS_HASH;
  #seq = 0;

  constructor(path: string = '.vigil/ledger.ndjson') {
    this.#path = path;
    if (path !== ':memory:') this.#load();
  }

  get path(): string {
    return this.#path;
  }

  #load(): void {
    if (!existsSync(this.#path)) {
      mkdirSync(dirname(this.#path), { recursive: true });
      writeFileSync(this.#path, '');
      return;
    }
    const raw = readFileSync(this.#path, 'utf8');
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let event: LedgerEvent;
      try {
        event = JSON.parse(trimmed) as LedgerEvent;
      } catch {
        // 损坏的行不静默吞掉，直接报错 —— 账本里最忌讳"看起来正常"
        throw new Error(`账本第 ${this.#seq + 1} 段无法解析，文件可能被截断：${this.#path}`);
      }
      if (event.kind === 'label') {
        this.#labels.set(event.decisionId, event);
      } else {
        this.#decisions.push(event.record);
        this.#seq = event.record.seq;
        this.#lastHash = event.record.hash;
      }
    }
    this.#applyLabels();
  }

  #applyLabels(): void {
    for (const record of this.#decisions) {
      const label = this.#labels.get(record.decisionId);
      if (!label) continue;
      record.label = label.label;
      record.labelNote = label.note;
      record.labelTs = label.ts;
    }
  }

  #write(event: LedgerEvent): void {
    if (this.#path === ':memory:') return;
    appendFileSync(this.#path, JSON.stringify(event) + '\n', 'utf8');
  }

  /** 追加一条决定。seq / prevHash / hash 由账本自己算，调用方无法伪造。 */
  append(input: NewRecord): DecisionRecord {
    const seq = this.#seq + 1;
    const body = { ...input, seq, prevHash: this.#lastHash };
    const hash = hashObject(body);
    const record: DecisionRecord = { ...body, hash, label: 'unknown' };
    this.#decisions.push(record);
    this.#seq = seq;
    this.#lastHash = hash;
    this.#write({ kind: 'decision', record });
    return record;
  }

  /** 回填事后结果。单独成事件，不改写原记录。 */
  label(decisionId: string, label: OutcomeLabel, note?: string): void {
    const event: LabelEvent = { kind: 'label', decisionId, label, note, ts: new Date().toISOString() };
    this.#labels.set(decisionId, event);
    this.#write(event);
    const record = this.#decisions.find((r) => r.decisionId === decisionId);
    if (record) {
      record.label = label;
      record.labelNote = note;
      record.labelTs = event.ts;
    }
  }

  all(): DecisionRecord[] {
    return [...this.#decisions];
  }

  bySession(sessionId: string): DecisionRecord[] {
    return this.#decisions.filter((r) => r.sessionId === sessionId);
  }

  since(ts: number): DecisionRecord[] {
    return this.#decisions.filter((r) => Date.parse(r.ts) >= ts);
  }

  sessionSpend(sessionId: string): number {
    return this.bySession(sessionId).reduce((sum, r) => sum + (r.costUsd || 0), 0);
  }

  /** 重算整条哈希链。任何一处被改过都会在这里暴露。 */
  verify(): { ok: boolean; brokenAt?: number; reason?: string; count: number } {
    let prev = GENESIS_HASH;
    for (let i = 0; i < this.#decisions.length; i += 1) {
      const record = this.#decisions[i]!;
      if (record.seq !== i + 1) {
        return { ok: false, brokenAt: i + 1, reason: `序号断裂：期望 ${i + 1}，实际 ${record.seq}`, count: this.#decisions.length };
      }
      if (record.prevHash !== prev) {
        return { ok: false, brokenAt: i + 1, reason: 'prevHash 与上一条记录不一致', count: this.#decisions.length };
      }
      const { hash, label, labelNote, labelTs, ...body } = record;
      const expected = hashObject(body);
      if (expected !== hash) {
        return { ok: false, brokenAt: i + 1, reason: `哈希不匹配：记录内容被修改过（决策 ${record.decisionId}）`, count: this.#decisions.length };
      }
      prev = hash;
    }
    return { ok: true, count: this.#decisions.length };
  }
}
