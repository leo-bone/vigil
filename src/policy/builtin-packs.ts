import type { RulePack } from './pack.ts';

/**
 * 内置规则包。
 *
 * 这四个是"行业事故形态"的样板：
 * 医疗数据、付款审批、多租户隔离、代码发布。
 * 它们不是开箱即用的完整清单（那需要你按自己的业务写），
 * 而是可以直接改的起点 —— 也是写自己规则包时最好的参考。
 */
export const BUILTIN_PACKS: RulePack[] = [
  {
    id: 'healthcare.patient-data',
    name: '医疗患者数据保护',
    version: '1.0.0',
    description: '患者健康信息属于个人敏感信息，外发与落地都要卡住',
    appliesTo: '任何涉及患者数据、处方、检验报告的动作',
    policy: {
      denylistTargets: ['patient-data/', 'prescriptions/', 'lab-results/', 'pacs/'],
    },
    rules: [
      {
        id: 'no-local-store',
        description: '患者数据不得落在工作目录里',
        severity: 'deny',
        detail: '目标 {target} 命中患者数据目录，患者数据不得存放在本地工作区',
        when: {
          targetMatches: ['patient-data*', 'prescriptions*', 'lab-results*', 'pacs*'],
        },
      },
      {
        id: 'no-unmasked-egress',
        description: '含患者标识的载荷不得离开本机',
        severity: 'escalate',
        detail: '载荷里出现患者标识字段，需要人工确认是否已脱敏',
        when: {
          payloadMatches: ['*身份证*', '*病历号*', '*patient_id*', '*patientId*', '*住院号*'],
          any: [{ external: true }, { kindIn: ['upload', 'write_file', 'send_email', 'publish'] }],
        },
      },
      {
        id: 'minimize',
        description: '导出患者数据必须人工确认',
        severity: 'escalate',
        detail: '导出患者数据属于不可逆操作，转人工确认范围与授权',
        when: {
          kindIn: ['export', 'dump', 'query', 'read'],
          targetMatches: ['*patient*', '*patient*'],
        },
      },
    ],
  },
  {
    id: 'finance.payment-approval',
    name: '付款审批',
    version: '1.0.0',
    description: '任何金额的划转都要人工过一道，金额越大越要查凭证',
    appliesTo: '付款、退款、转账、订阅续费',
    policy: {
      moneyCapPerAction: 0,
      moneyCapPerSession: 0,
    },
    rules: [
      {
        id: 'any-payment-needs-human',
        description: '涉及金额一律转人工',
        severity: 'escalate',
        detail: '动作涉及 {moneyUsd} 美元，资金不可挽回，转人工审批',
        when: { moneyUsdAtLeast: 0.01 },
      },
      {
        id: 'large-payment-needs-evidence',
        description: '大额付款必须带凭证',
        severity: 'escalate',
        detail: '大额付款没有附带凭证材料',
        when: {
          moneyUsdAtLeast: 500,
          not: { evidenceCountAtLeast: 1 },
        },
      },
      {
        id: 'no-credential-payments',
        description: '付款动作不得携带凭据形态的字符串',
        severity: 'deny',
        detail: '付款载荷中出现凭据形态字符串，已阻止',
        when: { payloadMatches: ['*sk_live*', '*-----BEGIN*PRIVATE KEY*'] },
      },
    ],
  },
  {
    id: 'saas.tenant-isolation',
    name: '多租户隔离',
    version: '1.0.0',
    description: 'agent 的动作不能跨租户，租户前缀必须显式出现',
    appliesTo: '任何读写租户数据的动作',
    policy: {
      denylistTargets: ['tenants/', 'other-tenants/'],
    },
    rules: [
      {
        id: 'no-blank-tenant',
        description: '动作必须指名租户',
        severity: 'escalate',
        detail: '动作没有指明租户，无法确认隔离，转人工',
        when: {
          kindIn: ['query', 'read', 'write_file', 'delete', 'export'],
          not: { targetMatches: ['tenant-*', 't_*'] },
        },
      },
      {
        id: 'no-cross-tenant',
        description: '不得跨租户读取',
        severity: 'deny',
        detail: '目标 {target} 指向其他租户的数据目录',
        when: { targetMatches: ['other-tenants*', 'tenants/*/../*'] },
      },
    ],
  },
  {
    id: 'code.release',
    name: '代码发布',
    version: '1.0.0',
    description: '发布动作影响所有人，不能靠"看起来没问题"就放行',
    appliesTo: '发布包、推镜像、合并主干、改生产配置',
    policy: {
      denylistTargets: ['production'],
    },
    rules: [
      {
        id: 'release-needs-human',
        description: '发布动作转人工',
        severity: 'escalate',
        detail: '发布类动作影响面大，转人工确认',
        when: {
          kindIn: ['publish', 'deploy', 'release', 'merge'],
          any: [{ external: true }, { not: { reversible: true } }],
        },
      },
      {
        id: 'no-production-write',
        description: '生产配置不得由 agent 直接改',
        severity: 'deny',
        detail: '目标 {target} 是生产环境配置，禁止 agent 直接写入',
        when: {
          kindIn: ['write_file', 'edit', 'apply_patch'],
          targetMatches: ['production*', 'prod*', '*.prod.*'],
        },
      },
    ],
  },
];

export function findBuiltinPack(id: string): RulePack | undefined {
  return BUILTIN_PACKS.find((pack) => pack.id === id);
}
