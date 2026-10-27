# 把约定变成强制

一句话：**没有强制点的规则，等于没有规则。**

很多 agent 系统的"安全规范"写在提示词里 —— "发邮件前请先确认收件人"。这种东西在模型正常时会遵守，在模型被注入、上下文被压缩、或者单纯抽风时就会失效。Vigil 的做法是把判断点放到**执行边界**上：工具调用的那一刻，不进人就出不去。

三种接法，强度递减。

---

## 方式一：Claude Code 的 PreToolUse 钩子（推荐）

Claude Code 在每次工具调用**之前**会执行你注册的命令，把这次调用的完整载荷从 stdin 递进来，并根据返回的 JSON 决定放行、拒绝，还是弹给用户确认。

### 配置

把 `examples/claude-settings.json` 合并进 `~/.claude/settings.json`（全局）或项目里的 `.claude/settings.json`：

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash|Write|Edit|MultiEdit|WebFetch|mcp__.*",
        "hooks": [
          { "type": "command", "command": "node /绝对路径/vigil/src/cli.ts hook claude", "timeout": 10 }
        ]
      }
    ]
  }
}
```

`matcher` 是正则，挑你要管的工具。建议全管 —— 漏掉的工具就是后门。

### 钩子做的事

```
stdin: { session_id, tool_name, tool_input }
   ↓  classifyToolCall()  把工具调用翻译成动作形状（不依赖自然语言）
   ↓  kernel.decide()     授权比对 → 硬规则 → 灰区判断 → 落账
stdout: { hookSpecificOutput: { permissionDecision, permissionDecisionReason } }
```

映射规则：

| 工具 | 判定为 | 授权等级 |
|---|---|---|
| `Read` / `Grep` / `Glob` / `WebFetch` | `query`，可逆、不对外 | L0 |
| `Write` / `Edit` / `MultiEdit` | `write_file`，可逆 | L2 |
| `Bash` 普通命令 | `shell`，可逆 | L2 |
| `Bash` 含 `rm -rf` / `git reset --hard` / 删表 | `shell`，**不可逆** | L3 |
| `Bash` 含 `curl -X POST` / `ssh` / `npm publish` | `shell`，**对外** | L3 |
| `Bash` 含支付/云资源删除 | 追加金额标记 | L4 |
| `mcp__*send*` / `*mail*` / `*post*` / `*deploy*` | `outbound`，对外、不可逆 | L3 |

### 三种返回

| Vigil 结论 | `permissionDecision` | 效果 |
|---|---|---|
| `allow` | `allow` | 直接执行 |
| `require_human` | `ask` | 交互式会话里弹给用户确认；无人值守时自然卡住 |
| `deny` | `deny` | 硬拦，连确认机会都不给 |

硬拦只来自确定性规则（凭据文件、禁止目标、金额超限、密钥外泄）。概率模型最多把 `allow` 降级成 `ask`。

### 钩子出故障怎么办

永远退出码 0，永远输出合法 JSON。分类失败、载荷解析失败、裁决超时（默认 4 秒）—— 都不会把你的 agent 带崩。超时按 `ask` 处理（fail-closed），影子模式下则放行。

---

## 方式二：命令包装器（任何客户端都能用）

客户端不支持钩子？只要能改命令行，就能被管住。

```bash
vigil run -- rm -rf build
vigil run -- git push --force
vigil run -- npm publish
```

退出码语义：

| 退出码 | 含义 |
|---|---|
| 0 | 放行，命令已执行（或命令自身返回 0） |
| 2 | 被否决，命令没跑 |
| 3 | 需要人工确认，命令没跑 |

在 agent 的系统提示里加一句就够了：

> 所有可能修改文件、访问网络、或调用外部服务的命令，必须通过 `vigil run -- <命令>` 执行。

这一层不如钩子硬（agent 可以绕过直接调），但配合只读挂载、受限 shell 之类的环境约束已经够用。

---

## 方式三：MCP 工具（最弱，但最灵活）

```bash
claude mcp add vigil -- node /绝对路径/vigil/src/cli.ts mcp
```

agent 自己调用 `vigil_decide`，拿到 `allow` 再动手。优点是能带上结构化证据（文件 id、核验状态），缺点是**依赖 agent 自觉**——它不调就没人管。

适合：你对 agent 有基本信任，只是想要一份可复盘的账本。

---

## 三种方式对比

| | 强制力 | 能带证据 | 能问人 | 接入成本 |
|---|---|---|---|---|
| 钩子 | 强（绕不过） | 弱（只有工具参数） | 能 | 改一个 JSON |
| 包装器 | 中（要改调用方式） | 无 | 不能 | 改命令 |
| MCP 工具 | 弱（靠自觉） | 强 | 不能 | 加一句提示 |

**建议组合**：钩子兜底 + MCP 补证据。钩子保证"不做坏事"，MCP 让 agent 主动提供"为什么这是对的"。

---

## 上线顺序：先看，再拦

这是原方案里最容易被忽略的一步，也是最该照做的一步。

```bash
# 第一周：影子模式，只记账不拦
VIGIL_SHADOW=1 node src/cli.ts hook claude

# 看账本，找误判
vigil ledger
vigil alerts

# 确认误拦率可接受之后，再去掉 VIGIL_SHADOW
```

影子模式的价值在于：你会看到 agent 现实中到底在干什么，以及你的规则错杀了多少正常操作。**没跑过影子模式就开拦截，第二天就会有人把钩子关掉。**

---

## 已知盲区

诚实列出，别指望它包治百病：

1. **看不懂"意图"**。它看动作形状。一条 `curl` 是把数据发给自己还是发给对手，它分不出——只能靠 `exfiltration` 那种概率问题和禁止清单兜。
2. **分类靠正则**。`Bash` 命令的风险特征是模式匹配，会漏（比如用 base64 藏起来的命令）也会误伤（注释里出现 `rm -rf` 也报）。规则库要持续调。
3. **子进程逃逸**。包住的命令里再起一个不经包装的进程，Vigil 看不见。真正的隔离要靠容器和权限，不靠这一层。
4. **钩子会变慢**。普通命令走快路径（不调模型）几乎无感；L3 以上每次多 150–500 毫秒。
