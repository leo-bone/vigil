# Vigil

> **English / 英文版：** [README.en.md](README.en.md)

**AI 决策账本与熔断内核，带完整的五岔路统筹循环。** 让每一个 agent 的决定都可拦截、可追溯、可校准、可签名验证，让每一次派工都走路由、质量门、止损、验收、升级。

> 你的 agent 会做事，但没人记得它为什么这么做、错了谁负责、下次该改哪条规则。
> Vigil 就是补上这一层的那块东西。

```
┌─ 统筹助理 Orchestrator ──────────────────────────────────┐
│                                                          │
│   ┌→ 止损 ──够差就停──→ STOPPED                          │
│   │   路由 ──选不出人──→ 升级人工 → ESCALATED            │
│   │   干活（每一轮执行都落账）                            │
│   │   质量门 ──不过──→ 带反馈回路由                       │
│   └───验收（四项清单缺一不可）──通过──→ COMPLETED        │
└────────────────── 每个岔路都是一次内核裁决 ───────────────┘
                              ↓
                  只追加账本（哈希链 + Ed25519 签名）
                    ↓
        事后梳理 → 校准 → 按题型自动调阈值 → 预警
        导出离线验证包（第三方零依赖验证）/ OTel span

agent 想动手  →  ┌──────────────┐  →  放行 / 转人工 / 否决
                  │    Vigil     │
                  │  硬规则否决   │  →  写入只追加账本（哈希链）
                  │  灰区概率判断 │  →  事后回填标签 → 校准阈值
                  └──────────────┘
```

## 为什么需要它

现在这一层是断的：

| 你在用什么 | 它回答的问题 | 它不回答的 |
|---|---|---|
| Langfuse / Phoenix / AgentOps | 发生了什么（trace、span、成本） | 这个决定当时有依据吗 |
| OPA / Guardrails / 各种 firewall | 能不能做（规则、黑名单） | 做错的那些，规则该怎么改 |
| LLM-as-judge | 这次输出好不好 | 它说 0.9 把握的时候，实际准不准 |

中间那块空着：**决定的责任归属**。Jev 这类系统一模型的流行恰好暴露了这个缺口 —— 它给了你 150 毫秒返回的概率，却没给你账本、没给你校准、没给你仲裁。概率一旦没有校准闭环，所有阈值都是拍脑袋。

## 它不是什么

- 不是 agent 编排框架。用 Claude Code、Grok Bot、Cursor 都行，Vigil 只在动手前插一脚。
- 不是模型。它调用判断模型，不训练模型。
- 不是日志系统。日志记录发生的事，账本记录做的决定 —— 两者字段都不一样。
- 0.1 版本，骨架通了，规则库还很薄。不要直接接生产支付。

## 核心设计

### 1. 决定是一等公民，不是一条日志

一条 `DecisionRecord` 至少包含：谁做的、依据什么证据、要求几级授权、实际持有几级、确定性命中了什么、概率判断给了多少、结论是什么、事后被证明对错。缺任何一项，事后就没法复盘。

### 2. 硬约束绝不用概率

这是和大多数项目最大的分歧。**不要让模型去判断逻辑。**

- 金额上限、不可逆操作、对外发送、密钥外泄、禁止目标 —— 全部走确定性规则。精确、可测、可证明，一票否决。
- 「这活该派给谁」「这份研究够不够」「这个承诺有没有风险」—— 才交给概率模型。
- 概率模型**永远没有否决权，也没有放行权**。它只能把一个本来会放行的动作变成"需要人看一眼"。

合起来就是：**逻辑守底线，概率做灰区。**

### 2.5 五岔路统筹循环（一比一对应 Jev 的判断点）

| 岔路 | 问题 | 确定性部分 | 概率部分 |
|---|---|---|---|
| 路由 | 下一个该谁干 | 选出的执行者必须在名册里，否则直接升级 | 在名册内做选择题 |
| 质量门 | 这份产出够不够 | 检查者结构上永远不是产出人 | 独立复核打分 |
| 止损 | 继续还是停 | 重试上限、连续失败次数，数数就够 | 进展评分（低于 2 停） |
| 验收 | 算不算完成 | 四项清单：交付物及位置、独立核验记录、遗留问题声明，**缺一项模型说了也不算** | 实质满足度判断 |
| 升级 | 要不要人接手 | 涉及金额直接 critical | 风险分级（routine/urgent/critical） |

