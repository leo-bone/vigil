import { defaultPolicy } from '../policy/rules.ts';
import type { PolicyContext } from '../policy/rules.ts';

/**
 * 给"拦截 agent 工具调用"这个场景准备的策略。
 *
 * 与默认策略的区别：
 * - 金钱上限归零：任何涉及钱的动作一律否决，不留自主空间。
 * - agent 只授予 L2：干活够用（读、写草稿、可逆写入），
 *   凡是 L3 以上（对外、不可逆、花钱）都会变成"问一下人"。
 * - 禁止清单更贴近真实事故：凭据文件、云凭据、生产环境。
 */
export function hookPolicy(overrides: Partial<PolicyContext> = {}): PolicyContext {
  return defaultPolicy({
    moneyCapPerAction: 0,
    moneyCapPerSession: 25,
    allowAutonomousIrreversible: false,
    denylistTargets: [
      '.env',
      '.npmrc',
      'id_rsa',
      '.ssh/',
      '.aws/credentials',
      'secrets/',
      '/etc/',
      'production',
    ],
    grants: [
      { actor: 'agent/*', authority: 2 },
      { actor: 'human/*', authority: 4 },
    ],
    ...overrides,
  });
}
