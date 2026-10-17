import { readdirSync, readFileSync, renameSync, existsSync, accessSync, constants } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { SpoolLine, parseRedactPatterns, secretEnvValues, type ReporterEvent } from '@reportee/shared';
import { ArtifactUploader, PENDING_SUFFIX, readPendingJobs } from '@reportee/playwright/artifacts';
import { postBatch, proxyFor } from '@reportee/playwright/sender';

export { publishComment, renderComment, upsertPrComment, type CommentReport } from './comment.js';

export interface UploadOptions {
  dir: string;
  apiUrl: string;
  token: string;
  timeoutMs?: number;
  /**
   * Don't mark executions without run_finished as aborted. By default `upload` runs after the test
   * step, so a spool that never finished means the runner is gone (ADR-019).
   */
  keepOpen?: boolean;
  /** Max time for pending artifact uploads (default 5 minutes). */
  artifactsTimeoutMs?: number;
  log?: (msg: string) => void;
}

export interface UploadSummary {
  files: number;
  uploadedFiles: number;
  events: number;
  /** Executions closed as aborted (runner exited without finishing). */
  aborted: number;
  /** Screenshots/videos/traces uploaded from pending files (ADR-029). */
  artifacts: number;
  failures: string[];
}

interface SpoolGroup {
  runKey: string;
  executionId?: string;
  jobId?: string;
  shardIndex: number;
  shardTotal: number;
  events: ReporterEvent[];
}

const BATCH = 500;
const SEP = '|';

/** Replays spool files. Idempotent: the server upserts on natural keys, so replays change nothing. */
export async function uploadSpool(opts: UploadOptions): Promise<UploadSummary> {
  const log = opts.log ?? (() => {});
  const summary: UploadSummary = { files: 0, uploadedFiles: 0, events: 0, aborted: 0, artifacts: 0, failures: [] };
  if (!existsSync(opts.dir)) {
    log(`No spool directory at ${opts.dir}; nothing to upload.`);
    return summary;
  }
  const files = readdirSync(opts.dir).filter((f) => f.endsWith('.ndjson'));
  for (const name of files) {
    summary.files++;
    const file = path.join(opts.dir, name);
    const groups = new Map<string, SpoolGroup>();
    let skipped = 0;
    for (const raw of readFileSync(file, 'utf8').split('\n')) {
      if (!raw.trim()) continue;
      // A crash can truncate the last line; skip anything that doesn't parse.
      let parsed: ReturnType<typeof SpoolLine.safeParse>;
      try {
        parsed = SpoolLine.safeParse(JSON.parse(raw));
      } catch {
        skipped++;
        continue;
      }
      if (!parsed.success) {
        skipped++;
        continue;
      }
      const l = parsed.data;
      const key = [l.runKey, l.shardIndex, l.executionId ?? '', l.jobId ?? ''].join(SEP);
      const g = groups.get(key) ?? {
        runKey: l.runKey,
        executionId: l.executionId,
        jobId: l.jobId,
        shardIndex: l.shardIndex,
        shardTotal: l.shardTotal,
        events: [],
      };
      g.events.push(l.event);
      groups.set(key, g);
    }

    let fileOk = true;
    for (const g of groups.values()) {
      const ended = g.events.some((e) => e.payload.type === 'run_finished' || e.payload.type === 'run_aborted');
      if (!ended && !opts.keepOpen && g.events.length) {
        g.events.push({
          id: randomUUID(),
          seq: Math.max(...g.events.map((e) => e.seq)) + 1,
          ts: new Date().toISOString(),
          payload: { type: 'run_aborted', reason: 'The runner exited without finishing (detected by turnsignal upload).' },
        });
        summary.aborted++;
      }
      for (let i = 0; i < g.events.length; i += BATCH) {
        const events = g.events.slice(i, i + BATCH);
        const res = await postBatch(
          opts.apiUrl,
          opts.token,
          {
            runKey: g.runKey,
            executionId: g.executionId,
            jobId: g.jobId,
            shardIndex: g.shardIndex,
            shardTotal: g.shardTotal,
            events,
          },
          opts.timeoutMs ?? 15_000,
        );
        if (!res.ok) {
          fileOk = false;
          summary.failures.push(`${name}: ${res.reason}`);
          break;
        }
        summary.events += events.length;
      }
      if (!fileOk) break;
    }
    if (fileOk) {
      renameSync(file, file.replace(/\.ndjson$/, '.ndjson.uploaded'));
      summary.uploadedFiles++;
      log(`Uploaded ${name}${skipped ? ` (skipped ${skipped} damaged line(s))` : ''}`);
    }
  }
  await uploadPendingArtifacts(opts, summary);
  return summary;
}

/**
 * Artifacts the reporter queued but couldn't finish (runner stopped, storage unreachable, or no token
 * in the test process). Files must still exist on this machine. Traces are redacted exactly like the
 * reporter does, with this environment's secret values and TURNSIGNAL_REDACT patterns.
 */