「监督过程」不是独立模块：循环里每个岔路、每轮执行都是一次被哈希链记录的裁决，`postmortem(sessionId)` 能完整回放每一步为什么这么走。

### 2.6 冲突仲裁：多 agent 结论相反时由谁定夺

| 情况 | 谁说了算 | 依据 |
|---|---|---|
| 立场一致 | 直接采纳 | 无争议 |
| 同一个 agent 的多个立场 | 取最严格的那个 | 它自己改主意不算数，取最保守的 |
| 动作本身触红线 | **否决** | 全票同意也不行 |
| 有否决立场，它有独立核验证据而对方没有 | 采信否决 | 证据优势 |
| 有否决立场，它授权等级严格更高 | 采信否决 | 权级 |
| 有否决立场，但分不出高下 | **交人工** | 证据和权级都定不了 |
| 只剩"可以继续"与"需要人看"打架 | 模型排序 | 唯一动用模型的地方 |

**一条没被驳倒的否决立场，永远不会被自动放行。** 模型没有权力把 `deny` 变成 `allow` —— 它只能帮你在"都同意放行"和"需要人看"之间排序。这是 fail-closed 在多 agent 场景的延伸。

仲裁记录和普通决策记录在账本里无法区分 —— 这正是要的：仲裁也是一次决定，同样要能被追溯和复盘。

### 3. 概率判断只能是选择题

Vigil 只向判断模型发送类型化问题（boolean / choice / score），永远不索取自由文本。它返回概率分布，不返回句子。这在结构上就堵死了"模型自由发挥越权"这条路。

### 4. fail-closed

判断服务超时、返回格式不对、返回缺字段 —— 一律判为无效并升级人工，绝不当作默认放行。`failOpen` 开关存在，但默认关闭。

### 5. 五级授权（相对原方案改了一处）

| 级别 | 含义 | 典型动作 |
|---|---|---|
| L0 | read_only | 查询、检索 |
| L1 | draft | 起草、提议 |
| L2 | reversible_write | 可撤销的写入 |
| L3 | external_or_irreversible | 对外发送、不可逆修改 |
| L4 | money | 任何涉及钱的 |

原方案把"金钱"和"不可逆"放在同一级。我们把它们拆开了：内网删库和对外发信都收不回来，破坏半径相近，可以合并；但钱出去了没有任何技术手段能挽回，必须独占一级。

## 快速开始

要求 Node ≥ 22.18（原生支持 TypeScript，无需构建）。

```bash
git clone <this-repo> && cd vigil
node examples/demo.ts        # 单线场景：裁决、复盘、校准、预警
node examples/company.ts     # 一家 AI 公司：统筹助理带四名工人跑三个任务，
                             # 覆盖退回重做、自产自验被识破、虚假完成止损
node examples/resumable.ts   # 可续跑统筹循环：外部 agent 扮演工人，跨调用跑完
node examples/arbiter.ts     # 冲突仲裁：四个案例走完仲裁阶梯的每一级
npm test                     # 108 个测试
```

`demo` 会打印：每一步的裁决与理由、事后梳理、置信度校准、预警。

真实使用时给上判断模型的 key：

```bash
export TYPESAFE_API_KEY=tsf_xxx
```

没有 key 会退回确定性的 `MockJudge` —— 同样的输入永远同样的结论，适合写测试和复现事故。

## 接入方式

### 先扫一遍 —— `vigil scan`

治理配置不该靠人肉读文档写出来。一条命令先看清"你的 agent 到底能干什么"：

```bash
vigil scan                # 扫当前目录
vigil scan /path/to/app   # 扫别的项目
vigil scan --write        # 把建议策略写进 vigil.config.json，立即生效
```

它做三件事：

**1. 盘能力。** 读 `.mcp.json`、`~/.claude.json`、`.cursor/mcp.json`、`.claude/settings.json`、
`package.json` 的 scripts、根目录的 shell 脚本，给每一项推断授权等级：

| 等级 | 含义 | 例子 |
|---|---|---|
| L0 | 只读 | `github_search_issues` |
| L1 | 草稿 | 生成提案、写初稿 |
| L2 | 可逆写入 | `filesystem`、本地构建脚本 |
| L3 | 对外或不可逆 | `slack_send_message`、`git push`、`rm -rf` |
| L4 | 资金 | `stripe`、支付类脚本 |

名字看不出来的（`internal-crm`）按 L3 保守处理并标 `?`，等你确认一次，不猜。

