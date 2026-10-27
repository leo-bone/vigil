# Vigil

**AI 决策账本与熔断内核。** 让每一个 agent 的决定都可拦截、可追溯、可校准。

> 你的 agent 会做事，但没人记得它为什么这么做、错了谁负责、下次该改哪条规则。
> Vigil 就是补上这一层的那块东西。

```
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
node examples/demo.ts      # 跑一遍十步场景，不需要任何 API key
npm test                   # 19 个测试
```

`demo` 会打印：每一步的裁决与理由、事后梳理、置信度校准、预警。

真实使用时给上判断模型的 key：

```bash
export TYPESAFE_API_KEY=tsf_xxx
```

没有 key 会退回确定性的 `MockJudge` —— 同样的输入永远同样的结论，适合写测试和复现事故。

## 接入方式

### 钩子 —— 让约定变成强制（推荐）

提示词里写"发邮件前请确认"，模型抽风时就失效了。所以判断点必须放在**执行边界**上：

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
vigil decide request.json     # 或从 stdin 读：vigil decide -
vigil ledger                  # 列出所有决策
vigil verify                  # 校验哈希链有没有断
vigil postmortem <sessionId>  # 事后梳理
vigil calibrate proceed       # 置信度校准 + 阈值扫描
vigil alerts                  # 扫描预警
vigil label <decisionId> wrong "客户否认需求"   # 回填结果
```

### MCP（推荐）

```bash
vigil mcp
```

给 Claude Code：

```bash
claude mcp add vigil -- node /abs/path/to/vigil/src/cli.ts mcp
```

暴露 6 个工具：`vigil_decide`、`vigil_postmortem`、`vigil_verify`、`vigil_alerts`、`vigil_calibrate`、`vigil_label`。

约定：**agent 在动手之前必须调用 `vigil_decide`，拿到 `allow` 才执行。** 这不是靠自觉，是靠 hook —— 在 `PreToolUse` 里拦。

### SDK

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

## 已知局限

诚实列出来，免得你踩：

1. **单进程写入**。账本是 NDJSON + 内存索引，并发写会出问题。要上多人用就得换 SQLite/libsql —— 哈希链语义不变，这是刻意留的替换点。
2. **规则库很薄**。8 条默认规则只覆盖了最常见的事故形态。真正的护城河是规则库随事故积累变厚，不是代码。
3. **校准需要标签**。没有事后回填，`calibrate` 就是个空壳。这是运营问题，不是技术问题。
4. **判定不了"意图是否真诚"**。agent 说它要发邮件，实际可能干别的。Vigil 看的是动作形状，不是自述。要防这个得在工具边界强制执行，不在这一层。

## 路线图

- [x] 决策内核（硬规则 + 概率灰区 + fail-closed）
- [x] 哈希链账本与校验
- [x] 事后梳理 / 校准 / 预警
- [x] MCP stdio 服务端（零依赖）
- [x] Claude Code PreToolUse 钩子 + 通用命令包装器
- [ ] 更多客户端的钩子适配（Cursor / Codex）
- [ ] 多 agent 冲突仲裁 `Arbiter`：两个 agent 结论相反时按规则表决
- [ ] 规则包市场：把每个行业的事故形态沉淀成可复用规则集
- [ ] 存储层换 libsql，支持并发

## License

MIT
