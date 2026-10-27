export { Kernel } from './kernel.ts';
export type { KernelOptions } from './kernel.ts';
export { Ledger, GENESIS_HASH } from './ledger/store.ts';
export type { LedgerSigner, NewApproval, ApprovalEvent } from './ledger/store.ts';
export {
  generateSigningIdentity,
  saveSigningIdentity,
  loadSigningIdentity,
  signBytes,
  verifyBytes,
} from './ledger/signing.ts';
export type { SigningIdentity } from './ledger/signing.ts';
export { exportBundle } from './bundle.ts';
export type { VigilBundle } from './bundle.ts';
export { toOtelSpans, toOtelJsonl } from './otel.ts';
export { JevJudge } from './judge/jev.ts';
export type { JevOptions } from './judge/jev.ts';
export { LocalJudge } from './judge/local.ts';
export { MockJudge } from './judge/mock.ts';
export type { Judge } from './judge/index.ts';
export { adviseThresholds, shapeOfJudgment, shapeOfQuestion } from './review/thresholds.ts';
export type { ThresholdAdvice, ThresholdReport } from './review/thresholds.ts';
export { defaultPolicy, defaultRules, runRules, grantedAuthority, actionSummary } from './policy/rules.ts';
export type { PolicyContext, Rule } from './policy/rules.ts';
export { requiredAuthority, describeAuthority } from './policy/authority.ts';
export { postmortem } from './review/postmortem.ts';
export type { Postmortem, TimelineEntry } from './review/postmortem.ts';
export { calibrate } from './review/calibrate.ts';
export type { CalibrationReport } from './review/calibrate.ts';
export { scanAlerts } from './alerts.ts';
export type { Alert, AlertOptions } from './alerts.ts';
export { startMcpServer } from './mcp/server.ts';
export { pipelineRules } from './pipeline/rules.ts';
export {
  forkRoute,
  forkQualityGate,
  forkStopLoss,
  forkAcceptance,
  forkEscalate,
  ORCHESTRATOR,
  GATE_ACTOR,
} from './pipeline/forks.ts';
export type {
  RouteInput,
  RouteResult,
  QualityGateInput,
  QualityGateResult,
  StopLossInput,
  StopLossResult,
  AcceptanceInput,
  AcceptanceResult,
  EscalateInput,
  EscalateResult,
  RiskTier,
} from './pipeline/forks.ts';
export { Orchestrator, createPipelineKernel } from './pipeline/orchestrator.ts';
export type {
  OrchestratorOptions,
  WorkerRunContext,
  WorkerOutput,
  VigilWorker,
  TaskReport,
  TaskStatus,
} from './pipeline/orchestrator.ts';
export { classifyToolCall, buildQuestions, resolveSessionId, analyzeShell } from './hook/mapping.ts';
export type { Classification, HookPayload, ShellRisk } from './hook/mapping.ts';
export { runClaudeHook } from './hook/claude.ts';
export type { ClaudeHookOptions, ClaudeHookOutput } from './hook/claude.ts';
export { runWrapped } from './hook/run.ts';
export { hookPolicy } from './hook/policy.ts';
export { loadPolicyConfig, savePolicyConfig, parsePolicyConfig, CONFIG_BASENAME } from './policy/config.ts';
export { scanProject, prioritize, levelHistogram } from './scan/index.ts';
export type { ScanReport, Finding, ObservedSummary, ScanOptions, Severity } from './scan/index.ts';
export {
  inferAuthority,
  classifyMcpServer,
  classifyScript,
  extractScope,
  describeLevel,
} from './scan/classify.ts';
export type { Capability, CapabilityKind, InferredLevel, McpServerDef } from './scan/classify.ts';
export type {
  ActionSpec,
  AuthorityLevel,
  DecisionRecord,
  DecisionRequest,
  Evidence,
  HardBlock,
  JudgeQuestion,
  Judgment,
  Outcome,
  OutcomeLabel,
  Verdict,
} from './types.ts';
export { AUTHORITY_LABELS } from './types.ts';
