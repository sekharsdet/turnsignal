/**
 * Secret redaction (ADR-022). Applied in the reporter before anything leaves CI, and again on the
 * server as a safety net. Errors from real test suites routinely contain credentials: URLs with
 * user:pass, Authorization headers, API keys in request bodies, tokens printed by helpers.
 */

export const REDACTED = '[REDACTED]';

/** Well-known credential formats (value is replaced entirely). */
const TOKEN_PATTERNS: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\bgh[pousr]_[A-Za-z0-9]{30,}\b/g, // GitHub tokens
  /\bgithub_pat_[A-Za-z0-9_]{40,}\b/g,
  /\bnpm_[A-Za-z0-9]{30,}\b/g,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, // AWS access key id
  /\bxox[abposr]-[A-Za-z0-9-]{10,}\b/g, // Slack
  /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}\b/g, // Stripe
  /\bAIza[0-9A-Za-z_-]{35}\b/g, // Google API key
  /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, // JWT
  /\b(?:rpt|tsk)_[A-Za-z0-9_-]{20,}\b/g, // our own project tokens
];

/** Patterns that keep a readable prefix and redact only the secret part (group 2). */
const CONTEXT_PATTERNS: RegExp[] = [
  // Authorization: Bearer xxx / Basic xxx / Token xxx (headers, curl output, logs)
  /(\b(?:authorization|proxy-authorization)\b["']?\s*[:=]\s*["']?(?:bearer|basic|token|digest)?\s*)([^\s"',;]+)/gi,
  /(\b(?:bearer|basic)\s+)([A-Za-z0-9._~+/=-]{8,})/gi,
  // Credentials embedded in URLs: scheme://user:password@host
  /(\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:)([^\s/@]+)(?=@)/gi,
  // key=value, key: value and "key": "value" for secret-looking keys
  /(\b[\w-]*(?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|client[_-]?secret|session[_-]?id|cookie)[\w-]*["']?\s*[:=]\s*["']?)([^\s"'&,;}]{4,})/gi,
];

export interface RedactOptions {
  /** Exact strings to mask (e.g. values of secret-looking environment variables). */
  values?: readonly string[];
  /** Extra patterns; the whole match is masked. */
  patterns?: readonly RegExp[];
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function redactSecrets(text: string, opts: RedactOptions = {}): string {
  if (!text) return text;
  let out = text;
  for (const v of opts.values ?? []) {
    if (v.length >= 8) out = out.replace(new RegExp(escapeRegExp(v), 'g'), REDACTED);
  }
  for (const p of opts.patterns ?? []) out = out.replace(new RegExp(p.source, p.flags.includes('g') ? p.flags : `${p.flags}g`), REDACTED);
  for (const p of TOKEN_PATTERNS) out = out.replace(p, REDACTED);
  for (const p of CONTEXT_PATTERNS) out = out.replace(p, (_m, prefix: string) => `${prefix}${REDACTED}`);
  return out;
}

const SECRET_ENV_NAME = /(TOKEN|SECRET|PASSWORD|PASSWD|PWD|KEY|CREDENTIAL|AUTH|COOKIE|SESSION)/i;
/** Values that are secret-named but not secret, and would cause noisy false positives. */
const NOT_SECRET = new Set(['true', 'false', 'null', 'undefined']);

/** Values of environment variables whose names look secret (≥ 8 chars), longest first. */
export function secretEnvValues(env: Record<string, string | undefined>): string[] {
  const values = new Set<string>();
  for (const [name, value] of Object.entries(env)) {
    if (!value || value.length < 8 || NOT_SECRET.has(value.toLowerCase())) continue;
    if (SECRET_ENV_NAME.test(name)) values.add(value);
  }
  return [...values].sort((a, b) => b.length - a.length);
}

/** Parse user patterns from TURNSIGNAL_REDACT (comma-separated regex sources). Invalid ones are skipped. */
export function parseRedactPatterns(spec: string | undefined): RegExp[] {
  if (!spec) return [];
  const out: RegExp[] = [];
  for (const src of spec.split(',').map((s) => s.trim()).filter(Boolean)) {
    try {
      out.push(new RegExp(src, 'g'));
    } catch {
      // ignore invalid patterns rather than failing the run
    }
  }
  return out;
}
