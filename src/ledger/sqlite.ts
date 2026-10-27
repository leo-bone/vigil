import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { createRequire } from 'node:module';
import type { DatabaseSync } from 'node:sqlite';
import { hashObject } from '../util/canonical.ts';
import type { ApprovalInfo, DecisionRecord, OutcomeLabel } from '../types.ts';
import { signBytes, verifyBytes } from './signing.ts';
import { GENESIS_HASH, stripDerived } from './store.ts';
import type { LedgerSigner, NewApproval, NewRecord } from './store.ts';

/**
 * SQLite 支撑的账本 —— 多个进程可以同时写同一个账本。
 *
 * 为什么用 node:sqlite 而不是 libsql：
 * libsql 要装依赖，而这个项目的卖点之一是运行时零依赖。
 * Node 22 自带的 node:sqlite 够用：WAL 模式让读写不互相阻塞，
 * BEGIN IMMEDIATE 保证哈希链的"读上一条 → 算哈希 → 写入"是原子的。
 *
 * 哈希链语义与 NDJSON 版完全一致：哈希只覆盖记录内容，与存储方式无关。
 * 所以同一个账本换后端不会让已有的验证包失效。
 */

const SCHEMA = `
CREATE TABLE IF NOT EXISTS decisions (
  seq         INTEGER PRIMARY KEY,
  decision_id TEXT NOT NULL UNIQUE,
  ts          TEXT NOT NULL,
  session_id  TEXT NOT NULL,
  actor       TEXT NOT NULL,
  outcome     TEXT NOT NULL,
  cost_usd    REAL NOT NULL DEFAULT 0,
  hash        TEXT NOT NULL,
  prev_hash   TEXT NOT NULL,
  body        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_decisions_session ON decisions(session_id);
CREATE INDEX IF NOT EXISTS idx_decisions_ts ON decisions(ts);

CREATE TABLE IF NOT EXISTS labels (
  decision_id TEXT PRIMARY KEY,
  label       TEXT NOT NULL,
  note        TEXT,
  ts          TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS approvals (
  decision_id TEXT PRIMARY KEY,
  decision    TEXT NOT NULL,
  approver    TEXT NOT NULL,
  note        TEXT,
  bound_hash  TEXT NOT NULL,
  ts          TEXT NOT NULL,
  sig         TEXT
);
`;

/**
 * node:sqlite 在 Node 22 里还是实验特性，会打一条 ExperimentalWarning。
 *
 * 我们接管 warning 通道，只放行非 SQLite 的警告 —— 不是为了藏问题，
 * 而是因为每个用户跑每条命令都看一遍同样的提示，太吵。
 *
 * 必须先接管再加载模块：警告是在模块首次加载时发出的，
 * 用静态 import 的话，警告在我们有机会接管之前就已经打完了。
 */
function silenceSqliteWarning(): void {
  if (process.env.VIGIL_SHOW_SQLITE_WARNING === '1') return;
  const listeners = process.listeners('warning') as Array<(warning: Error) => void>;
  if (listeners.length === 0) return;
  process.removeAllListeners('warning');
  process.on('warning', (warning: Error) => {
    if (warning.name === 'ExperimentalWarning' && /SQLite/i.test(warning.message)) return;
    for (const listener of listeners) {
      try {
        listener.call(process, warning);
      } catch {
        /* 警告处理失败不该影响主流程 */
      }
    }
  });
}

type SqliteModule = typeof import('node:sqlite');

let sqliteModule: SqliteModule | null = null;

/** 惰性加载 node:sqlite —— 装好警告过滤器之后才加载模块 */
function loadSqlite(): SqliteModule {
  if (sqliteModule) return sqliteModule;
  silenceSqliteWarning();
  const require = createRequire(import.meta.url);
  sqliteModule = require('node:sqlite') as SqliteModule;
  return sqliteModule;
}

export interface SqliteLedgerOptions {
  signer?: LedgerSigner;
  publicKeyPem?: string;
  /** 写锁等待毫秒数，默认 5000 */
  busyTimeoutMs?: number;
}

export class SqliteLedger {
  #db: DatabaseSync;
  #path: string;
  #signer: LedgerSigner | null;
  #publicKeyPem: string | null;

  constructor(path: string = '.vigil/ledger.db', options: SqliteLedgerOptions = {}) {
    if (path === ':memory:') throw new Error('SQLite 账本需要真实文件路径');
    this.#path = path;
    this.#signer = options.signer ?? null;
    this.#publicKeyPem = options.signer?.publicKeyPem ?? options.publicKeyPem ?? null;

    const { DatabaseSync: Database } = loadSqlite();

    if (!existsSync(path)) mkdirSync(dirname(path), { recursive: true });
    this.#db = new Database(path);
    // 顺序要紧：busy_timeout 必须先设，否则并发打开时切 WAL 会直接 "database is locked"
    this.#db.exec(`PRAGMA busy_timeout = ${options.busyTimeoutMs ?? 5000}`);
    // WAL：读写不互相阻塞
    this.#db.exec('PRAGMA journal_mode = WAL');
    this.#db.exec('PRAGMA foreign_keys = ON');
    this.#db.exec(SCHEMA);
  }

