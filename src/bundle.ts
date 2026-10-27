import type { LedgerBackend } from './ledger/backend.ts';
import type { DecisionRecord } from './types.ts';

/**
 * 离线验证包。
 *
 * 审计的价值在"第三方不用信你的进程也能验"。把记录、标签、审批和公钥
 * 打成一个自包含的 JSON 文件，配上 verify-standalone.mjs 就能在任何机器上
 * 重算哈希链、验证 Ed25519 签名 —— 不需要装 Vigil，不需要访问原始账本。
 */
export interface VigilBundle {
  format: 'vigil-bundle@1';
  exportedAt: string;
  count: number;
  genesis: string;
  /** 链尾哈希。验证成功的标志之一：与最后一条记录的 hash 一致。 */
  root: string;
  /** Ed25519 公钥；记录带签名时必带。 */
  publicKeyPem?: string;
  records: DecisionRecord[];
}

export function exportBundle(ledger: LedgerBackend, publicKeyPem?: string): VigilBundle {
  const records = ledger.all();
  const chain = ledger.verify();
  if (!chain.ok) {
    throw new Error(`账本本身已损坏，拒绝导出：${chain.reason}`);
  }
  const bundle: VigilBundle = {
    format: 'vigil-bundle@1',
    exportedAt: new Date().toISOString(),
    count: records.length,
    genesis: '0'.repeat(64),
    root: records.length > 0 ? records[records.length - 1]!.hash : '0'.repeat(64),
    records,
  };
  if (records.some((r) => r.sig)) {
    if (!publicKeyPem) throw new Error('记录带签名但未提供公钥，无法导出可离线验证的包');
    bundle.publicKeyPem = publicKeyPem;
  }
  return bundle;
}