**2. 报风险。** 只报真正要动手的事：资金能力在工作目录里、
凭据文件（`.env`）和文件访问能力同时存在、某个 server 的根目录被设成了整个 `~`、
钩子根本没挂、账本里有 N 条升级没人批。

**3. 用历史校准。** 如果账本里已有记录，它会告诉你哪类动作被否过多少次、
高危动作是不是集中在了一个 actor 身上。这些是真实的规则验证样本。

`--write` 生成的 `vigil.config.json` 会被内核在启动时读取并立即生效
（`VIGIL_CONFIG` 可改路径）。配置文件只能**收紧**内置默认策略，删掉它就回到保守默认值。

### 规则包 —— 事故形态可以搬运

护城河不在代码，在规则库。所以规则库必须能被抄走、被搬运、被非工程师维护。

规则包是**声明式 JSON，不是代码** —— 装进流程的东西不会执行任何代码，
即使来源不可信，它最多让一条规则永远命中：

```bash
vigil rules list                              # 有哪些包
vigil rules show healthcare.patient-data      # 看细节
vigil rules check ./my-pack.json              # 校验，不安装
vigil rules install healthcare.patient-data   # 安装，下次启动生效
```

内置四个行业包：医疗患者数据、付款审批、多租户隔离、代码发布。
完整格式见 [`docs/rule-packs.md`](docs/rule-packs.md)。

**可分发，也因此可被攻击。** 包一旦能从别人那儿下载进来，
"别人写的东西"就能进你的决策链路。四道防线：

| 防线 | 做什么 |
|---|---|
| **指纹** | 索引记内容的 sha256，装之前必须对上 |
| **签名** | 有签名的包要验签；没签名的会明确警告"没人给它背书" |
| **信任锚在本地** | 索引自带的公钥**不算数** —— 能改索引就能换掉公钥和签名一起伪造。公钥必须由你显式信任（`vigil trust add`） |
| **只能收紧不能放松** | 包的策略补丁只能压低金额上限、加长禁止清单、**降低**授权。装一个恶意包放宽不了你的任何一项防护 |

```bash
vigil rules publish my-pack.json --sign   # 登记进索引并签名
vigil rules search 医疗                     # 检索
vigil rules install healthcare.patient-data # 从索引装（先过指纹与签名）
vigil trust add signer.pem 某医院           # 信任签名者的公钥
```

| 特性 | 为什么这么定 |
|---|---|
| 不用正则，只用子串和 `*` 通配 | 规则包可能来自外部，正则的 ReDoS 能卡死你的进程 |
| 规则的 `detail` 强制写清"为什么拦" | 复盘时要看得懂，规则过时时要知道改哪条 |
| `deny` 和 `escalate` 分开 | 否决是确定的；升级要占一个人，只有需要人判断时才用 |
| 包的 `policy` 只收紧、不放松 | 授权是 `grants` 的事，规则包最多收紧它 |

### 钩子 —— 让约定变成强制（推荐）

提示词里写"发邮件前请确认"，模型抽风时就失效了。所以判断点必须放在**执行边界**上：

Vigil 接住 6 类生命周期点，不只是动手前：

| 事件 | 做什么 |
|---|---|
| `PreToolUse` | 裁决 —— 唯一能真正阻止动作的时机 |
| `PostToolUse` | 记录执行结果；**扫描工具输出里的凭据**（凭据顺着响应流出去，只有事后看得见） |
| `PostToolUseFailure` | 失败也落账 |
| `SessionStart` | 落账，并把本次会话的监督状态注入 agent 上下文 |
| `Stop` / `SessionEnd` / `PreCompact` | 给会话封口：累计决策数与花费 |

**紧急制动** —— 一条命令，让后面所有动作立刻全部转人工，直到你手动解除：

```bash
vigil kill --reason "agent 在批量改生产配置"   # 拉闸
vigil unkill                                    # 解闸
```