  get path(): string {
    return this.#path;
  }

  /** 关掉句柄。进程退出时不需要手动调，但测试里要。 */
  close(): void {
    this.#db.close();
  }

  /**
   * 追加一条决定。seq / prevHash / hash 由后端自己算，调用方无法伪造。
   *
   * options.sig 只给迁移用：哈希不覆盖签名，所以事后附加原签名是安全的。
   */
  append(input: NewRecord, options: { sig?: string } = {}): DecisionRecord {
    // BEGIN IMMEDIATE 立刻拿写锁：读上一条 → 算哈希 → 写入 必须是一个整体，
    // 否则两个进程会算出同一条 prevHash，链就断了。
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      const tail = this.#db
        .prepare('SELECT seq, hash FROM decisions ORDER BY seq DESC LIMIT 1')
        .get() as { seq: number; hash: string } | undefined;
      const seq = (tail?.seq ?? 0) + 1;
      const prevHash = tail?.hash ?? GENESIS_HASH;

      // 防御：调用方（尤其是 JS 调用方）可能顺手传了 seq/prevHash/hash。
      // 这些字段一律由账本自己算，带着它们算哈希会算出无法验证的记录。
      const body = { ...stripDerived(input), seq, prevHash };
      const hash = hashObject(body);
      const sig = options.sig ?? (this.#signer ? this.#signer.sign(hash) : undefined);
      const record: DecisionRecord = { ...body, hash, sig, label: 'unknown' };

      this.#db
        .prepare(
          `INSERT INTO decisions
             (seq, decision_id, ts, session_id, actor, outcome, cost_usd, hash, prev_hash, body)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          record.seq,
          record.decisionId,
          record.ts,
          record.sessionId,
          record.actor,
          record.outcome,
          record.costUsd ?? 0,
          record.hash,
          record.prevHash,
          JSON.stringify(record),
        );
      this.#db.exec('COMMIT');
      return record;
    } catch (error) {
      this.#db.exec('ROLLBACK');
      throw error;
    }
  }

  label(decisionId: string, label: OutcomeLabel, note?: string): void {
    const ts = new Date().toISOString();
    this.#db
      .prepare(
        `INSERT INTO labels (decision_id, label, note, ts) VALUES (?, ?, ?, ?)
         ON CONFLICT(decision_id) DO UPDATE SET label = excluded.label, note = excluded.note, ts = excluded.ts`,
      )
      .run(decisionId, label, note ?? null, ts);
  }

  approve(input: NewApproval): ApprovalInfo {
    const record = this.#find(input.decisionId);
    if (!record) throw new Error(`决策不存在：${input.decisionId}`);
    const existing = this.#db
      .prepare('SELECT decision FROM approvals WHERE decision_id = ?')
      .get(input.decisionId) as { decision: string } | undefined;
    if (existing) {
      throw new Error(
        `决策已有审批结论（${existing.decision}），如需反悔请追加新记录`,
      );
    }
    const ts = new Date().toISOString();
    const sig = this.#signer
      ? this.#signer.sign(`${record.hash}:${input.decision}:${input.approver}:${ts}`)
      : undefined;
    this.#db
      .prepare(
        `INSERT INTO approvals (decision_id, decision, approver, note, bound_hash, ts, sig)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(input.decisionId, input.decision, input.approver, input.note ?? null, record.hash, ts, sig ?? null);
    return {
      decision: input.decision,
      approver: input.approver,
      boundHash: record.hash,
      note: input.note,
      ts,
      sig,
    };
  }

  pendingApprovals(): DecisionRecord[] {
    return this.all().filter((record) => record.outcome === 'require_human' && !record.approval);
  }

  all(): DecisionRecord[] {
    const rows = this.#db.prepare('SELECT body FROM decisions ORDER BY seq ASC').all() as Array<{ body: string }>;
    const records = rows.map((row) => JSON.parse(row.body) as DecisionRecord);
    return this.#attachLabels(records);
  }

  bySession(sessionId: string): DecisionRecord[] {
    const rows = this.#db
      .prepare('SELECT body FROM decisions WHERE session_id = ? ORDER BY seq ASC')
      .all(sessionId) as Array<{ body: string }>;
    return this.#attachLabels(rows.map((row) => JSON.parse(row.body) as DecisionRecord));
  }

  since(ts: number): DecisionRecord[] {
    const rows = this.#db
      .prepare('SELECT body FROM decisions WHERE ts >= ? ORDER BY seq ASC')
      .all(new Date(ts).toISOString()) as Array<{ body: string }>;
    return this.#attachLabels(rows.map((row) => JSON.parse(row.body) as DecisionRecord));
  }

  sessionSpend(sessionId: string): number {
    const row = this.#db
      .prepare('SELECT COALESCE(SUM(cost_usd), 0) AS total FROM decisions WHERE session_id = ?')
      .get(sessionId) as { total: number };
    return row.total ?? 0;
  }

  verify(): {
    ok: boolean;
    brokenAt?: number;
    reason?: string;
    count: number;
    signaturesVerified?: number;
  } {
    const rows = this.#db.prepare('SELECT body FROM decisions ORDER BY seq ASC').all() as Array<{ body: string }>;
    let prev = GENESIS_HASH;
    let signaturesVerified = 0;
    for (let i = 0; i < rows.length; i += 1) {
      const record = JSON.parse(rows[i]!.body) as DecisionRecord;
      if (record.seq !== i + 1) {
        return { ok: false, brokenAt: i + 1, reason: `序号断裂：期望 ${i + 1}，实际 ${record.seq}`, count: rows.length };
      }
      if (record.prevHash !== prev) {
        return { ok: false, brokenAt: i + 1, reason: 'prevHash 与上一条记录不一致', count: rows.length };
      }
      const { hash, label, labelNote, labelTs, approval, sig, ...body } = record;
      const expected = hashObject(body);
      if (expected !== hash) {
        return {
          ok: false,
          brokenAt: i + 1,
          reason: `哈希不匹配：记录内容被修改过（决策 ${record.decisionId}）`,
          count: rows.length,
        };
      }
      if (sig) {
        if (!this.#publicKeyPem) {
          return {
            ok: false,
            brokenAt: i + 1,
            reason: `记录有签名但未提供验签公钥（决策 ${record.decisionId}）`,
            count: rows.length,
          };
        }
        if (!verifyBytes(this.#publicKeyPem, hash, sig)) {
          return {
            ok: false,
            brokenAt: i + 1,
            reason: `签名验证失败：记录或签名被篡改（决策 ${record.decisionId}）`,
            count: rows.length,
          };
        }
        signaturesVerified += 1;
      }
      prev = hash;
    }
    return { ok: true, count: rows.length, signaturesVerified };
  }

  #find(decisionId: string): DecisionRecord | undefined {
    const row = this.#db
      .prepare('SELECT body FROM decisions WHERE decision_id = ?')
      .get(decisionId) as { body: string } | undefined;
    if (!row) return undefined;
    return JSON.parse(row.body) as DecisionRecord;
  }

  #attachLabels(records: DecisionRecord[]): DecisionRecord[] {
    if (records.length === 0) return records;
    const labels = this.#db.prepare('SELECT * FROM labels').all() as Array<{
      decision_id: string;
      label: OutcomeLabel;
      note: string | null;
      ts: string;
    }>;
    const approvals = this.#db.prepare('SELECT * FROM approvals').all() as Array<{
      decision_id: string;
      decision: 'approved' | 'rejected';
      approver: string;
      note: string | null;
      bound_hash: string;
      ts: string;
      sig: string | null;
    }>;
    const labelMap = new Map(labels.map((item) => [item.decision_id, item]));
    const approvalMap = new Map(approvals.map((item) => [item.decision_id, item]));
    for (const record of records) {
      const label = labelMap.get(record.decisionId);
      if (label) {
        record.label = label.label;
        record.labelNote = label.note ?? undefined;
        record.labelTs = label.ts;
      }
      const approval = approvalMap.get(record.decisionId);
      if (approval) {
        record.approval = {
          decision: approval.decision,
          approver: approval.approver,
          boundHash: approval.bound_hash,
          note: approval.note ?? undefined,
          ts: approval.ts,
          sig: approval.sig ?? undefined,
        };
      }
    }
    return records;
  }
}