async function uploadPendingArtifacts(opts: UploadOptions, summary: UploadSummary): Promise<void> {
  const log = opts.log ?? (() => {});
  const files = readdirSync(opts.dir).filter((f) => f.endsWith(PENDING_SUFFIX));
  for (const name of files) {
    const file = path.join(opts.dir, name);
    const jobs = readPendingJobs(file);
    if (jobs.length) {
      const uploader = new ArtifactUploader({
        apiUrl: opts.apiUrl,
        token: opts.token,
        requestTimeoutMs: opts.timeoutMs ?? 15_000,
        redactTraces: process.env.TURNSIGNAL_REDACT_TRACES !== '0',
        traceRedaction: {
          values: secretEnvValues(process.env),
          patterns: parseRedactPatterns(process.env.TURNSIGNAL_REDACT),
          keepSource: process.env.TURNSIGNAL_TRACE_SOURCE === '1',
        },
        pendingFile: file,
        log,
      });
      for (const job of jobs) uploader.add(job);
      const ok = await uploader.flush(opts.artifactsTimeoutMs ?? 5 * 60_000);
      summary.artifacts += uploader.stats.uploaded;
      if (!ok) {
        summary.failures.push(`${name}: ${uploader.pending || uploader.stats.failed} artifact upload(s) failed`);
        continue;
      }
    }
    renameSync(file, `${file}.uploaded`);
  }
}


export interface DoctorCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export async function doctor(opts: { dir: string; apiUrl?: string; token?: string; apiUrlIsDefault?: boolean }): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  checks.push({ name: 'Node.js >= 18', ok: nodeMajor >= 18, detail: process.versions.node });
  checks.push({
    name: 'API URL',
    ok: Boolean(opts.apiUrl),
    detail: opts.apiUrl
      ? `${opts.apiUrl}${opts.apiUrlIsDefault ? ' (default; set TURNSIGNAL_API_URL to use another server)' : ''}`
      : 'none: set TURNSIGNAL_TOKEN (results are only saved locally)',
  });
  checks.push({
    name: 'TURNSIGNAL_TOKEN set',
    ok: Boolean(opts.token),
    detail: opts.token ? `${opts.token.slice(0, 8)}…` : 'missing: results will only be saved locally',
  });

  if (opts.apiUrl) {
    try {
      const proxy = proxyFor(new URL(opts.apiUrl));
      checks.push({
        name: 'Proxy',
        ok: true,
        detail: proxy ? `reporter will connect via ${proxy.host} (from HTTPS_PROXY/HTTP_PROXY)` : 'none (direct connection)',
      });
    } catch {
      checks.push({ name: 'TURNSIGNAL_API_URL is a valid URL', ok: false, detail: opts.apiUrl });
    }
    try {
      const res = await fetch(`${opts.apiUrl.replace(/\/$/, '')}/healthz`, { signal: AbortSignal.timeout(5000) });
      checks.push({ name: 'API reachable', ok: res.ok, detail: `HTTP ${res.status}` });
    } catch (err) {
      const proxy = process.env.HTTPS_PROXY || process.env.https_proxy;
      checks.push({
        name: 'API reachable',
        ok: false,
        detail: `${err instanceof Error ? err.message : String(err)}${proxy ? ` (proxy: ${proxy})` : ''}`,
      });
    }
  }
  if (opts.apiUrl && opts.token) {
    try {
      const res = await fetch(`${opts.apiUrl.replace(/\/$/, '')}/v1/whoami`, {
        headers: { authorization: `Bearer ${opts.token}` },
        signal: AbortSignal.timeout(5000),
      });
      const body = res.ok ? ((await res.json()) as { project?: string; artifacts?: { enabled: boolean; policy: string } }) : undefined;
      checks.push({
        name: 'Token valid',
        ok: res.ok,
        detail: res.ok ? `project: ${body?.project}` : `HTTP ${res.status}`,
      });
      if (body?.artifacts) {
        // Informational: artifacts being off is a choice, not a broken setup.
        const a = body.artifacts;
        checks.push({
          name: 'Screenshots, videos and traces',
          ok: true,
          detail: !a.enabled
            ? 'not stored: this server has no artifact storage'
            : a.policy === 'off'
              ? 'off for this project (change it in the project settings)'
              : `stored for ${a.policy === 'all' ? 'all tests' : 'failed and flaky tests'}; record them with Playwright's trace/video/screenshot options`,
        });
      }
    } catch (err) {
      checks.push({ name: 'Token valid', ok: false, detail: String(err) });
    }
  }

  const spoolParent = existsSync(opts.dir) ? opts.dir : path.dirname(path.resolve(opts.dir));
  try {
    accessSync(spoolParent, constants.W_OK);
    checks.push({ name: 'Spool directory writable', ok: true, detail: path.resolve(opts.dir) });
  } catch {
    checks.push({ name: 'Spool directory writable', ok: false, detail: `${spoolParent} is not writable` });
  }
  const pending = existsSync(opts.dir) ? readdirSync(opts.dir).filter((f) => f.endsWith('.ndjson') || f.endsWith(PENDING_SUFFIX)).length : 0;
  checks.push({
    name: 'No undelivered results',
    ok: pending === 0,
    detail: pending ? `${pending} spool file(s) pending: run \`turnsignal upload\`` : 'none',
  });
  return checks;
}
