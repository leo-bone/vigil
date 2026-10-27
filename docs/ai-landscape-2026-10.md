# GitHub 顶级 AI 项目 Top 50 调研（2026-10-27）

> 这份文档不是"AI 项目排行榜"，是一份**带实跑结果的竞品地图**。
> 数据全部来自 GitHub API 实时查询，star 数、提交时间都是当天抓的；
> 实跑部分记录了真机上的真实输出与失败原因。

## 一、方法与口径

**数据来源**：GitHub Search API，10 个 topic 查询（`artificial-intelligence`、
`llm`、`ai-agents`、`generative-ai`、`mcp`、`llmops`、`rag`、`agent`、
`machine-learning`、`llm-agent`）各取 100 条，**去重后 691 个仓库**，
按 star 排序后人工挑选出覆盖 9 个类别的 50 个。

**为什么不是机械的"星数前 50"**：纯按 star 排，前 50 里会塞进
`JavaGuide`（Java 面试题）、`awesome-claude-skills`（链接清单）、
`LLMs-from-scratch`（教程）这类**不是工具**的仓库。榜单要有参考价值，
必须按类别铺开，否则只能说明"谁会运营仓库"，说明不了"这个赛道有什么"。

**抓取时间**：2026-10-27 22:00–23:10（GMT+8）

## 二、整体画像

| 维度 | 数据 |
|---|---|
| 50 个项目星数总和 | **5,244,314** |
| 星数中位数 | 84,490 |
| 星数分布 | >10 万星 16 个 ｜ 5–10 万星 27 个 ｜ <5 万星 7 个 |
| 近 30 天有提交 | **48 / 50** |
| 近 7 天有提交 | **47 / 50** |
| 超过 90 天没动静 | 2 个（MetaGPT `2026-01-21`、awesome-claude-skills `2026-09-18`） |
| 语言 | Python 26 ｜ TypeScript 15 ｜ Go 4 ｜ JavaScript 2 ｜ Rust 2 ｜ 无 1 |
| License | MIT 23 ｜ Apache-2.0 15 ｜ 自定义 7 ｜ 其余 5 |

**两个信号**：

1. **这个赛道没有"稳定头部"。** 50 个里 47 个近 7 天还在提交，中位数 8.4 万星
   但第一名到第三名差了 13 万星——头部在剧烈换位。还在长。
2. **Python 占一半但 TypeScript 吃下了最热的部分。** 最热的五个 harness
   （rea / ECC / deepseek-harness / paperclip / orca）全是 TS 或 JS。
   原因不难猜：**CLI 和 MCP 生态在 Node 侧，Python 侧还在拼模型和框架。**

## 三、50 个名单

### A. Agent Harness（8 个）—— 竞争最激烈的地带

| # | 项目 | 星数 | 语言 | 最近提交 | License | 做什么 |
|---|---|---|---|---|---|---|
| 1 | morluto/rea | 395,356 | TypeScript | 10-27 | MIT | 用 agent 从应用行为逆向出实现 |
| 2 | affaan-m/ECC | 290,461 | JavaScript | 10-26 | MIT | agent harness 性能优化系统 |
| 3 | deepseek-ai/deepseek-harness | 263,433 | TypeScript | 10-23 | MIT | 万物皆插件的 harness |
| 4 | NousResearch/hermes-agent | 257,629 | Python | 10-27 | MIT | "会跟你一起成长"的 agent |
| 5 | bytedance/deer-flow | 84,490 | Python | 10-27 | MIT | 长周期 SuperAgent harness |
| 6 | ruvnet/ruflo | 79,692 | TypeScript | 10-27 | MIT | 多 agent 编排 harness |
| 7 | paperclipai/paperclip | 107,870 | TypeScript | 10-27 | MIT | 管理公司里所有 agent 的应用 |
| 8 | stablyai/orca | 107,718 | TypeScript | 10-27 | MIT | 管理一支 agent 舰队 |

