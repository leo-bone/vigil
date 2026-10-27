import type { ApprovalInfo, DecisionRecord, OutcomeLabel } from '../types.ts';
import type { NewApproval, NewRecord } from './store.ts';

/**
 * 账本后端接口。
 *
 * 抽出这层是为了让存储可替换：NDJSON（单进程、零依赖、人可读）
 * 和 SQLite（多进程并发）两种实现共用同一套哈希链语义，
 * 所以同一个账本用哪种后端存的，验签结果和链的语义完全一致。
 */
export interface LedgerBackend {
  /** 账本位置。内存账本是 ':memory:'。 */
  readonly path: string;
  /** 追加一条决定。seq / prevHash / hash 由后端自己算，调用方无法伪造。 */
  append(input: NewRecord): DecisionRecord;
  /** 回填事后结果，不改写原记录。 */
  label(decisionId: string, label: OutcomeLabel, note?: string): void;
  /** 人工审批一条待升级的决定，审批绑定当时的记录哈希。 */
  approve(input: NewApproval): ApprovalInfo;
  /** 还没批的升级项。 */
  pendingApprovals(): DecisionRecord[];
  all(): DecisionRecord[];
  bySession(sessionId: string): DecisionRecord[];
  since(ts: number): DecisionRecord[];
  sessionSpend(sessionId: string): number;
  /** 重算哈希链并验签。 */
  verify(): {
    ok: boolean;
    brokenAt?: number;
    reason?: string;
    count: number;
    signaturesVerified?: number;
  };
}

export type { ApprovalInfo, DecisionRecord, OutcomeLabel, NewApproval, NewRecord };
