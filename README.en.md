> **中文版 / Chinese:** [README.md](README.md)

# Vigil

**An AI decision ledger and circuit-breaker kernel, with a complete five-fork orchestration loop.** Every agent decision becomes interceptable, traceable, calibratable, and signature-verifiable; every dispatch runs through routing, quality gates, stop-loss, acceptance, and escalation.

> Your agent gets things done, but nobody remembers why it did them, who is accountable when it's wrong, or which rule to change next time.
> Vigil is the layer that closes that gap.

```
┌─ Orchestrator ──────────────────────────────────────────┐
│                                                          │
│   ┌→ stop-loss ──stop if bad enough──→ STOPPED           │
│   │   routing ──none selectable──→ escalate human → ESCALATED
│   │   work (every round is ledger-recorded)              │
│   │   quality gate ──fail──→ back to routing w/ feedback │
│   └─── acceptance (all four checks required)──pass──→ COMPLETED
└──────────── every fork is a kernel verdict ──────────────┘
                              ↓
                  append-only ledger (hash chain + Ed25519 sig)
                    ↓
        postmortem → calibrate → auto-tune thresholds by type → alerts
        export offline verification bundle (zero-dep third-party verify) / OTel spans

agent wants to act → ┌──────────────┐ → allow / escalate / deny
                      │    Vigil     │
                      │  hard deny   │ → write append-only ledger (hash chain)
                      │  gray-zone probabilistic judgment │ → backfill label later → calibrate thresholds
                      └──────────────┘
```

## Why you need it

This layer is currently broken:

| What you're using | The question it answers | The question it does NOT answer |
|---|---|---|
| Langfuse / Phoenix / AgentOps | What happened (trace, span, cost) | Did this decision have a basis at the time? |
| OPA / Guardrails / various firewalls | Whether it can be done (rules, blocklists) | For the decisions that were wrong, how should the rules change? |
| LLM-as-judge | Was this output good this time? | When it says "0.9 confidence", how accurate is that actually? |

The middle is empty: **accountability for decisions**. The popularity of single-model systems like Jev exposes exactly this gap — they hand you a probability returned in 150 ms, but give you no ledger, no calibration, and no arbitration. A probability without a calibration loop means every threshold is pulled out of thin air.

## What it is NOT

- Not an agent orchestration framework. Use Claude Code, Grok Bot, Cursor — Vigil only steps in before an action is taken.
- Not a model. It calls a judgment model; it does not train one.
- Not a logging system. Logs record what happened; the ledger records what was decided — and the schemas differ.
- v0.1: the skeleton works, but the rule library is thin. Do not wire it directly to production payments.

## Core design

### 1. Decisions are first-class citizens, not a log line

A `DecisionRecord` contains at minimum: who acted, on what evidence, what authorization level was required vs. held, what deterministic rule fired, what probability the probabilistic judge gave, what the conclusion was, and whether it was later proven right or wrong. Missing any one of these and you cannot do a postmortem.

### 2. Hard constraints never use probability

This is the biggest divergence from most projects. **Do not let the model judge logic.**

- Money caps, irreversible operations, outward sends, secret leakage, and prohibited targets — all go through deterministic rules. Precise, testable, provable, with a veto.
- "Who should this task go to", "Is this research enough", "Does this commitment carry risk" — those go to the probabilistic model.
- The probabilistic model **never has a veto and never has a pass**. It can only turn an action that would otherwise be allowed into "needs a human look".

Together: **logic holds the baseline, probability handles the gray zone.**

### 2.5 The five-fork orchestration loop (one-to-one with Jev's judgment points)

| Fork | Question | Deterministic part | Probabilistic part |
|---|---|---|---|
| Routing | Who should do the next step | The selected executor must be on the roster, otherwise escalate immediately | A multiple-choice problem within the roster |
| Quality gate | Is this output good enough | The checker is structurally never the producer | Independent review scoring |
| Stop-loss | Continue or stop | Retry caps, consecutive-failure counts — just counting | Progress score (stop below 2) |
| Acceptance | Does it count as done | Four-item checklist: deliverable + location, independent verification record, leftover-issues statement — **missing any one, the model's word doesn't count** | Substantive satisfaction judgment |
| Escalation | Should a human take over | Anything touching money is immediately critical | Risk grading (routine / urgent / critical) |

"Supervising the process" is not a separate module: every fork in the loop and every round of execution is a verdict recorded in the hash chain, so `postmortem(sessionId)` can replay exactly why each step went the way it did.

### 2.6 Conflict arbitration: who decides when multiple agents disagree

| Situation | Who wins | Basis |
|---|---|---|
| Positions agree | Adopt directly | No dispute |
| Multiple positions from the same agent | Take the strictest | Its own change of mind doesn't count; take the most conservative |
| The action itself hits a red line | **Veto** | Unanimous agreement doesn't help |
| There's a veto position, and it has independent verification evidence the other side lacks | Side with the veto | Evidence advantage |
| There's a veto position, and its authorization level is strictly higher | Side with the veto | Authority level |
| There's a veto position, but neither prevails | **Escalate to human** | Neither evidence nor authority can decide |
| Only "may proceed" vs. "needs a look" remain | Model ranking | The only place the model is used |

