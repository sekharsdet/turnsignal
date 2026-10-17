import { appendFileSync, existsSync, readFileSync, statSync } from 'node:fs';
import { redactTraceZip, type TraceRedactOptions } from '@reportee/shared';
import { postJson, putFile, type PutBody } from './sender.js';

/**
 * Artifact uploads (ADR-029): screenshots, videos and traces go straight to object storage with
 * presigned URLs, in the background, two at a time. Contract (reporter-contract skill): never throw,
 * never change the exit code, bounded waiting; anything unfinished is recorded in a pending file
 * that `turnsignal upload` / `turnsignal run` retries after the test process ends.
 */

export type ArtifactKind = 'trace' | 'video' | 'screenshot' | 'other';

export interface ArtifactJob {
  runKey: string;
  executionId: string;
  jobId: string;
  shardIndex: number;
  shardTotal: number;
  testKey: string;
  attempt: number;
  status: string;
  kind: ArtifactKind;
  name: string;
  contentType: string;
  path: string;
}

export const MAX_TRACE_BYTES_TO_REDACT = 100 * 1024 * 1024;
export const PENDING_SUFFIX = '.artifacts.jsonl';
/** Presign answers that will never succeed for this job (retrying is pointless). */
const NEVER_ACCEPTED = new Set([400, 404, 405, 410, 413, 415, 422]);

export const jobKey = (j: Pick<ArtifactJob, 'executionId' | 'testKey' | 'attempt' | 'name'>) => `${j.executionId}|${j.testKey}|${j.attempt}|${j.name}`;

/** Which Playwright attachments we upload, and as what. */
export function classifyAttachment(a: { name: string; contentType: string; path?: string }): ArtifactKind | undefined {
  if (!a.path) return undefined;
  if (a.name === 'trace' && a.contentType === 'application/zip') return 'trace';
  if (a.contentType.startsWith('video/')) return 'video';
  if (/^image\/(png|jpeg|webp)$/.test(a.contentType)) return 'screenshot';
  return undefined;
}

export interface UploaderOptions {
  apiUrl: string;
  token: string;
  requestTimeoutMs: number;
  /** Redact traces before upload (default true). Unredactable traces are then skipped, never sent raw. */
  redactTraces: boolean;
  traceRedaction: TraceRedactOptions;
  /** Append-only record of queued/finished uploads, for retry after the process ends. */
  pendingFile?: string;
  concurrency?: number;
  log?: (msg: string) => void;
}

type PresignItem = { accepted: true; id: string; url: string; headers: Record<string, string> } | { accepted: false; reason: string };

export class ArtifactUploader {
  private queue: ArtifactJob[] = [];
  private active = 0;
  private idleWaiters: (() => void)[] = [];
  private failures = 0;
  private circuitOpen = false;
  private skippedReasons = new Set<string>();
  readonly stats = { uploaded: 0, skipped: 0, failed: 0 };

  constructor(private readonly opts: UploaderOptions) {}

  add(job: ArtifactJob): void {
    try {
      if (this.opts.pendingFile) appendFileSync(this.opts.pendingFile, JSON.stringify({ job }) + '\n');
    } catch {
      // pending file is best effort
    }
    if (this.circuitOpen) return;
    this.queue.push(job);
    this.pump();
  }

  get pending(): number {
    return this.queue.length + this.active;
  }

  private markDone(job: ArtifactJob, result: 'uploaded' | 'skipped'): void {
    if (result === 'uploaded') this.stats.uploaded++;
    else this.stats.skipped++;
    try {
      if (this.opts.pendingFile) appendFileSync(this.opts.pendingFile, JSON.stringify({ done: jobKey(job), result }) + '\n');
    } catch {
      // ignore
    }
  }

  private pump(): void {
    const max = this.opts.concurrency ?? 2;
    while (!this.circuitOpen && this.active < max && this.queue.length) {
      const batch = this.queue.splice(0, Math.min(10, this.queue.length));
      this.active++;
      void this.runBatch(batch).finally(() => {
        this.active--;
        this.pump();
        if (this.pending === 0 || this.circuitOpen) for (const w of this.idleWaiters.splice(0)) w();
      });
    }
  }

  private failed(reason: string): void {
    this.stats.failed++;
    if (++this.failures >= 3 && !this.circuitOpen) {
      this.circuitOpen = true;
      this.queue = [];
      this.opts.log?.(`artifact uploads paused (${reason}); they will be retried by \`npx turnsignal upload\`.`);
    }
  }

