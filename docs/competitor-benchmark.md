# 竞品对标：ECC 实跑与改进（2026-10-28）

> 这一轮不写"分析报告"，写**改了什么**。
> 对标对象是 `affaan-m/ECC`（29 万星，"agent harness 性能优化系统"）——
> Top 50 里少数能真正装进本机跑起来的专业 AI agent 项目。

## 一、ECC 是什么，跑起来什么感觉

**安装**：`npm install ecc-universal`（5 个依赖，3 分钟装完，运行时零 Python 依赖）

**CLI 面**（`ecc --help` 实测）：

```
setup            安装/更新 Claude 插件，含引导式范围与 hook 选择
install          安装 ECC 内容，含多 harness 引导向导
plan / catalog / consult / profile    安装清单、组件发现、自然语言推荐
control-pane     本地 ECC2 操作控制台
memory           在 Claude / Codex / Hermes 等 harness 间共享持久上下文
doctor / repair  诊断并修复漂移或缺失的 ECC 托管文件
status           查询 ECC SQLite 状态库摘要
platform-audit   审计 GitHub 队列、讨论、路线图、发布与安全证据
security-ioc-scan  扫描依赖与 AI 工具持久化面里的供应链 IOC
sessions         列出/检查 SQLite 状态库里的会话
work-items       追踪 Linear / GitHub / 交接 / 手工工作项
```

**它的 MCP server**（实测握手成功）：`ecc-memory-mcp` 暴露 4 个工具
——`memory_save`、`memory_search`、`memory_read`、`memory_doctor`。

**它的 hook 层**：56 个 hook 脚本，覆盖 7 类生命周期点。
**它的 rules/ 目录**：23 项，但全是**按编程语言分的编码规范**
（angular / cpp / golang / python / rust …）——那是"提示词知识层"，不是"执行边界层"。

## 二、三个关键对标发现

### 发现一：ECC 有治理事件日志，但它**只观测不执行**

`scripts/hooks/governance-capture.js`（373 行）做的事：

```js
// 写入 governance_events 表
{
  id, sessionId,
  eventType: 'secret_detected' | 'approval_requested' | …,
  payload: { toolName, hookPhase, secretTypes, location, severity },
  resolvedAt: null,
  resolution: null,
}
```

但同一个文件里写着：

```js
// Silently ignore parse errors — never block the tool pipeline.
```

**它捕获、分类、记录，severity 分得很细（critical/high/medium/warning），
但从不让任何事被拦住。** 真正会拦的只有两个专用脚本
（`block-no-verify.js` 790 行、`pre-bash-dev-server-block.js`）——
都是"拦某个具体坏模式"，不是通用的授权裁决。

**对比 Vigil**：Vigil 的核心恰恰是"确定性规则一票否决 + 概率模型只能降级"。
**这一格 ECC 没占，而且它自己的架构选择（never block）决定了它不会占。**

### 发现二：ECC 在**请求和输出两侧**都扫密钥，Vigil 只看请求侧

ECC 的 governance-capture 明确做了 `detectSecrets(inputText)` +
`detectSecrets(toolOutput)`。

Vigil 之前只有 `payload.secret` 规则，看的是**请求载荷**。
这意味着：**agent 读一个 .env、调一个返回 token 的接口，凭据顺着响应流出去，
Vigil 完全看不见。** 这是本轮修掉的第一个真实安全缺口。

### 发现三：ECC 的安全指南里有 Vigil 完全没有的两样东西

`the-security-guide.md` 的目录：

```
Attack Vectors / Surfaces
Claude Code CVEs (February 2026)
Sandboxing · Separate the identity first · Run untrusted work in isolation
Sanitization · Hidden Unicode and Comment Payloads
Approval Boundaries / Least Agency
Observability / Logging
Kill Switches          ← Vigil 之前没有
Memory
The Minimum Bar Checklist
```

**Kill Switches** 那个词让本轮补了第二个功能（见下）。

## 三、本轮改了什么

### 改进一：多事件钩子（PostToolUse / PostToolUseFailure / SessionStart / Stop / SessionEnd / PreCompact）

之前 Vigil 只有 `PreToolUse` 一个点 —— 只能拦"动手前"，
看不见"动完手之后发生了什么"。

| 生命周期点 | 现在做什么 |
|---|---|
| `PreToolUse` | 原有裁决逻辑（拦） |
| `PostToolUse` | 记录执行结果；**输出侧凭据检测**；命中则 `decision: block` 并把该记录标成待人工 |
| `PostToolUseFailure` | 失败也落账 —— 失败也是决策的一部分 |
| `SessionStart` | 落账，并把本次会话的监督状态注入 agent 上下文 |
| `Stop` / `SessionEnd` / `PreCompact` | 给会话封口：记录累计决策数与花费 |

配套改动：内核新增 `observe()` —— 观察事件不走模型、不比对授权，
只跑告警级规则；命中就记成 `require_human`，自动出现在 `vigil approvals` 清单里。