**A veto position that has not been defeated is never auto-approved.** The model has no power to turn `deny` into `allow` — it can only help you rank between "everyone agrees to proceed" and "needs a human look". This is fail-closed extended to the multi-agent scenario.

Arbitration records are indistinguishable from ordinary decision records in the ledger — which is exactly the point: arbitration is also a decision, and equally must be traceable and reviewable.

### 3. Probabilistic judgment is multiple-choice only

Vigil only sends the judgment model typed questions (boolean / choice / score), never free text. It returns a probability distribution, not sentences. Structurally this closes off the path of "the model freelancing its way into overreach".

### 4. fail-closed

A timeout on the judgment service, a malformed response, a missing field — all are judged invalid and escalated to a human, never treated as a default allow. A `failOpen` switch exists but defaults to off.

### 5. Five-tier authorization (one change vs. the original design)

| Level | Meaning | Typical action |
|---|---|---|
| L0 | read_only | Query, retrieve |
| L1 | draft | Draft, propose |
| L2 | reversible_write | Reversible write |
| L3 | external_or_irreversible | Outbound send, irreversible modification |
| L4 | money | Anything involving money |

The original design put "money" and "irreversible" on the same level. We split them: deleting a database on the intranet and sending an outbound email can't be undone, with similar blast radii, so they can merge; but once money leaves, no technical means can recover it, so it must own its own level.

## Decision loop (DecisionLoop): from "a chatbot that analyzes" to "a decision system"

> The early versions' core flaw: a pull-based CLI — you ask, it answers, never pushes proactively, never executes on your behalf, has no confirmation gate before spending money, and dares to conclude before the evidence is complete. That isn't a decision system; it's "a chatbot with a ledger."

`vigil loop` turns a "decision" into a **runnable, traceable, interruptible, closed-loop** state machine, rather than a one-shot analysis text blob. It directly answers three hard requirements:

1. **Know in real time** — every step of the loop emits events (goal / evidence / decision / gate / execute), printed live and persisted to an event stream, so even with the chat closed you can `vigil loop --watch <id>` to replay every step.
2. **Execute by logic + let you confirm the important node before closing the loop** — an action that is external AND irreversible (spending money) must pass a human-confirmation gate (`--resume <id> --confirm`) before it actually executes; reversible / non-external actions are released automatically.
3. **Evidence must be real and complete** — before deciding, every evidence dimension required by that domain must be covered (authoritative / market / regulatory / financial / risk / expert / alternative / peer); **missing even one dimension forbids the decision**, nipping the "only checked online prices and misjudged over-budget" failure in the bud.

### Four pillars