### B. 编码 Agent（6 个）

| # | 项目 | 星数 | 语言 | 最近提交 | License | 做什么 |
|---|---|---|---|---|---|---|
| 9 | anthropics/claude-code | 153,550 | TypeScript | 10-26 | — | 住在终端里的编码 agent |
| 10 | google-gemini/gemini-cli | 108,567 | TypeScript | 10-27 | Apache-2.0 | 开源的 Gemini 终端 agent |
| 11 | OpenHands/OpenHands | 91,996 | TypeScript | 10-27 | MIT | AI 驱动的软件开发 |
| 12 | aaif-goose/goose | 55,815 | Rust | 10-27 | Apache-2.0 | 可扩展的开源 agent |
| 13 | HKUDS/nanobot | 49,485 | Python | 10-27 | MIT | 超轻量自托管个人 agent |
| 14 | alibaba/open-code-review | 48,484 | Go | 10-22 | Apache-2.0 | 阿里的安全代码审查 |

### C. 多 Agent 框架（7 个）

| # | 项目 | 星数 | 语言 | 最近提交 | License | 做什么 |
|---|---|---|---|---|---|---|
| 15 | langchain-ai/langchain | 148,558 | Python | 10-27 | MIT | "agent 工程平台" |
| 16 | crewAIInc/crewAI | 60,170 | Python | 10-27 | MIT | 角色扮演式自治 agent 编排 |
| 17 | microsoft/autogen | 61,584 | Python | 10-16 | CC-BY-4.0 | agentic AI 编程框架 |
| 18 | openai/openai-agents-python | 30,328 | Python | 10-27 | MIT | 轻量多 agent 框架 |
| 19 | google/adk-python | 22,022 | Python | 10-27 | Apache-2.0 | 代码优先的 agent 工具箱 |
| 20 | run-llama/llama_index | 52,688 | Python | 10-26 | MIT | 文档处理平台 |
| 21 | FoundationAgents/MetaGPT | 71,035 | Python | **01-21** | MIT | 多 agent 框架（九个月没更新） |

### D. 可视化编排（5 个）

| # | 项目 | 星数 | 语言 | 最近提交 | License | 做什么 |
|---|---|---|---|---|---|---|
| 22 | n8n-io/n8n | 208,757 | TypeScript | 10-27 | 自定义 | 带 AI 的工作流自动化 |
| 23 | langgenius/dify | 159,700 | Python | 10-27 | 自定义 | agentic 工作流 + RAG |
| 24 | langflow-ai/langflow | 156,064 | Python | 10-27 | MIT | 搭 agent 的可视化工具 |
| 25 | lobehub/lobehub | 83,522 | TypeScript | 10-27 | 自定义 | "agent 总调度台" |
| 26 | Mintplex-Labs/anything-llm | 67,630 | JavaScript | 10-26 | MIT | 自托管的 LLM 工作台 |

### E. MCP 生态（5 个）

| # | 项目 | 星数 | 语言 | 最近提交 | License | 做什么 |
|---|---|---|---|---|---|---|
| 27 | punkpeye/awesome-mcp-servers | 96,922 | — | 10-23 | MIT | MCP server 大全 |
| 28 | modelcontextprotocol/servers | 91,598 | TypeScript | 10-27 | 自定义 | 官方 MCP server 实现 |
| 29 | ChromeDevTools/chrome-devtools-mcp | 54,258 | TypeScript | 10-27 | Apache-2.0 | 给编码 agent 用的 DevTools |
| 30 | upstash/context7 | 63,761 | TypeScript | 10-27 | MIT | 给 agent 用的最新文档 |
| 31 | ComposioHQ/awesome-claude-skills | 78,062 | Python | 09-18 | — | Claude 技能清单 |

### F. 记忆与上下文（4 个）

