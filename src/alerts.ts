import type { DecisionRecord } from './types.ts';
import { Ledger } from './ledger/store.ts';

export type Severity = 'info' | 'warn' | 'critical';

export interface Alert {
  id: string;
  severity: Severity;
  title: string;
  detail: string;
  refs: string[];
}

export interface AlertOptions {
  /** 观察窗口，默认 30 分钟 */
  windowMs?: number;
  /** 窗口内成本上限 */
  costCapUsd?: number;
  /** 越权尝试次数阈值 */
  authorityAttempts?: number;
  /** 置信度塌陷阈值 */
  confidenceFloor?: number;
  now?: number;
}

const DEFAULT_WINDOW = 30 * 60 * 1000;

/**
 * 预警扫描。
 *
 * 只保留四种真正需要人立刻看的信号。预警系统最大的敌人是噪音，
 * 而不是漏报 —— 一个没人看的告警等于没有告警。
 */
export function scanAlerts(ledger: Ledger, options: AlertOptions = {}): Alert[] {
  const windowMs = options.windowMs ?? DEFAULT_WINDOW;
  const now = options.now ?? Date.now();
  const recent = ledger.since(now - windowMs);
  const alerts: Alert[] = [];

  const spend = recent.reduce((sum, r) => sum + r.costUsd, 0);
  const cap = options.costCapUsd ?? 5;
  if (spend > cap) {
    alerts.push({
      id: 'cost.runaway',
      severity: 'critical',
      title: '成本失控',
      detail: `${(windowMs / 60000).toFixed(0)} 分钟内花费 ${spend.toFixed(2)} 美元，超过阈值 ${cap} 美元。检查是否有 agent 在循环里打转。`,
      refs: recent.slice(-5).map((r) => r.decisionId),
    });
  }

  const overreach = recent.filter((r) => r.required > r.granted);
  const attemptThreshold = options.authorityAttempts ?? 3;
  if (overreach.length >= attemptThreshold) {
    alerts.push({
      id: 'authority.repeated',
      severity: 'critical',
      title: '反复越权尝试',
      detail: `${overreach.length} 次动作超出该 actor 的授权等级。可能是路由错了，也可能是指令被注入。`,
      refs: overreach.map((r) => r.decisionId),
    });
  }

  const collapse = lastConsecutiveAllowed(recent, 3, (r) => weakestProbability(r) < (options.confidenceFloor ?? 0.6));
  if (collapse.length > 0) {
    alerts.push({
      id: 'confidence.collapse',
      severity: 'warn',
      title: '置信度塌陷',
      detail: `连续 ${collapse.length} 个动作在把握不足的情况下被放行，说明上游的闸门太松或者任务本身定义不清。`,
      refs: collapse.map((r) => r.decisionId),
    });
  }

  const drought = recent
    .filter((r) => r.outcome === 'allow' && r.action.external && r.evidenceIds.length === 0)
    .slice(-5);
  if (drought.length >= 3) {
    alerts.push({
      id: 'evidence.drought',
      severity: 'warn',
      title: '对外动作缺乏证据',
      detail: `最近有 ${drought.length} 个对外动作在没有证据的情况下放行，违反"禁止无证据的已完成"。`,
      refs: drought.map((r) => r.decisionId),
    });
  }

  const falsified = recent.filter((r) => r.label === 'wrong');
  if (falsified.length > 0) {
    alerts.push({
      id: 'claim.falsified',
      severity: 'warn',
      title: '出现被证伪的完成声明',
      detail: `${falsified.length} 个已放行的动作事后被标记为错误，需要回看对应的判断规则。`,
      refs: falsified.map((r) => r.decisionId),
    });
  }

  return alerts;
}

function weakestProbability(record: DecisionRecord): number {
  const values = record.judgments.filter((j) => j.valid && j.type === 'boolean').map((j) => j.probability ?? 1);
  return values.length > 0 ? Math.min(...values) : 1;
}

function lastConsecutiveAllowed(
  records: DecisionRecord[],
  count: number,
  predicate: (record: DecisionRecord) => boolean,
): DecisionRecord[] {
  const allowed = records.filter((r) => r.outcome === 'allow');
  const tail = allowed.slice(-count);
  if (tail.length < count) return [];
  return tail.every(predicate) ? tail : [];
}