### 改进二：告警级规则（`severity: 'warn'`）

之前只有两档：`deny`（一票否决）和 `escalate`（转人工）。
现在有第三档 `warn`：**只记录、不阻断**。

它专门服务于"事后才知道"的风险 —— 动作已经发生，拦不住，
但必须留下痕迹等人处理。这正是 ECC 用 severity 表达、
而 Vigil 原来没有的东西。

### 改进三：输出侧凭据检测

新增 `src/policy/secrets.ts`：

- 11 类凭据形态：OpenAI / Anthropic / TypeSafe / GitHub / AWS / Google / Stripe / Slack / 私钥 / JWT / 赋值型密码
- **命中片段截断** —— 账本是长期留存的，把完整密钥写进去等于二次泄露
- **不误伤占位符** —— `api_key=xxxxxxxx`、`api_key=<your-key-here>`、`password: placeholder` 都不算

新增规则 `output.secret_exposure`（severity: `warn`）。

实测：
```
输入：{"hook_event_name":"PostToolUse","tool_response":"export OPENAI_KEY=sk-proj-AbCdEf0123456789XyZ"}
输出：{"decision":"block","reason":"[Vigil] 工具 Read 的输出中出现疑似凭据（openai_key）。动作已发生、拦不住，
       但必须有人处理：确认该凭据是否已经外流，必要时立刻轮换；不要把这段输出再转发给任何第三方。"}
账本：1 条 require_human → 自动进入 approvals 清单
```

### 改进四：紧急制动（Kill Switch）

对标 ECC 的 "Kill Switches"。

```bash
vigil kill --reason "agent 在批量改生产配置"   # 拉闸
vigil unkill                                    # 解闸
vigil status                                    # 一览
```

实测：
```
制动前：allow
制动后：require_human —— "紧急制动已启用（自 …）：agent 在批量改生产配置，所有动作转人工。解除用 vigil unkill"
解除后：allow
```

**为什么不做成"直接拒绝"**：拒绝了连"停下来看看发生了什么"都做不到。
转人工才是对的 —— 人被叫醒，agent 也停下来了。

解除动作本身留痕（`.vigil/killed.released`）：事后复盘时
"这个紧急制动是谁解除的"必须能查到。

### 改进五：钩子核心可测

`runClaudeHook` 拆出 `handleHookEvent(kernel, payload, options)`。
之前跑一次钩子测试要起一个子进程（这台机器上直接被内存压力杀掉），
现在事件分派是纯逻辑，直接调用即可 —— 测试更快也更精准。

## 四、对标结论表

| 维度 | ECC（29 万星） | Vigil | 说明 |
|---|---|---|---|
| 执行边界拦截 | ❌ 明确"never block" | ✅ 确定性规则一票否决 | **Vigil 的核心位置** |
| 通用授权裁决 | ❌ 只有专用脚本拦特定模式 | ✅ L0–L4 五级授权 | |
| 治理事件记录 | ✅ 完整（有 severity / resolution） | ✅ 哈希链账本（更强：可验证） | |
| 凭据检测 | ✅ 请求 + 输出两侧 | ✅ **本轮补上输出侧** | |
| 生命周期覆盖 | ✅ 7 类事件点 | ✅ **本轮从 1 类补到 6 类** | |
| 告警级（不阻断只记录） | ✅ severity 分级 | ✅ **本轮补上 warn 档** | |
| 紧急制动 | ✅ Kill Switches | ✅ **本轮补上** | |
| 规则形态 | 按语言的编码规范（知识层） | 声明式 JSON 规则包（可搬运） | |
| 事后复盘 | 状态库 + doctor/repair | 哈希链 + 校准 + 阈值建议 | |
| 可验证性 | SQLite 状态库（可改） | 哈希链 + Ed25519 签名（改了就断） | |

**一句话结论**：ECC 把"治理"做到了**观测与建议**的深度，
但它的架构选择（never block）让它停在"知道发生了什么"，
而不是"不让它发生"。Vigil 缺的恰恰是它有的那部分（覆盖面与细节），
这轮补齐了；Vigil 有的那部分（强制），ECC 短期内不会来抢。

## 五、诚实说明

- ECC 是本轮**唯一能完整装起来并跑起来的 Top 50 专业 agent 项目**。
  其余 Node 项目（ruflo、orca、paperclip、deepseek-harness）依赖数 26–27，
  在这台内存受限的机器上没装完；Python 系 26 个项目因 pip 被环境阻断，
  仍然只有源码级分析。
- ECC 的 `hooks.json` 里每个 hook 都重复一段超长的内联 root 解析代码
  （Claude Code 的 hooks.json 不支持共享代码），每次工具调用都要付这个成本。
  Vigil 的做法（一个入口 + 事件分派）在这个维度上更干净。
- 本轮改进基于实跑与源码阅读，**没有经过真实业务流量验证**。
  误杀率与漏报率仍需拿真实工作流跑一周才知道。