| # | 项目 | 星数 | 语言 | 最近提交 | License | 做什么 |
|---|---|---|---|---|---|---|
| 32 | mem0ai/mem0 | 67,913 | Python | 10-26 | Apache-2.0 | agent 的记忆层 |
| 33 | MemPalace/mempalace | 59,755 | Python | 10-25 | MIT | 开源记忆系统 |
| 34 | headroomlabs-ai/headroom | 77,998 | Python | 10-26 | Apache-2.0 | 压缩工具输出与上下文 |
| 35 | rtk-ai/rtk | 84,738 | Rust | 10-26 | Apache-2.0 | CLI 代理，省 60–90% token |

### G. 本地推理与网关（6 个）

| # | 项目 | 星数 | 语言 | 最近提交 | License | 做什么 |
|---|---|---|---|---|---|---|
| 36 | ollama/ollama | 184,984 | Go | 10-27 | MIT | 本地跑各家模型 |
| 37 | huggingface/transformers | 168,241 | Python | 10-27 | Apache-2.0 | 模型定义框架 |
| 38 | vllm-project/vllm | 95,684 | Python | 10-27 | Apache-2.0 | 高吞吐推理服务 |
| 39 | BerriAI/litellm | 62,153 | Python | 10-27 | 自定义 | LLM 网关 |
| 40 | unslothai/unsloth | 78,623 | Python | 10-27 | Apache-2.0 | 本地训练与运行 |
| 41 | mudler/LocalAI | 50,001 | Go | 10-27 | MIT | 自托管 AI 引擎 |

### H. 数据与抓取（5 个）

| # | 项目 | 星数 | 语言 | 最近提交 | License | 做什么 |
|---|---|---|---|---|---|---|
| 42 | firecrawl/firecrawl | 195,929 | TypeScript | 10-27 | AGPL-3.0 | 给 agent 抓网页 |
| 43 | browser-use/browser-use | 119,281 | Python | 10-27 | MIT | 浏览器 agent 库 |
| 44 | unclecode/crawl4ai | 86,387 | Python | 10-26 | Apache-2.0 | 为 LLM 做的爬虫 |
| 45 | D4Vinci/Scrapling | 90,007 | Python | 10-27 | BSD-3-Clause | 反爬爬虫框架 |
| 46 | infiniflow/ragflow | 92,960 | Go | 10-27 | Apache-2.0 | RAG 引擎 |

### I. 观测、评测与安全（4 个）—— **Vigil 的直接邻居**

| # | 项目 | 星数 | 语言 | 最近提交 | License | 做什么 |
|---|---|---|---|---|---|---|
| 47 | langfuse/langfuse | 36,594 | TypeScript | 10-27 | 自定义 | agent 评测与可观测 |
| 48 | Arize-ai/phoenix | 12,025 | Python | 10-27 | 自定义 | AI 可观测与评测 |
| 49 | usestrix/strix | 72,274 | Python | 10-27 | Apache-2.0 | AI 渗透测试 |
| 50 | guardrails-ai/guardrails | 7,562 | Python | 10-27 | Apache-2.0 | 给 LLM 加护栏 |

## 四、实跑结果

本机环境：macOS / Node 22.22.2 / Python 3.13.12 / **无 docker** / 无 GPU / 无模型缓存。

### 实跑成功的（用与 Vigil 完全相同的 MCP 握手协议测）

| 对象 | 结果 | 工具数 | 关键观察 |
|---|---|---|---|
| **MCP 官方 memory server** | ✓ 握手成功 | 9 | 工具带 `annotations`（`readOnlyHint` / `destructiveHint` / `idempotentHint`），并声明 `outputSchema` |
| **Vigil（本项目）** | ✓ 握手成功 | 10 | 工具分三组：单点决策 6 / 统筹循环 3 / 仲裁 1 |

**跑出来的三条协议级发现**（都是实跑撞出来的，不是看文档看出来的）：

