# 竞品与生态调查（2026-10-27）

结论先行：**"哈希链账本 + 审批"已经不稀奇了，但"校准闭环 + 五岔路循环 + 虚假完成率"目前没有第二家做。** 我们该放弃的幻想是靠账本本身立足，该补齐的短板是签名、可恢复审批和本地判断模型。

## 一、直接同类（决策审计 / 治理层）

| 项目 | 核心能力 | 比 Vigil 强的 | 比 Vigil 弱的 |
|---|---|---|---|
| **MakerChecker**（makerchecker.ai） | deny-by-default 工具治理、RBAC 角色/技能、审批收件箱、Ed25519+RFC8785 签名审计链、离线验证包、`mc scan` 静态扫描并生成治理配置 | 签名、离线验证、审批流程成品、扫描式上手、四种行业示例 | 无校准闭环、无止损/质量门/验收五岔路、无事后指标 |
| **microsoft/agent-governance-toolkit** | Rust 策略引擎、DID agent 身份、OWASP Agentic Top 10 全覆盖、OCSF 事件导出、policy replay（most-specific-wins 冲突解析）、Decision BOM | 工程厚度、合规映射、多语言 SDK、GitHub Action | 重（K8s/Helm/沙箱），个人用不动；无校准 |
| **OMA / open-multi-agent**（7k★） | 编排器自带治理：可恢复审批（重启不丢）、**审批绑定到审阅者所见内容的 SHA-256**、verifiable journal、governance floor、egress policy | 持久化审批与恢复、审批内容绑定 | 是编排器不是决策层；无概率判断、无校准、无事后复盘指标 |
| **Headlights** | 链式证据（ConductRecord）+ 六道前置门（Authority/Constraint/Persona/Citation/Verification/Egress） | 门类型更细（引用核验、人格漂移、数据出境） | 无校准、无编排循环 |
| **Aegis / sofagent / halo-record / InALign / bernstein** | 各自做了签名账本、HITL、kill switch、RFC 3161 时间戳、OTel 摄入等单点 | 各有一两件我们的短板 | 都是单点工具，无决策回路 |

## 二、判断模型层（Jev 已不是唯一选择）

这是最大的外部变化：闭源 Jev 在三周内变成了多玩家市场。

| 模型 | 参数 | 延迟 | 成本 | 许可 |
|---|---|---|---|---|
| Jev（TypeSafe） | 不公开 | 70-500ms | $0.042/M in | 闭源 API |
| **Strands Decider 2B**（AWS） | 2B + pointer head | ~100ms | 免费 | Apache-2.0，可自训 |
| **Laya**（Convai） | 421M | 33ms | 免费 | Apache-2.0 |
| Kev-4B/9B（Jared Palmer） | 4B/9B | 18ms(H100) | 免费 | 开放权重 |
| OpenAI Decisions API | 不公开 | ~150ms | 闭源 | SaaS |

关键洞见（来自 laya-evals）：**置信度阈值必须按题型分别标定**——二选一题目 0.865 能到 95% 准确率，20 选 1 要 0.994。一个全局 floor 是伪策略。我们的 `floor` 是按题设的，但没有"从自己的标注数据自动算出该题型的推荐阈值"这条链路。

## 三、观测层（Langfuse/Phoenix/AgentOps）

定位仍是"发生了什么"，与 Vigil 互补不竞争。但注意：Langfuse 35k★、OTel 原生、100+ 集成。**我们不发 OTel span，就进不了别人的观测栈**，会被当成又一个孤岛。

## 四、给 Vigil 的优化清单（按性价比排序）

| # | 动作 | 为什么 | 成本 |
|---|---|---|---|
| 1 | **账本签名**：每条记录 Ed25519 签名（私钥离线保管） | 现在的哈希链只防"改一条"，不防"整条重写"。MakerChecker/InALign 都有签名，我们没有就是硬伤 | 小（node:crypto 原生支持 Ed25519） |
| 2 | **离线验证包**：`vigil bundle` 导出 + 独立 verifier | 审计价值在"第三方不用信你的进程也能验"，这是所有治理项目的共识卖点 | 小 |
| 3 | **本地判断模型适配器**：`LocalJudge` 对接 Strands Decider 2B / Laya 的本地 HTTP server | 摆脱闭源 Jev 依赖，零成本离线跑，Mock 之外第一次有"真判断"可用 | 中 |
| 4 | **按题型自动建议阈值**：`calibrate` 输出按题型（boolean/choice 选项数）分桶的推荐 floor，可直接写回策略 | 校准闭环是我们独有卖点，把它从"人看报告"推进到"机器改阈值"就没人跟进 | 小-中 |
| 5 | **可恢复升级**：升级从"结束任务"改成"挂起 + 审批令牌"；审批必须绑定 `recordHash`（审批者所见即所批） | OMA 证明这是刚需；我们已存 evidenceHash，就差审批动作本身 | 中 |
| 6 | **OTel GenAI span 导出** | 进 Langfuse 们的生态而不是和它们比孤岛 | 中 |
| 7 | **合规映射文档**：OWASP Agentic Top 10 / EU AI Act 逐条对照 | 纯文档工作，采纳杠杆最大 | 小 |
| 8 | `vigil scan` 上手工具 | MakerChecker 的 `mc scan` 把上手成本降到一个 npx 命令，值得抄 | 大（后置） |

## 五、不做什么

- 不做审批收件箱 UI、不做 Web 控制台 —— MakerChecker 已做透，AGPL 服务端我们没必要追。
- 不做多语言 SDK —— TypeScript 单语言 + MCP 是我们的零依赖卖点，别稀释。
- 不做 K8s/沙箱/agent 身份 —— 微软的地盘，个人开发者的场景用不到。