  private async runBatch(batch: ArtifactJob[]): Promise<void> {
    try {
      // Prepare bodies first: redact traces, skip missing/oversized files.
      const prepared: { job: ArtifactJob; body: PutBody; size: number }[] = [];
      for (const job of batch) {
        const body = this.prepare(job);
        if (body) prepared.push({ job, body, size: 'buffer' in body ? body.buffer.length : body.size });
      }
      if (!prepared.length) return;
      const first = prepared[0]!.job;
      const presign = await postJson(
        `${this.opts.apiUrl.replace(/\/$/, '')}/v1/artifacts/presign`,
        this.opts.token,
        {
          runKey: first.runKey,
          executionId: first.executionId,
          jobId: first.jobId,
          shardIndex: first.shardIndex,
          shardTotal: first.shardTotal,
          items: prepared.map(({ job, size }) => ({
            testKey: job.testKey,
            attempt: job.attempt,
            status: job.status,
            kind: job.kind,
            name: job.name,
            contentType: job.contentType,
            size,
          })),
        },
        this.opts.requestTimeoutMs,
      );
      if ('error' in presign || presign.status >= 400) {
        const reason = 'error' in presign ? presign.error : `HTTP ${presign.status}`;
        // Never accepted by this server (e.g. an old server without the endpoint, or a malformed
        // request): mark done so nobody retries forever.
        if (!('error' in presign) && NEVER_ACCEPTED.has(presign.status)) {
          for (const p of prepared) this.markDone(p.job, 'skipped');
          this.note(`artifacts not accepted (${reason})`);
          return;
        }
        // Fixable later (wrong/revoked token 401/403, monthly limit 402, rate limit, network, 5xx):
        // keep them pending so `turnsignal upload` can send them. Auth errors won't fix themselves
        // in this run, so stop trying now.
        if (!('error' in presign) && (presign.status === 401 || presign.status === 403 || presign.status === 402)) this.failures = 2;
        this.failed(reason);
        return;
      }
      const items = (JSON.parse(presign.text) as { items: PresignItem[] }).items;
      const uploaded: string[] = [];
      for (let i = 0; i < prepared.length; i++) {
        const item = items[i];
        const { job, body } = prepared[i]!;
        if (!item || !item.accepted) {
          this.markDone(job, 'skipped');
          // Skipped by the project's policy (e.g. passing tests) is the expected case: stay quiet.
          if (item && !item.accepted && !item.reason.startsWith('project artifact policy')) this.note(item.reason);
          continue;
        }
        const put = await putFile(item.url, item.headers, body);
        if ('error' in put || put.status >= 300) {
          this.failed('error' in put ? put.error : `storage HTTP ${put.status}`);
          continue;
        }
        uploaded.push(item.id);
        this.markDone(job, 'uploaded');
        this.failures = 0;
      }
      if (uploaded.length) {
        await postJson(`${this.opts.apiUrl.replace(/\/$/, '')}/v1/artifacts/complete`, this.opts.token, { ids: uploaded }, this.opts.requestTimeoutMs);
      }
    } catch (err) {
      this.failed(err instanceof Error ? err.message : String(err));
    }
  }

  /** Returns the bytes to upload, or undefined when the artifact must be skipped. */
  private prepare(job: ArtifactJob): PutBody | undefined {
    if (!existsSync(job.path)) {
      this.markDone(job, 'skipped');
      return undefined;
    }
    const size = statSync(job.path).size;
    if (job.kind !== 'trace' || !this.opts.redactTraces) return { path: job.path, size };
    if (size > MAX_TRACE_BYTES_TO_REDACT) {
      this.markDone(job, 'skipped');
      this.note(`trace over ${MAX_TRACE_BYTES_TO_REDACT / 1024 / 1024} MB not uploaded (it can't be redacted safely in memory)`);
      return undefined;
    }
    try {
      return { buffer: redactTraceZip(readFileSync(job.path), this.opts.traceRedaction).bytes };
    } catch {
      // Never upload a trace we couldn't redact.
      this.markDone(job, 'skipped');
      this.note('a trace could not be read for redaction and was not uploaded');
      return undefined;
    }
  }

  private note(reason: string): void {
    if (this.skippedReasons.has(reason)) return;
    this.skippedReasons.add(reason);
    this.opts.log?.(reason);
  }

  /** Waits until everything queued is done, the circuit opens, or the deadline passes. */
  async flush(deadlineMs: number): Promise<boolean> {
    if (this.pending === 0) return !this.circuitOpen;
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      new Promise<void>((r) => this.idleWaiters.push(r)),
      new Promise<void>((r) => {
        timer = setTimeout(r, deadlineMs);
        timer.unref();
      }),
    ]);
    clearTimeout(timer);
    return this.pending === 0 && !this.circuitOpen && this.stats.failed === 0;
  }
}

/** Reads a pending file: jobs that were queued but never finished (for `turnsignal upload`). */
export function readPendingJobs(file: string): ArtifactJob[] {
  const jobs = new Map<string, ArtifactJob>();
  const done = new Set<string>();
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const rec = JSON.parse(line) as { job?: ArtifactJob; done?: string };
      if (rec.job) jobs.set(jobKey(rec.job), rec.job);
      if (rec.done) done.add(rec.done);
    } catch {
      // a crash can truncate the last line
    }
  }
  return [...jobs.entries()].filter(([k]) => !done.has(k)).map(([, j]) => j);
}
