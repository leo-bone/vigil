# 规则包（Rule Pack）

**一份规则包 = 一组行业事故形态的固化描述 + 一份策略补丁。**

它是 JSON，不是代码。这个选择带来三个后果，都是刻意的：

1. **装进流程的东西不会执行任何代码。** 规则包可以来自任何地方，
   即使来源不可信，它最多让一条规则永远命中，做不到别的。
2. **可以被审阅、被 diff、被签名。** 一个几十行的 JSON 没人看得懂一个
   隐藏了逻辑的 `.ts` 包。
3. **写规则包不需要会写 TypeScript。** 你的合规同事能自己维护它。

## 格式

```json
{
  "id": "healthcare.patient-data",
  "name": "医疗患者数据保护",
  "version": "1.0.0",
  "description": "患者健康信息属于个人敏感信息",
  "appliesTo": "任何涉及患者数据、处方、检验报告的动作",
  "policy": {
    "denylistTargets": ["patient-data/", "prescriptions/"],
    "moneyCapPerAction": 0
  },
  "rules": [
    {
      "id": "no-local-store",
      "description": "患者数据不得落在工作目录里",
      "severity": "deny",
      "detail": "目标 {target} 命中患者数据目录，患者数据不得存放在本地工作区",
      "when": {
        "targetMatches": ["patient-data*", "prescriptions*"]
      }
    }
  ]
}
```

### 规则字段

| 字段 | 必填 | 说明 |
|---|---|---|
| `id` | 是 | 包内唯一。实际规则 id 是 `包id.规则id` |
| `description` | 是 | 人看的说明 |
| `severity` | 是 | `deny`（一票否决）或 `escalate`（转人工） |
| `detail` | 否 | 命中时写进账本的说明。支持 `{target}` `{actor}` `{kind}` 占位 |
| `when` | 是 | 命中条件，至少要有一个字段 |

### 条件字段

顶层各字段之间是"与"关系。

| 字段 | 类型 | 说明 |
|---|---|---|
| `kindIn` | 字符串数组 | 动作类型在列表里 |
| `targetMatches` | 字符串数组 | 目标匹配任一模式（支持 `*`） |
| `payloadMatches` | 字符串数组 | 载荷匹配任一模式 |
| `actorMatches` | 字符串数组 | 谁在动 |
| `stateMatches` | 字符串数组 | 交给模型的材料里匹配 |
| `external` | 布尔 | 动作是否对外 |
| `reversible` | 布尔 | 动作是否可逆 |
| `moneyUsdAtLeast` | 数字 | 金额不低于该值 |
| `evidenceCountAtLeast` | 数字 | 证据条数不少于该值 |
| `all` | 条件数组 | 全部满足 |
| `any` | 条件数组 | 至少一个满足 |
| `not` | 条件 | 不满足 |

**为什么不用正则表达式**：规则包是可以从外部下载的，而正则有 ReDoS 风险 ——
一个精心构造的模式就能让你的进程卡死。这里用子串和 `*` 通配符，
表达力弱一点，但装进来的东西不会伤到你。

## 用法

```bash
vigil rules list                     # 看有哪些包（内置 + 已安装）
vigil rules show healthcare.patient-data
vigil rules check ./my-pack.json     # 校验一个包，不安装
vigil rules install healthcare.patient-data    # 安装内置包
vigil rules install ./my-pack.json              # 安装自己的包
```

装好的包在 `.vigil/packs/`（可用 `VIGIL_PACKS` 改），**下次启动内核时自动生效**：

- 包的规则会加进确定性规则集
- 包的 `policy` 补丁会合并进当前策略（禁止清单累加、授权表合并、金额上限覆盖）
- 配置优先级：内置保守默认 ← 规则包 ← `vigil.config.json`（配置能覆盖包）

## 生效顺序

```
请求 → 确定性规则（内置 + 规则包 + 流水线规则）
     → 概率模型（只在灰区）
     → 账本
```

规则包的规则和内置规则**没有区别**：都是确定性的一票否决或升级，
都写进同一本哈希链账本，都能在 `postmortem` 里被回放。

## 写规则包的几条经验

1. **先写清楚事故形态，再写规则。** "患者数据不能落在本地"是事故形态，
   "目标匹配 patient-data*" 是它的实现。规则包该记的是前者。
2. **能用 `deny` 就别用 `escalate`。** 否决是确定的，升级是每次都要人看一眼。
   只有当"这一下到底该不该做"需要人来判断时，才用 `escalate`。
3. **不要用规则包做授权。** 授权是 `grants` 的事，规则包最多收紧它。
4. **规则要能被解释。** `detail` 里写清楚"为什么拦"，人才能在复盘时看懂，
   也才能在规则过时的时候知道该改哪一条。

## 边界

- 规则包**不能**替代模型判断。它只能做"数数就能判定"的事。
  "这份研究够不够好"这种问题仍然走概率判断。
- 规则包**不会**自动更新。装上去就是那个版本，要改就改 JSON 再装一次。
- 目前没有"市场"：包靠人传。格式和安装机制已经就位，
  加一个索引和分发只是工程量问题，不是设计问题。
