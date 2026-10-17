import { unzipSync, zipSync, strFromU8, strToU8 } from 'fflate';
import { REDACTED, redactSecrets, type RedactOptions } from './redact.js';

/**
 * Trace redaction at source (ADR-029). A Playwright trace.zip holds:
 *   *.trace / *.network / *.stacks   JSON lines: actions (incl. API request headers/bodies, typed values),
 *                                    HAR-style network entries (headers, cookies, URLs), console output
 *   resources/<sha1>.<ext>           response/request bodies, screenshots, DOM snapshot resources
 *   src/<sha1>.<ext>                 the TEST SOURCE FILES
 * We drop source files by default (source code never leaves CI, ADR-007), blank sensitive header
 * and cookie values, and run `redactSecrets` over every string and every text resource.
 */

export interface TraceRedactOptions extends RedactOptions {
  /** Keep test source files (the viewer's Source tab). Default false. */
  keepSource?: boolean;
}

export interface TraceRedactResult {
  bytes: Uint8Array;
  droppedSourceFiles: number;
}

const SENSITIVE_NAME = /^(authorization|proxy-authorization|cookie|set-cookie|x-api-key|x-auth-token|x-access-token|x-csrf-token|x-xsrf-token)$|(token|secret|password|passwd|api[_-]?key|session|credential)/i;
const TEXT_RESOURCE = /\.(json|txt|html?|xml|csv|js|mjs|css|svg|md|yaml|yml|log)$/i;
const MAX_TEXT_RESOURCE = 10 * 1024 * 1024;

function redactValue(value: unknown, opts: RedactOptions, keyHint?: string): unknown {
  if (typeof value === 'string') {
    if (keyHint && SENSITIVE_NAME.test(keyHint) && value.length > 0) return REDACTED;
    return redactSecrets(value, opts);
  }
  if (Array.isArray(value)) return value.map((v) => redactValue(v, opts, keyHint));
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    // HAR-style {name, value} pairs (headers, cookies, query params): decide by the pair's name.
    if (typeof obj.name === 'string' && 'value' in obj && Object.keys(obj).length <= 8) {
      // Every cookie value is a credential, whatever the cookie is called ("sid", "connect.sid", …).
      const sensitive = SENSITIVE_NAME.test(obj.name) || (keyHint !== undefined && /cookie/i.test(keyHint));
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(obj)) out[k] = k === 'value' && sensitive && v !== '' ? REDACTED : redactValue(v, opts, k);
      return out;
    }
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) out[k] = redactValue(v, opts, k);
    return out;
  }
  return value;
}

function redactJsonLines(text: string, opts: RedactOptions): string {
  return text
    .split('\n')
    .map((line) => {
      if (!line.trim()) return line;
      try {
        return JSON.stringify(redactValue(JSON.parse(line), opts));
      } catch {
        return redactSecrets(line, opts);
      }
    })
    .join('\n');
}

/** Returns a redacted copy of a trace.zip. Throws if the input isn't a zip (caller must not upload it then). */
export function redactTraceZip(input: Uint8Array, opts: TraceRedactOptions = {}): TraceRedactResult {
  const entries = unzipSync(input);
  const out: Record<string, Uint8Array> = {};
  let droppedSourceFiles = 0;
  for (const [name, data] of Object.entries(entries)) {
    if (name.startsWith('src/') && !opts.keepSource) {
      droppedSourceFiles++;
      continue;
    }
    if (/\.(trace|network|stacks)$/.test(name)) {
      out[name] = strToU8(redactJsonLines(strFromU8(data), opts));
    } else if (TEXT_RESOURCE.test(name) && data.length <= MAX_TEXT_RESOURCE) {
      out[name] = strToU8(redactSecrets(strFromU8(data), opts));
    } else {
      out[name] = data; // images and other binary resources
    }
  }
  return { bytes: zipSync(out, { level: 6 }), droppedSourceFiles };
}
