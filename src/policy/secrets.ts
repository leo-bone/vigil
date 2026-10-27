/**
 * 凭据检测。
 *
 * 正则能 100% 抓到的东西，不该交给模型去猜。
 *
 * 对标 ECC 的 governance-capture：它会在**请求和输出两侧**都扫密钥。
 * 只扫请求侧是不够的 —— agent 读一个 .env、调一个返回 token 的接口，
 * 凭据是顺着**响应**流出来的，请求侧根本看不见。
 */

export interface SecretFinding {
  /** 凭据类型，如 openai_key / aws_key / private_key */
  type: string;
  /** 命中片段（已截断，不留完整密钥） */
  sample: string;
}

interface SecretPattern {
  type: string;
  pattern: RegExp;
  /** 只取匹配的前若干字符，避免把完整密钥写进账本 */
  take?: number;
  /** 取第几个捕获组作为"值"。没有就用整个匹配 */
  group?: number;
}

const SECRET_PATTERNS: SecretPattern[] = [
  { type: 'openai_key', pattern: /\bsk-(?:proj-)?[A-Za-z0-9_-]{16,}/, take: 12 },
  { type: 'typesafe_key', pattern: /\btsf_[A-Za-z0-9_-]{16,}/, take: 12 },
  { type: 'anthropic_key', pattern: /\bsk-ant-[A-Za-z0-9_-]{16,}/, take: 12 },
  { type: 'github_token', pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}/, take: 12 },
  { type: 'aws_key', pattern: /\bAKIA[0-9A-Z]{16}\b/, take: 8 },
  { type: 'google_key', pattern: /\bAIza[0-9A-Za-z_-]{35}\b/, take: 12 },
  { type: 'stripe_key', pattern: /\b[sr]k_live_[A-Za-z0-9]{16,}/, take: 12 },
  { type: 'slack_token', pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}/, take: 12 },
  { type: 'private_key', pattern: /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/, take: 0 },
  { type: 'jwt', pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/, take: 12 },
  // 赋值型：只看值那一段，键名（api_key=）不算秘密
  {
    type: 'password_assignment',
    pattern: /\b(?:password|passwd|secret|api[_-]?key|access[_-]?token)\s*[:=]\s*["']?([A-Za-z0-9_\-+/=]{12,})/i,
    group: 1,
  },
];

/** 明显是占位符的，不要当泄露 */
const PLACEHOLDER = /^(?:\*{3,}|x{6,}|\.\.\.|<[^>]*>|\{\{?[^}]*\}?\}|your[_-]?\w+|example|placeholder|dummy|redacted|changeme|todo)$/i;

function looksLikePlaceholder(sample: string): boolean {
  const trimmed = sample.trim();
  if (PLACEHOLDER.test(trimmed)) return true;
  // 全是同一个字符（xxxxx / 000000）也当占位符
  return /^(.)\1+$/.test(trimmed);
}

/**
 * 在一段文本里找凭据。
 *
 * 命中片段会被截断：账本是长期留存的，把完整密钥写进去等于二次泄露。
 */
export function detectSecrets(text: string): SecretFinding[] {
  if (!text) return [];
  const findings: SecretFinding[] = [];
  for (const { type, pattern, take, group } of SECRET_PATTERNS) {
    const match = pattern.exec(text);
    if (!match) continue;
    const raw = match[group ?? 0];
    if (raw === undefined) continue;
    if (looksLikePlaceholder(raw)) continue;
    findings.push({
      type,
      sample: take ? `${raw.slice(0, take)}…` : raw.slice(0, 40),
    });
  }
  return findings;
}

/** 只要一个字符串里有没有凭据 */
export function hasSecret(text: string): boolean {
  return detectSecrets(text).length > 0;
}

/** 把命中项拼成一句人能读的话 */
export function describeSecrets(findings: SecretFinding[]): string {
  if (findings.length === 0) return '';
  const types = [...new Set(findings.map((finding) => finding.type))];
  return `${types.join('、')}`;
}
