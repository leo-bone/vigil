import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { hashObject } from '../util/canonical.ts';
import type { ApprovalInfo, DecisionRecord, OutcomeLabel } from '../types.ts';
import { signBytes, verifyBytes } from './signing.ts';

export const GENESIS_HASH = '0'.repeat(64);

/** 签名能力。signer 由调用方注入；账本自己不持有私钥。 */
export interface LedgerSigner {
  publicKeyPem: string;
  sign(data: string): string;
}

export type NewRecord = Omit<
  DecisionRecord,
  'seq' | 'prevHash' | 'hash' | 'label' | 'labelNote' | 'labelTs' | 'sig' | 'approval'
>;

interface LabelEvent {
  kind: 'label';
  decisionId: string;
  label: OutcomeLabel;
  note?: string;
  ts: string;
}

export interface NewApproval {
  decisionId: string;
  decision: 'approved' | 'rejected';
  approver: string;
  note?: string;
}

export interface ApprovalEvent extends NewApproval {
  kind: 'approval';
  /** 审批所绑定的记录哈希：审批者所见即所批，记录被改过就对不上 */
  boundHash: string;
  ts: string;
  sig?: string;
}

interface DecisionEvent {
  kind: 'decision';
  record: DecisionRecord;
}

type LedgerEvent = DecisionEvent | LabelEvent | ApprovalEvent;

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
  #approvals = new Map<string, ApprovalEvent>();
  #lastHash: string = GENESIS_HASH;
  #seq = 0;
  #signer: LedgerSigner | null;
  #publicKeyPem: string | null;

  constructor(path: string = '.vigil/ledger.ndjson', options: { signer?: LedgerSigner; publicKeyPem?: string } = {}) {
    this.#path = path;
    // signer：写路径用（追加时签名）；publicKeyPem：只读验证用（如独立验证进程）
    this.#signer = options.signer ?? null;
    this.#publicKeyPem = options.signer?.publicKeyPem ?? options.publicKeyPem ?? null;
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
      } else if (event.kind === 'approval') {
        this.#approvals.set(event.decisionId, event);
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
      if (label) {
        record.label = label.label;
        record.labelNote = label.note;
        record.labelTs = label.ts;
      }
      const approval = this.#approvals.get(record.decisionId);
      if (approval) {
        record.approval = {
          decision: approval.decision,
          approver: approval.approver,
          boundHash: approval.boundHash,
          note: approval.note,
          ts: approval.ts,
          sig: approval.sig,
        };
      }
    }
  }

  #write(event: LedgerEvent): void {
    if (this.#path === ':memory:') return;
    appendFileSync(this.#path, JSON.stringify(event) + '\n', 'utf8');
  }

  /** 追加一条决定。seq / prevHash / hash / sig 由账本自己算，调用方无法伪造。 */
  append(input: NewRecord): DecisionRecord {
    const seq = this.#seq + 1;
    const body = { ...input, seq, prevHash: this.#lastHash };
    const hash = hashObject(body);
    // 签名对"记录哈希"生效：改任何字段都会同时破坏哈希链和签名
    const sig = this.#signer ? this.#signer.sign(hash) : undefined;
    const record: DecisionRecord = { ...body, hash, sig, label: 'unknown' };
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

  /**
   * 人工审批一条待升级的决定。
   *
   * 两条硬约束：
   * 1. 审批绑定审批当时的记录哈希（boundHash）——之后记录被篡改，审批自动失效。
   * 2. 已有审批结论的记录拒绝重复审批；反悔就再追加一条新事件，绝不改写。
   */
  approve(input: NewApproval): ApprovalInfo {
    const record = this.#decisions.find((r) => r.decisionId === input.decisionId);
    if (!record) throw new Error(`决策不存在：${input.decisionId}`);
    if (this.#approvals.has(input.decisionId)) {
      throw new Error(`决策已有审批结论（${this.#approvals.get(input.decisionId)!.decision}），如需反悔请追加新记录`);
    }
    const event: ApprovalEvent = {
      kind: 'approval',
      decisionId: input.decisionId,
      decision: input.decision,
      approver: input.approver,
      note: input.note,
      boundHash: record.hash,
      ts: new Date().toISOString(),
    };
    if (this.#signer) event.sig = this.#signer.sign(`${event.boundHash}:${event.decision}:${event.approver}:${event.ts}`);
    this.#approvals.set(input.decisionId, event);
    this.#write(event);
    record.approval = {
      decision: event.decision,
      approver: event.approver,
      boundHash: event.boundHash,
      note: event.note,
      ts: event.ts,
      sig: event.sig,
    };
    return record.approval;
  }

  /** 还没批的升级项：结论是 require_human 且尚无审批事件。 */
  pendingApprovals(): DecisionRecord[] {
    return this.#decisions.filter((r) => r.outcome === 'require_human' && !r.approval);
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

  /**
   * 重算整条哈希链 + 验证全部签名。
   *
   * 哈希链：任何一处被改过都会在这里暴露。
   * 签名：配置了公钥才验；有签名却验不了（无公钥/验签失败）都算失败 —— 账本里最忌讳"看起来正常"。
   */
  verify(): { ok: boolean; brokenAt?: number; reason?: string; count: number; signaturesVerified?: number } {
    let prev = GENESIS_HASH;
    let signaturesVerified = 0;
    for (let i = 0; i < this.#decisions.length; i += 1) {
      const record = this.#decisions[i]!;
      if (record.seq !== i + 1) {
        return { ok: false, brokenAt: i + 1, reason: `序号断裂：期望 ${i + 1}，实际 ${record.seq}`, count: this.#decisions.length };
      }
      if (record.prevHash !== prev) {
        return { ok: false, brokenAt: i + 1, reason: 'prevHash 与上一条记录不一致', count: this.#decisions.length };
      }
      const { hash, label, labelNote, labelTs, approval, sig, ...body } = record;
      const expected = hashObject(body);
      if (expected !== hash) {
        return { ok: false, brokenAt: i + 1, reason: `哈希不匹配：记录内容被修改过（决策 ${record.decisionId}）`, count: this.#decisions.length };
      }
      if (sig) {
        if (!this.#publicKeyPem) {
          return { ok: false, brokenAt: i + 1, reason: `记录有签名但未提供验签公钥（决策 ${record.decisionId}）`, count: this.#decisions.length };
        }
        if (!verifyBytes(this.#publicKeyPem, hash, sig)) {
          return { ok: false, brokenAt: i + 1, reason: `签名验证失败：记录或签名被篡改（决策 ${record.decisionId}）`, count: this.#decisions.length };
        }
        signaturesVerified += 1;
      }
      prev = hash;
    }
    return { ok: true, count: this.#decisions.length, signaturesVerified };
  }
}