/**
 * 把一个 NDJSON 账本导入 SQLite。
 *
 * 导入后哈希链完全一致 —— 因为哈希只覆盖记录内容，与存储无关。
 */
export function importNdjson(ndjsonPath: string, sqlitePath: string): { imported: number; skipped: number } {
  const ledger = new SqliteLedger(sqlitePath);
  let imported = 0;
  let skipped = 0;
  try {
    const raw = readFileSync(ndjsonPath, 'utf8');
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const event = JSON.parse(trimmed) as Record<string, unknown>;
      if (event.kind === 'decision') {
        const record = event.record as DecisionRecord;
        const existing = ledger.all().some((item) => item.decisionId === record.decisionId);
        if (existing) {
          skipped += 1;
          continue;
        }
        // 保留原签名：哈希不覆盖签名，事后附加是安全的，而且不附加就验不了签
        ledger.append(record as never, { sig: record.sig });
        imported += 1;
      } else if (event.kind === 'label') {
        ledger.label(event.decisionId as string, event.label as OutcomeLabel, event.note as string | undefined);
      } else if (event.kind === 'approval') {
        try {
          ledger.approve({
            decisionId: event.decisionId as string,
            decision: event.decision as 'approved' | 'rejected',
            approver: event.approver as string,
            note: event.note as string | undefined,
          });
        } catch {
          skipped += 1;
        }
      }
    }
  } finally {
    ledger.close();
  }
  return { imported, skipped };
}
