# 合规映射：OWASP Agentic Top 10 与 EU AI Act

> 本文回答采购方和审计师最常问的问题："你们覆盖了哪些控制项？"
> 逐条对照，覆盖一半就说一半，不夸大。对照基准：OWASP Agentic AI Top 10（2025 首版）、EU AI Act 高风险系统义务条款。

## OWASP Agentic AI Top 10

| # | 威胁 | Vigil 的控制 | 覆盖程度 |
|---|---|---|---|
| 1 | Memory Poisoning（记忆投毒） | 证据通道带 `producedBy` 与 `verified` 标记；自产自验证据在验收时被拒（`acceptance.self_verified`）；证据内容进哈希链，事后可证"当时的依据" | 部分：不治理 agent 内部记忆本身 |
| 2 | Tool Misuse（工具滥用） | 动作形状授权阶梯（L0-L4）+ 确定性硬规则一票否决 + PreToolUse 钩子在执行边界强制 | **完整** |
| 3 | Privilege Compromise（权限提升） | 授权授予表 + 通配符 actor；所需授权与实际授予逐次比对，越权即 require_human | **完整**（前提：授予表本身不被篡改） |
| 4 | Resource Exhaustion（资源耗尽） | 会话成本上限（`money.session_cap`）、单笔上限、止损岔路（重试上限 + 连续失败阈值）、成本失控预警 | **完整** |
| 5 | Cascading Hallucination（幻觉级联） | 对外动作强制带证据（`evidence.required_for_external`）；全部证据未核验不放行；"禁止无证据的已完成"在验收清单中一票否决 | 部分：依赖证据标记的真实性 |
| 6 | Intent Breaking & Goal Manipulation（意图篡改） | 任务循环内每次路由/退回都带确定性反馈；路由结果必须是名册内成员，否则升级 | 部分 |
| 7 | Misaligned & Deceptive Behaviors（行为偏离） | 概率判断只做类型化选择题；质量门独立复核；虚假完成率作为事后指标持续监控 | 部分：判定不了"意图是否真诚" |
| 8 | Repudiation & Untraceability（抵赖与不可追溯） | 哈希链 + Ed25519 签名 + 离线验证包；每条决策含 actor/证据哈希/判断/结论/事后标签 | **完整**（这是核心卖点） |
| 9 | Identity Spoofing & Impersonation（身份冒用） | actor 体系 + 授权授予表；钩子路径上 agent 无法伪造他人身份执行高危动作 | 部分：需要与操作系统级身份配合 |
| 10 | Overwhelming Human in the Loop（人工过载） | 分级升级（routine/urgent/critical）；按题型阈值自动放行（从自身标注数据标定）；人工续命次数上限 | **完整** |

## EU AI Act（高风险 AI 系统相关义务）

| 义务 | Vigil 对应 |
|---|---|
| Art. 12 记录与日志（自动事件记录） | 哈希链账本：每条决策含时间、主体、依据、结论，签名防篡改 |
| Art. 14 人类监督（有效监督设计） | 五级授权 + require_human 升级 + 审批绑定 recordHash + 人工续命上限 |
| Art. 15 准确性、鲁棒性与一致性 | 校准闭环（Brier/ECE + 按题型阈值建议）；fail-closed 默认 |
| Art. 13 透明度与使用说明 | 决策可追溯率、虚假完成率等指标；postmortem 可读报告 |

## 明确不覆盖的

- **传输安全、沙箱隔离、操作系统权限**：这是部署层的事，Vigil 是决策层。
- **模型本身的可解释性**：我们解释决策过程（输入、政策、结论），不解释权重。
- **培训/文档义务、上市前审批流程**：超出工具范围。