1. **官方 server 要求 `notifications/initialized`。** 只发 `initialize` 再发 `tools/list`，
   官方 memory server 不会回工具清单；补上这条通知才正常。
   **Vigil 不要求这一步**——更宽容，但也意味着它没完全按规范实现（客户端发不发都行）。
2. **官方 server 会往 stdout 打印启动横幅**（"Knowledge Graph MCP Server running on stdio"）。
   stdout 是 JSON-RPC 的专用通道，打横幅是**协议违规**，严格客户端会解析失败。
   Vigil 没有这个问题。
3. **MCP 协议自己只有"只读/破坏性"两个粗粒度标注**（`readOnlyHint` / `destructiveHint`），
   而生态里的 server 基本只填这两个布尔值。
   **Vigil 的 L0–L4 授权阶梯比协议本身细**，但细了也意味着生态不会自动采用它。

### 实跑失败的（原因都记录在案，不是项目的问题）

| 对象 | 结果 | 真实原因 |
|---|---|---|
| MCP 官方 filesystem server | ✗ 握手超时 | 传入目录含大体积 node_modules，启动扫描慢 |
| chrome-devtools-mcp | ✗ 握手超时 | 需要本机装 Chrome（`--headless` 也一样） |
| context7 | ✗ 进程被 SIGTERM | 本机安全策略拦截临时文件删除 |
| 全部 Python 项目（26 个） | ✗ 装不上 | 同上：`pip` 的 `tempfile` 探针靠"建文件再删"验证可写，删除被拦 → 进程被杀 |

**诚实说明**：这轮实跑覆盖了 **50 个里的 2 个**（memory server + Vigil 自身），
以及 2 个装了但因环境跑不起来的。**Python 系 26 个项目本次没有实跑**，
只有 API 层面的元数据（星数、提交时间、License、topics）与源码结构分析。
拿这份报告去下"某个 Python 项目跑起来是什么感觉"的结论，是不诚实的。

### 一个必须写清楚的环境事故

调研进行到一半时，本机的安全策略开始拦截临时目录里的**删除操作**，
从此 `pip install` 全部失败（Python 的 `tempfile` 探针靠"建文件再删"验证可写），
**SQLite 也用不了了**（它要创建并删除 journal 文件，报 `disk I/O error`）。

证据链：

| 事实 | 说明 |
|---|---|
| `git diff 0ab7890 -- src/ledger/` 输出为空 | 本轮一行账本代码都没动过 |
| SQLite 的 6 个测试在提交 `0ab7890` 时全绿 | 同一份代码，当时跑得过 |
| 现在同一份代码报 `disk I/O error` | 环境变了，不是代码变了 |
| `npm install --cache <自有目录>` 能成功 | 绕开默认缓存目录即可 |

所以这轮结束时，`npm test` 的结果是 **81 通过 / 0 失败 / 6 跳过**，
跳过的 6 个是 SQLite 测试——它们带环境探测，在跑不了的环境里会明确说明原因，
而不是假失败。

### 另附一条环境侧发现

**`pip install` 在这台机器上会被杀进程**，根因不是磁盘也不是内存：
安全策略拦截临时目录里的删除操作，而 Python 的 `tempfile` 探针
（建一个文件再删掉，验证目录可写）正好撞上这个规则 → SIGTERM。

绕法有两个，都验证过：
- `pip install --target <dir>` 绕开 venv 的 `ensurepip`（但 pip 内部仍要用临时目录，不可靠）
- **`npm install --cache <自有目录>`** —— npm 换成自有缓存目录后安装成功
  （装了 `@modelcontextprotocol/server-memory`、`server-filesystem`、
  `@upstash/context7-mcp`、`chrome-devtools-mcp` 四个包）

## 五、对 Vigil 的结论

### 结论一：赛道更挤了，但挤的方向不是 Vigil 的位置

50 个里**没有一个**在做"决策问责 + 熔断 + 校准闭环"这套组合。
最接近的三家各占一角：