| Pillar | Implementation | What it fixes |
|---|---|---|
| Live events | `LoopEventBus`, every stage `emit`s a visible event persisted to `events-<id>.jsonl` | No more silent analysis — every step is visible |
| Evidence-completeness gate | `checkCompleteness`, enumerates required evidence dimensions by domain; missing one (or unverified) → `blocked` | Deciding with incomplete/unverified evidence = blind decision, hard-blocked |
| Confirmation gate (HITL) | `isGatedAction = external && !reversible`, on hit → suspend `awaiting_confirmation` | Money actions 100% human-confirmed before execution (mirrors Operator's financial-transaction guardrails) |
| Pausable / resumable | state persisted to `loop-<id>.json`, `resume(confirmed)` restores | Can suspend while awaiting confirmation or price drops, without losing progress |
| Push channel (pull→push) | `LoopEventBus` also pushes every event to WeCom / email / generic webhook (`Notifier`) on emit | No longer only `vigil loop --watch` replay: each decision is pushed to your phone proactively |
| Real execution adapter | `ActionExecutor`: `DryRunExecutor` by default; set `VIGIL_EXECUTOR_WEBHOOK` to truly trigger your own order/account-open endpoint | Lands only after the confirmation gate releases; deny / unconfirmed never executes |

### Decision-domain registry (covers a whole life, not just shopping)

The evidence gate is general because **evidence dimensions are a cross-domain vocabulary**, and each life domain picks the subset it requires:

| Dimension | Meaning |
|---|---|
| authoritative | Official/authoritative sources: policy, regulation, official pricing, official guidelines |
| market | Market/commerce: price, supply, competitors, quotes, comparison |
| peer | Real user/community experience: word of mouth, pitfalls, long-term ownership feedback |
| expert | Professionals/experts: doctors, lawyers, industry people, consultants |
| regulatory | Compliance/policy/qualification: licenses, certification, subsidies, entry/immigration, legal risk |
| financial | Cost/financial impact: total cost of ownership, hidden fees, cash flow, interest, reimbursement |
| risk | Risk/safety: health, safety, exit cost, blow-up, fraud, side effects |
| alternative | Alternative comparison: better / cheaper / safer / more compliant choice |

Registered domains (`vigil domains` to view):

| Domain | key | Required dimensions | Excluded |
|---|---|---|---|
| Shopping | purchase | authoritative / market / regulatory / financial / alternative / peer | — |
| Medical | medical | authoritative / expert / regulatory / risk / financial / alternative | market (sales pitch doesn't count) |
| Education | education | authoritative / expert / regulatory / financial / alternative / risk | — |
| Travel | travel | authoritative / market / regulatory / risk / financial / alternative | — |
| Financing | financing | authoritative / regulatory / financial / risk / expert / alternative | market (sales pitch doesn't count) |
| Investing | invest | authoritative / regulatory / financial / risk / expert / alternative | market (sell-side / shilling doesn't count) |
| Work | work | authoritative / expert / financial / risk / alternative / regulatory | — |
| Housing | housing | authoritative / market / regulatory / financial / risk / alternative | — |

**To add a new domain (insurance / marriage / immigration / retirement …), just add one entry to `DECISION_DOMAINS` and the evidence gate applies automatically.**

### State machine

```
goal_received → plan → evidence_gathered → [evidence_complete | evidence_gap→blocked]
             → arbitrating → decision → (deny→completed)
             → (isGatedAction ? gate→awaiting_confirmation → resume→execute : execute)
             → completed
```

### Live evidence gathering (Evidence Provider): let evidence fetch itself

The completeness gate demands "real and complete" evidence. But evidence shouldn't be **hand-typed into goal.json forever** — the system should fetch machine-readable data itself, and for dimensions it can't fetch, **honestly mark them unverified and let the gate block**, never faking a "verified" stamp.

`src/loop/evidenceProvider.ts` defines the `EvidenceSource` interface and `gatherEvidence` orchestrator. **Multiple live sources can hang on the same dimension** (e.g. `invest/financial` runs FX, gold, silver, treasury, index, crypto simultaneously); the dimension counts as covered once any one source verifies. Built-in public-API sources (all keyless):

| Source | Dimension | Data | Reachable in sandbox |
|---|---|---|---|
| `FrankfurterFxSource` / `ErApiFxSource` | financial | USD/CNY live rate (ECB) | ✓ |
| `GoldSource` / `SilverSource` | financial | Spot gold XAU / silver XAG (gold-api.com) | ✓ |
| `TreasuryYieldSource` | financial | US 10Y treasury yield (AlphaVantage; `VIGIL_AV_KEY` raises quota) | ✓ |
| `CryptoSource` | financial | BTC / ETH quotes (CoinGecko) | public-net reachable; sandbox egress blocks |
| `StockIndexSource` | financial | S&P 500 etc. (Stooq CSV) | public-net reachable; sandbox egress blocks |
| `SearchSource` | non-machine dims | injectable `searchFn` (WebSearch backend) | depends on backend |

- `vigil evidence fetch <domain> "<question>" [--extended]`: live-gathers the domain's required-dimension evidence, emitting JSON with source URL + fetch timestamp; `--extended` includes crypto / index public sources.
- `vigil loop <goal.json> --gather [--extended]`: when evidence is empty or `--gather` is set, fills gaps with live sources (keeps whole-dimension verified evidence) before running.

```bash
# Live-fetch invest evidence (FX/gold/silver/treasury really fetched; crypto/index degrade honestly if blocked)
node src/cli.ts evidence fetch invest "allocate 200k USD globally" --extended
# → live-verified: financial (USD/CNY=6.6675 / gold $4045 / silver $53.9 / 10Y 4.99%)
# → unverified: authoritative / regulatory / risk / expert / alternative (need human/search)

# Run --gather on an empty-evidence skeleton: FX fetched live, but 5 dims unverified → gate blocks (no fake decision)
node src/cli.ts loop examples/goal-invest-200k-skeleton.json --gather

# Full closed loop with all-dimensions-real goal (financial live + others verified)
node src/cli.ts loop examples/goal-invest-200k-demo.json --gather --extended
```

**Design floor**: machine-readable data is fetched live with source + timestamp; unfetchable dimensions are never faked-verified — the completeness gate blocks and forces human/search input.

### Push channel (Notifier): from pull to push

`LoopEventBus` also **proactively pushes** every event (goal / evidence / decision / gate / execute …) to your configured channel on each emit — no longer only replayable via `vigil loop --watch`:

- **WeCom**: `VIGIL_NOTIFY_WECOM` group-robot webhook pushes event text to the group.
- **Email**: `VIGIL_NOTIFY_EMAIL_API` + `VIGIL_NOTIFY_EMAIL_FROM/TO` (Resend / Mailgun / SendGrid shape) sends event email.
- **Generic webhook**: `VIGIL_NOTIFY_WEBHOOK` POSTs the full event JSON (Feishu / Slack / Discord / Zapier / Make, any JSON-receiving service).

With no channel configured, the bus only persists (never pretends to have notified); push failures are logged only and never stall the decision loop.

### Real execution adapter (Executor): lands only after the confirmation gate releases

Loop "execution" is handled by an `ActionExecutor`; by default `DryRunExecutor` only prints the plan and causes no real side effects. Once `VIGIL_EXECUTOR_WEBHOOK` is set, a confirmed action is **POSTed to your own endpoint** (broker / account-opening / payment / Zapier), which performs the real order or account opening — **Vigil only "triggers after confirmation" and holds no fund credentials**.

> Key guardrail: the executor is only invoked **after the confirmation gate releases** (`deny` never reaches it, nor does an unconfirmed loop). So the safety of "real order / account opening" comes from the gate, not the executor.

```bash
# Configure a real execution endpoint + push channel, replay the real "confirm-to-order" flow
VIGIL_EXECUTOR_WEBHOOK=https://your-broker.example.com/vigil-execute \
VIGIL_NOTIFY_WEBHOOK=https://hooks.example.com/vigil \
  node src/cli.ts loop examples/goal-invest-200k-demo.json --gather
# → evidence ready → arbitrate → ⏸ confirmation gate suspended (every event already pushed to your webhook)

vigil loop --resume lp_xxxx --confirm
# → on confirm: gate lifts → WebhookExecutor POSTs your endpoint → returns external order id → completed
```

### Evidence-driven decision (Reasoning): live data really drives the call

`src/loop/reasoning.ts` `buildBrief()` runs after the completeness gate and before arbitration, turning verified evidence into a reviewable decision:

- `invest` / `financing`: live signals → concrete allocation (bond 15/25/35% by 10Y yield, equity 30% if S&P live else 20% to cash, gold 15% / silver 5% hedge, BTC 5% satellite only if live, cash fills to 100%), every slice citing live value + timestamp.
- **Non-finance (medical / education / work / shopping / travel / housing) also decides**: when evidence is grouped by `option` (≥2 options), it builds a **multi-option decision matrix** — ranks each option by `evidence completeness × risk red-flag` (`score = completeness(0~1) − (explicit risk flag ? 0.4 : 0)`; missing risk dimension → mild 0.15; a risk note counts as a red flag only if it matches `风险/红牌/失败/拒/极低…`). Single/no option falls back to an evidence summary — never fabricated.
- **Honest floor**: unfetched quotes → weight down/removed with a warning, confidence downgraded (5/6→high, 3-4→medium, <3→low), never a made-up number.

### Unified entry `vigil ask`: one sentence to start a decision

No more hand-writing `goal.json`. Describe the goal in natural language; the system **auto-detects the domain → gathers live evidence → reasons → confirmation gate → closed loop**:

```bash
vigil ask "allocate 200k USD globally across stocks, bonds and gold" --gather --extended
vigil ask "daughter: upgrade-via-exam vs competition-exempt undergrad" --domain education --gather
# set VIGIL_SEARCH_URL to auto-fill policy/expert/risk dimensions; without it the system never fakes-verifies
```

### Real run: buying a MacBook Neo (budget 4000, keep the old machine)

```bash
# 1) Start a loop, loading full-dimension evidence (see examples/goal-neo-purchase.json)
node src/cli.ts loop examples/goal-neo-purchase.json
# prints: 6 evidence dimensions (authoritative/market/regulatory/financial/alternative/peer, all verified)
#         → evidence complete, released → decision require_human → ⏸ confirmation gate suspended (awaiting_confirmation)

# 2) After reviewing the event stream and confirming, release the closed loop
node src/cli.ts loop --resume lp_xxxx --confirm
# prints: gate lifted → closed-loop execution (dry-run: compare best price, lock ≤4000 channel, generate order checklist)

# 3) Replay any loop's every step anytime
node src/cli.ts loop --watch lp_xxxx
```

Key correction: the first pass only checked online prices (5499) and misjudged "over-budget, deny." After adding the national subsidy 15% (4599→3909), education 3999, student subsidy + offline ~4030, **the post-subsidy actual payment is at or below 4000 — the budget constraint is satisfied** — which is exactly why the evidence-completeness gate exists.

The same mechanism is verified on **non-purchase domains**: `examples/goal-medical.json` (elective coronary stent, 6 dimensions all verified → gate suspended → confirm → closed loop), `examples/goal-financing.json` (200k business loan, all financing dimensions covered and sales-pitch excluded → gate suspended → confirm → closed loop), and `examples/goal-invest-200k-live.json` (**$200K global diversified allocation**, 6 dimensions really verified: live-fetched USD/CNY FX + WebSearch-sourced Fed rate / China cross-border compliance / valuation risk / asset-manager views / instrument comparison → arbitrate require_human → confirmation gate → closed loop emits allocation checklist). There is also `examples/goal-invest-200k-skeleton.json` to demo `--gather` honestly `blocked` on incomplete evidence. **This is not a "buy-a-laptop" tool — it's a general framework for clothing/food/housing/transport, work, shopping, travel, financing, investing, medical, and education.**

### `goal.json` shape

```jsonc
{
  "sessionId": "buy-macbook-neo-2026-10-28",
  "question": "Buy MacBook Neo? (office use, budget 4000)",
  "action": { "kind": "purchase_laptop", "target": "...", "reversible": false, "external": true, "moneyUsd": 563 },
  "positions": [ /* each position (allow/deny/require_human) + evidence */ ],
  "evidence": [ /* required dimensions for that domain: channel/priceRMB/verified */ ],
  "evidenceSpec": "purchase"   // domain key: purchase / medical / education / travel / financing / invest / work / housing
}
```

Test coverage: `npm test` includes `tests/loop.test.ts` (13 cases: domain registry, completeness, unverified-block, event persistence, gate suspension, missing-evidence block, deny-can't-execute, resume confirm/unconfirmed, autoConfirm, reversible-action auto-release).

## Quick start

Requires Node ≥ 22.18 (native TypeScript support, no build step).

```bash
git clone <this-repo> && cd vigil
node examples/demo.ts        # single-line scenario: verdict, postmortem, calibration, alert
node examples/company.ts     # an AI company: orchestrator with four workers runs three tasks,
                             # covering send-back-for-rework, self-produced-self-verified exposed, false-completion stop-loss
node examples/resumable.ts   # resumable orchestration loop: external agent acts as worker, runs across calls
node examples/arbiter.ts     # conflict arbitration: four cases walk every level of the arbitration ladder
npm test                     # 129 tests
```

`demo` prints: the verdict and reasoning at each step, the postmortem, confidence calibration, and alerts.

In real use, supply a key for the judgment model:

```bash
export TYPESAFE_API_KEY=tsf_xxx
```

With no key it falls back to the deterministic `MockJudge` — same input always yields the same conclusion, ideal for tests and incident reproduction.

## Integration

### Scan first — `vigil scan`

Governance config shouldn't be written by hand-reading docs. One command first clarifies "what can your agent actually do":

```bash
vigil scan                # scan current directory
vigil scan /path/to/app   # scan another project
vigil scan --write        # write the suggested policy into vigil.config.json, effective immediately
```

It does three things:

**1. Inventory capabilities.** Reads `.mcp.json`, `~/.claude.json`, `.cursor/mcp.json`, `.claude/settings.json`, `package.json` scripts, and root shell scripts, inferring an authorization level for each:

| Level | Meaning | Example |
|---|---|---|
| L0 | read-only | `github_search_issues` |
| L1 | draft | Generate a proposal, write a first draft |
| L2 | reversible write | `filesystem`, local build script |
| L3 | outbound or irreversible | `slack_send_message`, `git push`, `rm -rf` |
| L4 | money | `stripe`, payment-class script |

Names it can't interpret (`internal-crm`) are treated conservatively as L3 and flagged with `?` — it waits for you to confirm once, it doesn't guess.

**2. Report risks.** Only reports things that actually act: a money capability inside the working directory, a credential file (`.env`) coexisting with file-access capability, some server's root set to the entire `~`, hooks not installed at all, N escalations in the ledger with no one approving them.

**3. Calibrate with history.** If the ledger already has records, it tells you which action types were vetoed how many times, and whether high-risk actions cluster on a single actor. These are real rule-validation samples.

The `vigil.config.json` generated by `--write` is read and applied immediately at kernel startup (`VIGIL_CONFIG` overrides the path). The config can only **tighten** the built-in defaults; deleting it returns you to the conservative defaults.

### Rule packs — accident shapes are portable

The moat isn't the code, it's the rule library. So the rule library must be copyable, portable, and maintainable by non-engineers.

A rule pack is **declarative JSON, not code** — what gets loaded never executes any code, and even from an untrusted source it can at most make one rule always fire:

```bash
vigil rules list                              # what packs exist
vigil rules show healthcare.patient-data      # see the details
vigil rules check ./my-pack.json              # validate, don't install
vigil rules install healthcare.patient-data   # install, effective next startup
```

Four built-in industry packs: medical patient data, payment approval, multi-tenant isolation, code release.
Full format in [`docs/rule-packs.md`](docs/rule-packs.md).

**It's distributable, and therefore attackable.** Once a pack can be downloaded from someone else, "what someone else wrote" enters your decision chain. Four lines of defense:

| Defense | What it does |
|---|---|
| **Fingerprint** | The index records the sha256 of the content; it must match before install |
| **Signature** | Signed packs are verified; unsigned ones warn explicitly "nobody is vouching for it" |
| **Trust anchor is local** | The public key shipped with the index **doesn't count** — whoever can edit the index can swap the public key and signature together to forge them. The public key must be explicitly trusted by you (`vigil trust add`) |
| **Only tighten, never loosen** | A pack's policy patches can only lower money caps, lengthen blocklists, or **reduce** authorization. Installing a malicious pack can't relax any of your protections |

```bash
vigil rules publish my-pack.json --sign   # register into the index and sign
vigil rules search 医疗                     # search (Chinese query)
vigil rules install healthcare.patient-data # install from index (fingerprint + signature first)
vigil trust add signer.pem SomeHospital   # trust the signer's public key
```

| Feature | Why this way |
|---|---|
| No regex, only substring and `*` wildcard | Packs may come from outside; regex ReDoS can freeze your process |
| Rule `detail` must state clearly "why blocked" | You need to understand it at postmortem, and know which rule to change when it's stale |
| `deny` and `escalate` are separate | A veto is deterministic; escalation consumes a person, used only when human judgment is needed |
| A pack's `policy` only tightens, never loosens | Authorization is the job of `grants`; a rule pack can at most tighten it |

### Hooks — turn conventions into enforcement (recommended)

Writing "confirm before sending email" in a prompt fails the moment the model glitches. So the judgment points must sit on the **execution boundary**:

Vigil catches 6 lifecycle events, not just pre-action:

| Event | What it does |
|---|---|
| `PreToolUse` | Verdict — the only moment that can actually block an action |
| `PostToolUse` | Record the execution result; **scan tool output for credentials** (credentials leak through the response stream, only visible after the fact) |
| `PostToolUseFailure` | Failures are also ledger-recorded |
| `SessionStart` | Ledger-record, and inject this session's supervision state into the agent context |
| `Stop` / `SessionEnd` / `PreCompact` | Seal the session: cumulative decision count and spend |

**Emergency brake** — one command makes every subsequent action escalate to a human immediately, until you manually release:

```bash
vigil kill --reason "agent is bulk-editing production config"   # pull the brake
vigil unkill                                                  # release the brake
```

It's not a hard "reject" because a reject leaves you unable to even "stop and see what happened". The release action itself is logged (`.vigil/killed.released`) so you can audit who released it later.

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash|Write|Edit|MultiEdit|WebFetch|mcp__.*",
        "hooks": [{ "type": "command", "command": "node /absolute/path/vigil/src/cli.ts hook claude", "timeout": 10 }]
      }
    ]
  }
}
```

Drop it into `~/.claude/settings.json` to take effect. Three verdict mappings: `allow` → execute directly, `require_human` → prompt user to confirm, `deny` → hard block.

If the hook itself breaks (classification fails, 4s timeout, corrupted payload) it always exits 0 and never blocks the agent — that's our bug, the user shouldn't pay for it.

**Don't skip the rollout order**: run `VIGIL_SHADOW=1` for a week first — ledger only, no interception — confirm the false-block rate is acceptable before turning on interception. Turn on interception without running shadow mode and the hook gets disabled the next day.

Full docs in [`docs/hooks.md`](docs/hooks.md), config template in [`examples/claude-settings.json`](examples/claude-settings.json).

### Command wrapper — works with any client

```bash
vigil run -- rm -rf build      # exit code 3, not executed
vigil run -- npm test          # exit code 0, executes normally
```

| Exit code | Meaning |
|---|---|
| 0 | Allowed and executed |
| 2 | Vetoed |
| 3 | Needs human confirmation, not executed |

### CLI

```bash
vigil kill [--reason "reason"]     Emergency brake: all subsequent actions escalate to human
vigil unkill                       Release the emergency brake
vigil status                       Current ledger and brake status at a glance
vigil rules list|show|check|install|search|publish|verify   Rule packs: view, validate, install, search, register
vigil trust list|add|remove        Trusted signing public keys (for pack verification)
vigil ledger-migrate <src> <dst.db>    Migrate an NDJSON ledger to SQLite (for concurrency)
vigil scan [dir] --write      # scan agent capabilities and generate governance config (--write effective immediately)
vigil arbitrate <file.json|->  Decide when multiple agents' conclusions conflict
vigil loop <goal.json> [--auto-confirm] [--gather]   Decision loop: live events + evidence-completeness gate + confirmation gate + closed-loop execution (--gather fills evidence live)
vigil loop --resume <id> [--confirm]      Resume from a suspended loop (executes the closed loop after confirmation)
vigil loop --watch <id>           Replay a loop's event stream live
vigil evidence fetch <domain> "<question>"   Live-gather the domain's required-dimension evidence (with source URL + fetch timestamp)
vigil domains                  List all supported decision domains (clothing/food/housing/transport, work, shopping, travel, financing, medical, education…)
vigil decide request.json     # or read from stdin: vigil decide -
vigil ledger                  # list all decisions
vigil verify                  # verify hash chain + Ed25519 signature
vigil keygen                  # generate a signing identity; all subsequent records get signed
vigil bundle                  # export offline verification bundle (zero-dep third-party verify, see verify-standalone.mjs)
vigil thresholds --write      # compute recommended thresholds by question type from your backfilled labels, write back to config immediately
vigil approvals               # list pending human-approval escalations
vigil approve <id> approved "agreed" --by human/boss   # approval ledger-recorded, bound to record hash
vigil export-otel spans.jsonl # export OTel GenAI spans, feed straight into Langfuse/Phoenix
vigil postmortem <sessionId>  # postmortem
vigil calibrate proceed       # confidence calibration + threshold scan
vigil alerts                  # scan for alerts
vigil label <decisionId> wrong "customer denied the need"   # backfill outcome
```

Pick one of three judgment models, by priority:

| Env var | Backend | When to use |
|---|---|---|
| `VIGIL_LOCAL_JUDGE` | Local decision service (strands-decider / laya, `/v1/systemone` dialect) | Zero cost, data stays local, fine-tunable with your own data |
| `TYPESAFE_API_KEY` | TypeSafe Jev cloud | Don't want to run a model locally |
| Neither set | MockJudge (deterministic) | Tests, incident reproduction |

### MCP (recommended)

```bash
vigil mcp
```

For Claude Code:

```bash
claude mcp add vigil -- node /abs/path/to/vigil/src/cli.ts mcp
```

Exposes 10 tools. Each tool carries `annotations`, including the protocol-standard `readOnlyHint` / `destructiveHint`, plus our own `vigilAuthority` (what authorization level this tool needs) and `vigilEffect` (what it changes) — the MCP protocol itself only has two boolean bits, which can't express five-tier authorization.

**Single-point decisions** (6): `vigil_decide`, `vigil_postmortem`, `vigil_verify`, `vigil_alerts`, `vigil_calibrate`, `vigil_label`.

**Orchestration loop** (3): `vigil_task_start`, `vigil_task_submit`, `vigil_task_status`.

**Conflict arbitration** (1): `vigil_arbitrate`.

Convention: **the agent must call `vigil_decide` before acting, and only execute on `allow`.** This isn't by good behavior, it's enforced by hook — blocked in `PreToolUse`.

#### Orchestration loop: let an external agent act as the worker

Originally the orchestration loop could only run inside one process; an external agent couldn't plug in — it couldn't take over the worker role midway. Now it's a **resumable state machine across calls**, where the worker can be another process:

```jsonc
// 1. Open a task: Vigil decides who should do the next step
{"name": "vigil_task_start", "arguments": {
  "task": "write a quote email to customer ACME",
  "roster": [{"id": "bot/writer", "role": "writer"}, {"id": "bot/checker", "role": "checker"}],
  "taskId": "t1"
}}
// → {"turn": {"kind": "work", "workerId": "bot/writer", "attempt": 1,
//              "instructions": "...", "requirements": [...]}}

// 2. The external agent works per instructions, then hands back
{"name": "vigil_task_submit", "arguments": {
  "taskId": "t1",
  "summary": "draft written",
  "claim": "quote email complete",
  "deliverableUri": "drafts/quote-acme.md",
  "leftoverIssues": "",
  "evidence": [{"id": "ev_check", "producedBy": "bot/checker", "verified": true}]
}}
// → if items missing: {"turn": {"kind": "work", "attempt": 2, "feedback": "acceptance failed, missing: ..."}}
//   if complete: {"turn": {"kind": "completed"}}
```

`requirements` tells the executor the four acceptance checks directly, so it doesn't guess.
`feedback` carries the specific reason for last round's rejection into the next round, so it doesn't change blindly.

**One limitation to know**: if the same agent plays both executor and checker, "independent verification" degrades to formal independence — the ledger faithfully records who produced the evidence and who claimed completion, but real independence needs two processes. We don't pretend to have solved this.

### SDK

#### Just the verdict (single-point decision)

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
  intent: 'send the quote to the customer',
  action: { kind: 'send_email', target: 'ceo@acme.com', reversible: false, external: true },
  evidence: [
    { id: 'ev_pricing', producedBy: 'bot/researcher', claim: 'they have 3 pricing tiers', verified: true },
  ],
  questions: [
    { name: 'proceed', type: 'boolean', instructions: 'should this step proceed', floor: 0.8 },
    { name: 'risk', type: 'boolean', instructions: 'does this constitute a commercial commitment risk', escalateWhenTrue: true, floor: 0.75 },
  ],
});

if (verdict.outcome !== 'allow') throw new Error(`blocked: ${verdict.reason}`);
```

#### Full loop (orchestrator running tasks with workers)

```ts
import { createPipelineKernel, Orchestrator, JevJudge, Ledger } from 'vigil-oversight';

const kernel = createPipelineKernel(
  new Ledger('.vigil/ledger.ndjson'),
  new JevJudge({ apiKey: process.env.TYPESAFE_API_KEY! }),
);
const company = new Orchestrator(kernel, { maxAttempts: 3 });

const report = await company.runTask('sess_1', 'task_1', 'write an industry research report', [
  { id: 'bot/researcher', role: 'researcher', run: async (ctx) => ({ /* output */ }) },
  { id: 'bot/writer', role: 'writer', run: async (ctx) => ({ /* output */ }) },
]);
// report.status: completed | stopped | escalated
// report.steps: where each fork went, human-readable
```

Workers only do the work and hand over evidence; routing, quality gate, stop-loss, acceptance, and escalation are all driven by the Orchestrator, each step through the kernel and into the ledger. `ctx.feedback` tells you why the last round was rejected.

## Four metrics

Without watching these four numbers, the system is just playing with itself.

| Metric | Definition | Healthy range |
|---|---|---|
| **Decision traceability** | Of allowed actions, the share that can be traced to an evidence chain | > 90% |
| **False-completion rate** | Of allowed actions, the share later proven false | < 5% |
| **Autonomous completion rate** | Share completed without human intervention | Lower means more conservative, not necessarily worse |
| **Cost per task** | Cumulative spend per successful task | Set your own baseline; watch for sudden jumps |

## Relationship to adjacent projects

| Project | Positioning | Relationship to Vigil |
|---|---|---|
| `jkudish/jev-mcp` | Wraps 12 judgment tools | Can be used directly as a Judge backend |
| Langfuse / Phoenix | Trace and evaluation | Vigil records decisions, they record process — complementary |
| OPA / Rego | Policy engine | We deliberately avoid Rego: at the 0.1 stage, YAML-ized predicate functions ship faster; switch once rules pass 100 |
| Guardrails AI | Output validation | Guards model output; Vigil guards actions |

## Storage layer

Two backends, **with identical hash-chain semantics** — the hash only covers the record content, independent of storage, so swapping backends won't invalidate existing verification bundles.

| Backend | When to use | Characteristics |
|---|---|---|
| **NDJSON** (default) | Single process, personal use | Zero dependency, human-readable, directly `grep`-able |
| **SQLite** | Multiple processes / multiple agents writing simultaneously | Node 22's built-in `node:sqlite`, also zero dependency |

Which one is chosen by the path: `.db` / `.sqlite` suffix uses SQLite.

```bash
export VIGIL_LEDGER=.vigil/ledger.db     # switch to SQLite
vigil ledger-migrate .vigil/ledger.ndjson .vigil/ledger.db   # migrate existing ledger
```

The SQLite backend uses WAL mode + `BEGIN IMMEDIATE`: write locks queue instead of erroring, and "read previous → compute hash → write" is atomic, so multiple processes writing at once never miscompute `prevHash`.

Measured: three processes each writing 40 records, 120 total, hash chain intact, sequence numbers contiguous.

## Known limitations

Listed honestly so you don't step on them:

1. **The SQLite backend is still experimental.** Node 22's `node:sqlite` hasn't graduated; the interface may change. We suppress its warning (`VIGIL_SHOW_SQLITE_WARNING=1` re-enables it), but that doesn't change its nature of possibly changing anytime.
2. **The NDJSON backend does not support concurrent writes.** To have multiple processes write at once, switch to SQLite.
3. **The rule library is thin.** The default rules only cover the most common accident shapes. The real moat is the rule library thickening with accumulated incidents, not the code.
4. **Calibration needs labels.** Without backfilling outcomes, `calibrate` and `thresholds` are empty shells. This is an operations problem, not a technical one.
5. **Can't judge "whether the intent is sincere".** An agent says it's sending an email, but might do something else. Vigil looks at the action shape, not the self-description. Preventing this requires enforcement at the tool boundary, not at this layer.
6. **The "recommend by question type" thresholds only cover the allow direction.** Auto-calibration of risk-type questions (`escalateWhenTrue`) isn't done yet, because allow/block semantics are reversed and it needs a larger sample to be reliable.

## Compliance mapping

For procurement or audit scenarios, see [`docs/compliance-mapping.md`](docs/compliance-mapping.md): a clause-by-clause mapping to OWASP Agentic Top 10 (4 fully covered, 5 partially) and EU AI Act obligations.

## Roadmap

- [x] Decision kernel (hard rules + probabilistic gray zone + fail-closed)
- [x] Hash-chain ledger and verification
- [x] Postmortem / calibration / alerts
- [x] MCP stdio server (zero dependency)
- [x] Claude Code PreToolUse hook + universal command wrapper
- [x] Five-fork orchestration loop (routing / quality gate / stop-loss / acceptance / escalation)
- [x] Ed25519 ledger signing + offline verification bundle (verify-standalone.mjs)
- [x] Local decision-model integration (strands-decider / laya / kev, `/v1/systemone` dialect)
- [x] Auto-suggest and apply thresholds by question type (last mile of the calibration loop)
- [x] Approval events bound to record hash + escalation callback (human can revive)
- [x] OTel GenAI span export (into the Langfuse/Phoenix ecosystem)
- [x] `vigil scan` onboarding tool: scan capability inventory and risks, one-click generate an effective governance config
- [x] Orchestration loop on MCP (resumable state machine, external agent as worker)
- [x] Conflict arbitration `Arbiter`: decided by evidence and authority, an undefeated veto position is never released
- [x] Rule packs (declarative JSON, 4 built-in industry packs, installable and verifiable)
- [x] Storage layer switch to SQLite (built-in `node:sqlite`, multi-process concurrent writes, unchanged hash-chain semantics)
- [x] GitHub Top 50 AI projects research ([report](docs/ai-landscape-2026-10.md)) + MCP protocol compliance and tool-authorization annotations
- [x] Competitor benchmark against ECC, run for real ([report](docs/competitor-benchmark.md)): multi-event hooks, output-side credential detection, alert-level rules, emergency brake
- [x] Rule-pack index and distribution: fingerprint + signature + local trust anchor + tighten-only-never-loosen
- [x] `vigil init` one-click onboarding + `vigil doctor` health check (benchmarking ECC's doctor/repair)

## License

MIT