不做成"直接拒绝"，是因为拒绝了连"停下来看看发生了什么"都做不到。
解除动作本身留痕（`.vigil/killed.released`），事后能查是谁解的。

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash|Write|Edit|MultiEdit|WebFetch|mcp__.*",
        "hooks": [{ "type": "command", "command": "node /绝对路径/vigil/src/cli.ts hook claude", "timeout": 10 }]
      }
    ]
  }
}
```

放进 `~/.claude/settings.json` 即生效。三种结论映射：`allow` → 直接执行，`require_human` → 弹给用户确认，`deny` → 硬拦。

钩子自身出故障（分类失败、超时 4 秒、载荷损坏）永远退出码 0 且不阻断 agent —— 那是我们的 bug，不该由用户承担。

**上线顺序别跳**：先 `VIGIL_SHADOW=1` 跑一周，只看账本不拦截，确认误杀率可接受再开拦截。没跑过影子模式就开拦截，第二天钩子就会被关掉。

完整说明见 [`docs/hooks.md`](docs/hooks.md)，配置模板见 [`examples/claude-settings.json`](examples/claude-settings.json)。

### 命令包装器 —— 任何客户端都能用

```bash
vigil run -- rm -rf build      # 退出码 3，未执行
vigil run -- npm test          # 退出码 0，正常执行
```

| 退出码 | 含义 |
|---|---|
| 0 | 放行并执行 |
| 2 | 被否决 |
| 3 | 需人工确认，未执行 |

### CLI

```bash
vigil kill [--reason "原因"]      紧急制动：此后所有动作一律转人工
vigil unkill                       解除紧急制动
vigil status                       当前账本与制动状态一览
vigil rules list|show|check|install|search|publish|verify   规则包：查看、校验、安装、检索、登记
vigil trust list|add|remove       信任的签名公钥（规则包验签用）
vigil ledger-migrate <源> <目标.db>   把 NDJSON 账本迁到 SQLite（并发用）
vigil scan [目录] --write      # 扫描 agent 能力并生成治理配置（--write 立即生效）
vigil arbitrate <文件.json|->  多 agent 结论冲突时定夺
vigil decide request.json     # 或从 stdin 读：vigil decide -
vigil ledger                  # 列出所有决策
vigil verify                  # 校验哈希链 + Ed25519 签名
vigil keygen                  # 生成签名身份，之后的记录全部签名
vigil bundle                  # 导出离线验证包（第三方零依赖验证，见 verify-standalone.mjs）
vigil thresholds --write      # 从你回填的标签按题型算推荐阈值，写回配置立即生效
vigil approvals               # 列出待人工审批的升级项
vigil approve <id> approved "同意" --by human/boss   # 审批落账，绑定记录哈希
vigil export-otel spans.jsonl # 导出 OTel GenAI span，直接喂 Langfuse/Phoenix
vigil postmortem <sessionId>  # 事后梳理
vigil calibrate proceed       # 置信度校准 + 阈值扫描
vigil alerts                  # 扫描预警
vigil label <decisionId> wrong "客户否认需求"   # 回填结果
```

判断模型三选一，按优先级：

| 环境变量 | 后端 | 适用 |
|---|---|---|
| `VIGIL_LOCAL_JUDGE` | 本地决策服务（strands-decider / laya，/v1/systemone 方言） | 零成本、数据不出门、可用自有数据微调 |
| `TYPESAFE_API_KEY` | TypeSafe Jev 云端 | 不想本地跑模型 |
| 都不设 | MockJudge（确定性） | 测试、复现事故 |

### MCP（推荐）

```bash
vigil mcp
```

给 Claude Code：

```bash
claude mcp add vigil -- node /abs/path/to/vigil/src/cli.ts mcp
```

暴露 10 个工具。每个工具都带 `annotations`，含协议标准的
`readOnlyHint` / `destructiveHint`，以及我们自有的 `vigilAuthority`
（这个工具需要几级授权）与 `vigilEffect`（它会改什么）——
MCP 协议本身只有两个布尔位，表达不了五级授权。

**单点决策**（6 个）：`vigil_decide`、`vigil_postmortem`、`vigil_verify`、`vigil_alerts`、`vigil_calibrate`、`vigil_label`。

**统筹循环**（3 个）：`vigil_task_start`、`vigil_task_submit`、`vigil_task_status`。

**冲突仲裁**（1 个）：`vigil_arbitrate`。

约定：**agent 在动手之前必须调用 `vigil_decide`，拿到 `allow` 才执行。** 这不是靠自觉，是靠 hook —— 在 `PreToolUse` 里拦。

#### 统筹循环：让外部 agent 扮演工人

原本统筹循环只能在同一个进程里跑完，外部 agent 接不上 —— 它没法中途接管工人角色。
现在它是一个**可跨调用续跑的状态机**，干活的可以是另一个进程：

```jsonc
// 1. 开任务：Vigil 决定下一个该谁干
{"name": "vigil_task_start", "arguments": {
  "task": "给客户 ACME 写一封报价邮件",
  "roster": [{"id": "bot/writer", "role": "写手"}, {"id": "bot/checker", "role": "复核"}],
  "taskId": "t1"
}}
// → {"turn": {"kind": "work", "workerId": "bot/writer", "attempt": 1,
//              "instructions": "...", "requirements": [...]}}

