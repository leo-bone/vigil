import type { Rule } from '../policy/rules.ts';

/**
 * 流水线岔路的确定性规则。
 *
 * 这些规则只在请求的 extras 里带上了对应字段时才生效，
 * 普通请求（hook、MCP、CLI）完全不受影响。它们保证：
 * 岔路里"数数就能判断"的事永远不交给概率模型。
 */
export const pipelineRules: Rule[] = [
  {
    id: 'stoploss.attempt_cap',
    description: '重试次数已达上限，止损退出',
    severity: 'deny',
    check: (req) => {
      const s = req.extras?.stoploss as
        | { attempts: number; maxAttempts: number; consecutiveFailures?: number; failureThreshold?: number }
        | undefined;
      if (!s) return null;
      if (s.attempts < s.maxAttempts) return null;
      return {
        rule: 'stoploss.attempt_cap',
        severity: 'deny',
        detail: `任务已尝试 ${s.attempts} 次，达到上限 ${s.maxAttempts}，止损退出`,
      };
    },
  },
  {
    id: 'stoploss.consecutive_failures',
    description: '连续失败达到阈值',
    severity: 'escalate',
    check: (req) => {
      const s = req.extras?.stoploss as
        | { attempts: number; maxAttempts: number; consecutiveFailures?: number; failureThreshold?: number }
        | undefined;
      if (!s) return null;
      const threshold = s.failureThreshold ?? 2;
      if ((s.consecutiveFailures ?? 0) < threshold) return null;
      return {
        rule: 'stoploss.consecutive_failures',
        severity: 'escalate',
        detail: `已连续失败 ${s.consecutiveFailures} 次（阈值 ${threshold}），继续重试大概率还是失败`,
      };
    },
  },
  {
    id: 'acceptance.self_verified',
    description: '验收证据里混入自产自验的记录',
    severity: 'escalate',
    check: (req) => {
      const claimant = req.extras?.claimant as string | undefined;
      if (!claimant) return null;
      const bad = (req.evidence ?? []).filter((e) => e.verified === true && e.producedBy === claimant);
      if (bad.length === 0) return null;
      return {
        rule: 'acceptance.self_verified',
        severity: 'escalate',
        detail: `${bad.length} 份"已核验"证据由主张人 ${claimant} 自己产出，验收不采信自产自验`,
      };
    },
  },
  {
    id: 'acceptance.checklist',
    description: '验收四项清单缺项',
    severity: 'escalate',
    check: (req) => {
      const c = req.extras?.acceptance as
        | { deliverableProvided: boolean; independentVerification: boolean; leftoverDeclared: boolean }
        | undefined;
      if (!c) return null;
      const missing: string[] = [];
      if (!c.deliverableProvided) missing.push('交付物及位置');
      if (!c.independentVerification) missing.push('独立核验记录');
      if (!c.leftoverDeclared) missing.push('遗留问题声明');
      if (missing.length === 0) return null;
      return {
        rule: 'acceptance.checklist',
        severity: 'escalate',
        detail: `验收清单缺项：${missing.join('、')} —— 缺一项就不算完成`,
      };
    },
  },
];