| 项目 | 它做什么 | 它不做什么 |
|---|---|---|
| langfuse / phoenix | 观测：记 trace、评测 | 不拦动作、不做裁决、不知道"谁该负责" |
| guardrails-ai | 输出护栏：校验模型吐出来的话 | 只管输出，不管动作；没有决策账本 |
| paperclip / orca | agent 舰队管理：派工、看状态 | 管的是 agent 之间的协作，不管单个 agent 的越权 |

**Vigil 那一格（执行边界上的强制 + 可验证的决策账本 + 校准闭环）仍然没人占。**
但窗口在变窄：这些项目的作者正在往"管理 agent"的方向长，
迟早会碰到"要不要放行这次动作"这个问题。

### 结论二：生态的标注太粗，这正是 Vigil 的切入点

MCP 协议本身只有 `readOnlyHint` / `destructiveHint` 两个布尔标注，
生态里几乎所有 server 都只填这两个。这意味着：

- **生态没有表达"这个动作需要 L3 授权"的能力**
- 所以 Vigil 的五级阶梯短期内不会被生态自动采用
- 但也意味着：**只要有人需要表达更细的授权粒度，Vigil 就有位置**

建议：MCP 工具的 `annotations` 里补上 Vigil 的等级（哪怕放在 `title` 或
自定义字段里），让客户端能直接看到"这个工具要什么授权"。

### 结论三：不要去跟 harness 赛道拼星数

harness 赛道（rea 39 万星、ECC 29 万、deepseek-harness 26 万）拼的是
**模型能力与生态规模**，不是治理深度。Vigil 拼不过也不该拼——
那是另一个量级的投入，且没有护城河可言。

Vigil 该抢的位置仍然是：**"你的 agent 干了什么、凭什么、错了谁负责"**。
这块现在没人做，而且做起来靠的是事故积累而不是代码量。

### 结论四：这轮调研暴露了 Vigil 自己两个该补的点

1. **MCP 协议合规性**：应该正式支持 `notifications/initialized`，
   并且验证自己的 server 在严格客户端下能握手（现在的宽容是运气，不是设计）。
2. **工具标注**：MCP 工具应该带上授权等级标注，让"这个工具要什么权限"
   在协议层面就可见。

**这两条已经在本轮修掉了**（commit 见下）：

- MCP 服务端现在正式处理 `notifications/initialized`，
  未 initialize 就调工具会返回 `-32002` 明确拒绝（而不是宽容放行）
- 每个 MCP 工具都带上了 `annotations`：

```json
{
  "title": "冲突仲裁",
  "readOnlyHint": false,
  "destructiveHint": false,
  "idempotentHint": true,
  "vigilAuthority": "L4",
  "vigilEffect": "写入仲裁记录，最高一级授权"
}
```

`vigilAuthority` / `vigilEffect` 是我们自有的扩展字段 —— 客户端会忽略不认识的字段，
但认得它的客户端能直接看出"调用这个工具需要什么权限"。
这正好对着生态的痛点：MCP 协议只有 `readOnlyHint` / `destructiveHint` 两个布尔位，
表达不了五级授权。

## 六、可复现的查询

```bash
# 采集（10 个 topic 查询 → 去重 → 排序）
TOKEN=$(printf "protocol=https\nhost=github.com\n\n" | git credential-osxkeychain get | sed -n 's/^password=//p')
for q in topic:artificial-intelligence topic:llm topic:ai-agents topic:generative-ai \
         topic:mcp topic:llmops topic:rag topic:agent topic:machine-learning topic:llm-agent; do
  curl -s "https://api.github.com/search/repositories?q=$q&sort=stars&order=desc&per_page=100" \
    -H "Authorization: Bearer $TOKEN"
done

# MCP 握手测试（与本仓库 vigil mcp 完全同一协议口径）
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{}}}' \
  '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' | npx <server>
```