// 2. 外部 agent 按指令干活，然后交回
{"name": "vigil_task_submit", "arguments": {
  "taskId": "t1",
  "summary": "写好草稿",
  "claim": "报价邮件已完成",
  "deliverableUri": "drafts/quote-acme.md",
  "leftoverIssues": "",
  "evidence": [{"id": "ev_check", "producedBy": "bot/checker", "verified": true}]
}}
// → 缺项则 {"turn": {"kind": "work", "attempt": 2, "feedback": "验收未过，缺：..."}}
//   齐全则 {"turn": {"kind": "completed"}}
```

`requirements` 会把验收的四项清单直接告诉执行者，不让它猜。
`feedback` 会把上轮被拒的具体原因带到下一轮，不用瞎改。

**一个要知道的局限**：如果同一个 agent 既扮演执行者又扮演复核者，
"独立核验"就退化成形式独立 —— 账本会如实记下谁产出了证据、谁声称完成，
但真正的独立性需要两个进程。这一点我们没有假装解决。

### SDK

#### 只要裁决（单点决策）

```ts
import { Kernel, Ledger, JevJudge, defaultPolicy } from 'vigil-oversight';

const kernel = new Kernel({
  ledger: new Ledger('.vigil/ledger.ndjson'),
  judge: new JevJudge({ apiKey: process.env.TYPESAFE_API_KEY! }),
  policy: defaultPolicy({ moneyCapPerAction: 50 }),
});

const verdict = await kernel.decide({
  sessionId: 'sess_1',
  actor: 'bot/outbound',
  intent: '把报价单发给客户',
  action: { kind: 'send_email', target: 'ceo@acme.com', reversible: false, external: true },
  evidence: [
    { id: 'ev_pricing', producedBy: 'bot/researcher', claim: '对方有 3 档定价', verified: true },
  ],
  questions: [
    { name: 'proceed', type: 'boolean', instructions: '这一步是否应当继续', floor: 0.8 },
    { name: 'risk', type: 'boolean', instructions: '是否构成商业承诺风险', escalateWhenTrue: true, floor: 0.75 },
  ],
});

if (verdict.outcome !== 'allow') throw new Error(`被拦截：${verdict.reason}`);
```

#### 要完整回路（统筹助理带工人跑任务）

```ts
import { createPipelineKernel, Orchestrator, JevJudge, Ledger } from 'vigil-oversight';

const kernel = createPipelineKernel(
  new Ledger('.vigil/ledger.ndjson'),
  new JevJudge({ apiKey: process.env.TYPESAFE_API_KEY! }),
);
const company = new Orchestrator(kernel, { maxAttempts: 3 });

const report = await company.runTask('sess_1', 'task_1', '写一份行业调研', [
  { id: 'bot/researcher', role: '研究员', run: async (ctx) => ({ /* 产出 */ }) },
  { id: 'bot/writer', role: '写手', run: async (ctx) => ({ /* 产出 */ }) },
]);
// report.status: completed | stopped | escalated
// report.steps: 每个岔路的走向，人能直接读懂
```

工人只管干活和交证据；路由、质量门、止损、验收、升级全部由 Orchestrator 驱动，每一步过内核、落账本。`ctx.feedback` 会告诉你上一轮为什么被打回。

## 四项指标

不看这四个数，这套系统就是在自娱自乐。

| 指标 | 定义 | 健康区间 |
|---|---|---|
| **决策可追溯率** | 被放行的动作里，能追到证据链的比例 | > 90% |
| **虚假完成率** | 被放行、事后被证伪的比例 | < 5% |
| **自主完成率** | 无需人工介入的比例 | 越低说明越保守，不是越低越好 |
| **单位任务成本** | 每个成功任务的累计花费 | 自己定基线，重点看突变 |

## 与相邻项目的关系

| 项目 | 定位 | 与 Vigil 的关系 |
|---|---|---|
| `jkudish/jev-mcp` | 12 个判断工具封装 | 可直接作为 Judge 后端 |
| Langfuse / Phoenix | trace 与评估 | Vigil 记录决定，它记录过程，互补 |
| OPA / Rego | 策略引擎 | 我们故意不用 Rego：0.1 阶段 YAML 化的谓词函数更快出活，等规则过百条再换 |
| Guardrails AI | 输出校验 | 管的是模型输出，Vigil 管的是动作 |

## 存储层

两种后端，**哈希链语义完全一致** —— 哈希只覆盖记录内容，与存储方式无关，
所以换后端不会让已有的验证包失效。

| 后端 | 什么时候用 | 特点 |
|---|---|---|
| **NDJSON**（默认） | 单进程、个人使用 | 零依赖、人可读、可以直接 `grep` |
| **SQLite** | 多个进程 / 多个 agent 同时写 | Node 22 内置 `node:sqlite`，同样零依赖 |

选哪个由路径决定：`.db` / `.sqlite` 结尾就用 SQLite。

```bash
export VIGIL_LEDGER=.vigil/ledger.db     # 切到 SQLite
vigil ledger-migrate .vigil/ledger.ndjson .vigil/ledger.db   # 迁移现有账本
```

SQLite 后端用 WAL 模式 + `BEGIN IMMEDIATE`：写锁排队而不是报错，
"读上一条 → 算哈希 → 写入"是一个原子操作，所以多个进程同时写也不会算错 `prevHash`。

实测：三个进程各写 40 条，共 120 条，哈希链完整，序号连续。

## 已知局限

诚实列出来，免得你踩：

1. **SQLite 后端还是实验特性**。Node 22 的 `node:sqlite` 尚未转正，接口可能变。
   我们屏蔽了它的警告提示（`VIGIL_SHOW_SQLITE_WARNING=1` 可以放出来），但这不改变它随时可能变的性质。
2. **NDJSON 后端不支持并发写**。要用多个进程同时写，请切到 SQLite。
3. **规则库很薄**。默认规则只覆盖了最常见的事故形态。真正的护城河是规则库随事故积累变厚，不是代码。
4. **校准需要标签**。没有事后回填，`calibrate` 和 `thresholds` 就是个空壳。这是运营问题，不是技术问题。
5. **判定不了"意图是否真诚"**。agent 说它要发邮件，实际可能干别的。Vigil 看的是动作形状，不是自述。要防这个得在工具边界强制执行，不在这一层。
6. **阈值的"按题型建议"只覆盖放行方向**。风险型问题（escalateWhenTrue）的自动标定还没做，因为放行/拦截语义相反，需要更大样本才可靠。

## 合规对照

采购或审计场景看 [`docs/compliance-mapping.md`](docs/compliance-mapping.md)：OWASP Agentic Top 10 逐条对照（4 项完整覆盖、5 项部分覆盖），EU AI Act 相关义务映射。

## 路线图

- [x] 决策内核（硬规则 + 概率灰区 + fail-closed）
- [x] 哈希链账本与校验
- [x] 事后梳理 / 校准 / 预警
- [x] MCP stdio 服务端（零依赖）
- [x] Claude Code PreToolUse 钩子 + 通用命令包装器
- [x] 五岔路统筹循环（路由 / 质量门 / 止损 / 验收 / 升级）
- [x] Ed25519 账本签名 + 离线验证包（verify-standalone.mjs）
- [x] 本地决策模型接入（strands-decider / laya / kev，/v1/systemone 方言）
- [x] 按题型阈值自动建议与生效（校准闭环最后一公里）
- [x] 审批事件绑定记录哈希 + 升级回调（人工可续命）
- [x] OTel GenAI span 导出（进 Langfuse/Phoenix 生态）
- [x] `vigil scan` 上手工具：扫描能力清单与风险，一键生成生效的治理配置
- [x] 统筹循环接入 MCP（可续跑状态机，外部 agent 扮演工人）
- [x] 冲突仲裁 `Arbiter`：证据与权级定夺，未被驳倒的否决立场绝不放行
- [x] 规则包（声明式 JSON，4 个内置行业包，可安装可校验）
- [x] 存储层换 SQLite（node:sqlite 内置，多进程并发写，哈希链语义不变）
- [x] GitHub 顶级 AI 项目 Top 50 调研（[报告](docs/ai-landscape-2026-10.md)）＋ MCP 协议合规与工具授权标注
- [x] 竞品对标 ECC 实跑（[报告](docs/competitor-benchmark.md)）：多事件钩子、输出侧凭据检测、告警级规则、紧急制动
- [x] 规则包索引与分发：指纹 + 签名 + 本地信任锚 + 只能收紧不放松
- [x] `vigil init` 一键接入 + `vigil doctor` 体检（对标 ECC 的 doctor/repair）

## License

MIT
