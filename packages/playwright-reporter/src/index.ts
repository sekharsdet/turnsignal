import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type {
  FullConfig,
  FullResult,
  Reporter,
  Suite,
  TestCase,
  TestError,
  TestResult,
} from '@playwright/test/reporter';
import {
  computeTestKey,
  stripAnsi,
  redactSecrets,
  secretEnvValues,
  parseRedactPatterns,
  REPORTER_VERSION,
  type RedactOptions,
  type EventPayload,
  type ReporterEvent,
  type TestErrorInfo,
  type TestRef,
} from '@reportee/shared';
import { Spool } from './spool.js';
import { Sender } from './sender.js';
import { ArtifactUploader, PENDING_SUFFIX, classifyAttachment, type ArtifactJob, type ArtifactKind } from './artifacts.js';
import { appendFileSync, existsSync, renameSync } from 'node:fs';
import { detectCi, detectGit, gitTopLevel, selectionArgs, setting, apiUrlFor } from './env.js';

export interface ReporteeOptions {
  /** Defaults to env TURNSIGNAL_API_URL, else https://app.turnsignal.ai when a token is set. */
  apiUrl?: string;
  /** Project token. Defaults to env TURNSIGNAL_TOKEN. Without it, results are only spooled locally. */
  token?: string;
  /** Directory for the crash-safe spool. Default: `.turnsignal` next to the Playwright config. */
  spoolDir?: string;
  /** Max time to wait for delivery at the end of the run. Default 10s. */
  flushTimeoutMs?: number;
  /** Per-request timeout. Default 3s. */
  requestTimeoutMs?: number;
  /** Memory sampling interval (also acts as heartbeat). Default 10s. */
  sampleIntervalMs?: number;
  /**
   * Extra values/patterns to mask in error messages, stacks and snippets (in addition to built-in
   * credential formats and the values of secret-looking env vars). Also: env TURNSIGNAL_REDACT.
   */
  redact?: (string | RegExp)[];
  /**
   * Which Playwright attachments to upload (ADR-029). Playwright's own `trace`, `video` and
   * `screenshot` settings decide what is recorded; the project's artifact policy decides what the
   * server keeps. Default: all three. Also env TURNSIGNAL_ARTIFACTS=trace,video,screenshot | none.
   */
  artifacts?: { trace?: boolean; video?: boolean; screenshot?: boolean };
  /** Extra time the run may wait at the end for artifact uploads. Default 30s (TURNSIGNAL_ARTIFACTS_TIMEOUT_MS). */
  artifactsTimeoutMs?: number;
  /** Redact traces before upload (headers, cookies, bodies, typed values). Default true. */
  redactTraces?: boolean;
  /** Include test source files in uploaded traces (the viewer's Source tab). Default false (ADR-007). */
  traceSource?: boolean;
}

function artifactKinds(option: ReporteeOptions['artifacts'], env: string | undefined): Set<ArtifactKind> {
  if (env) {
    if (env.trim() === 'none') return new Set();
    return new Set(env.split(',').map((k) => k.trim()).filter((k): k is ArtifactKind => ['trace', 'video', 'screenshot'].includes(k)));
  }
  const o = option ?? {};
  return new Set((['trace', 'video', 'screenshot'] as const).filter((k) => o[k] !== false));
}

const PLAN_CHUNK = 500;
const MB = 1024 * 1024;
/**
 * Sends whatever is queued at this interval. Full batches (500 events) still go immediately, so big
 * suites stream continuously; small ones make ~5x fewer requests than with a 1s tick (ADR-026).
 */
const SEND_TICK_MS = 5_000;

/**
 * Contract (ADR-004, ADR-012): never throw, never change the exit code, never block the run
 * for more than `flushTimeoutMs`, and write every event to disk before sending it.
 */
export default class ReporteeReporter implements Reporter {
  private readonly opts: Required<Omit<ReporteeOptions, 'apiUrl' | 'token' | 'spoolDir' | 'redact' | 'artifacts' | 'artifactsTimeoutMs' | 'redactTraces' | 'traceSource'>> &
    Pick<ReporteeOptions, 'apiUrl' | 'token' | 'spoolDir'>;
  /** Secrets never leave CI (ADR-022). */
  private readonly redaction: RedactOptions;
  private rootDir = process.cwd();
  private runKey = '';
  private jobId = 'default';
  /** One reporter process = one execution; CI re-runs create new executions of the same run (ADR-015). */
  private readonly executionId = randomUUID();
  private shardIndex = 1;
  private shardTotal = 1;
  private seq = 0;
  private spool: Spool | undefined;
  private sender: Sender | undefined;
  private timers: NodeJS.Timeout[] = [];
  private refs = new WeakMap<TestCase, TestRef>();
  private uploader: ArtifactUploader | undefined;
  private pendingFile: string | undefined;
  private readonly artifactKinds: Set<ArtifactKind>;
  private readonly artifactsTimeoutMs: number;
  private readonly traceOptions: { redactTraces: boolean; keepSource: boolean };

  constructor(options: ReporteeOptions = {}) {
    this.opts = {
      apiUrl: apiUrlFor(options.apiUrl ?? setting('API_URL'), options.token ?? setting('TOKEN')),
      token: options.token ?? setting('TOKEN'),
      spoolDir: options.spoolDir ?? setting('SPOOL_DIR'),
      flushTimeoutMs: options.flushTimeoutMs ?? 10_000,
      requestTimeoutMs: options.requestTimeoutMs ?? 3_000,
      sampleIntervalMs: options.sampleIntervalMs ?? 10_000,
    };
    this.artifactKinds = artifactKinds(options.artifacts, setting('ARTIFACTS'));
    this.artifactsTimeoutMs = options.artifactsTimeoutMs ?? Number(setting('ARTIFACTS_TIMEOUT_MS') ?? 30_000);
    this.traceOptions = {
      redactTraces: options.redactTraces ?? setting('REDACT_TRACES') !== '0',
      keepSource: options.traceSource ?? setting('TRACE_SOURCE') === '1',
    };
    const custom = options.redact ?? [];
    this.redaction = {
      values: [...secretEnvValues(process.env), ...custom.filter((r): r is string => typeof r === 'string')],
      patterns: [...custom.filter((r): r is RegExp => r instanceof RegExp), ...parseRedactPatterns(setting('REDACT'))],
    };
  }

  printsToStdio(): boolean {
    return false;
  }

  onBegin(config: FullConfig, suite: Suite): void {
    this.safe('onBegin', () => {
      const ci = detectCi();
      this.runKey = ci.runKey;
      this.shardIndex = config.shard?.current ?? 1;
      this.shardTotal = config.shard?.total ?? 1;

      const configDir = config.configFile ? path.dirname(config.configFile) : config.rootDir;
      // Paths are relative to the repo root (e.g. apps/web/tests/login.spec.ts): unique across the
      // configs of a monorepo, so test keys never collide (ADR-018). Fallback: the config directory.
      this.rootDir = gitTopLevel(configDir) ?? configDir;
      const configFile = config.configFile ? this.relative(config.configFile) : undefined;

      // Job identity: same for every shard of one CI job, different for matrix siblings and configs.
      const selection = selectionArgs();
      this.jobId = createHash('sha1')
        .update([configFile ?? '', selection.projects.join(','), selection.filters.join(' '), setting('JOB') ?? ''].join('|'))
        .digest('hex')
        .slice(0, 12);

      const tests = suite.allTests().map((t) => this.ref(t));
      const planProjects = selection.projects.length
        ? selection.projects
        : [...new Set(tests.map((t) => t.project))].filter(Boolean).sort();

      const spoolDir = this.opts.spoolDir ?? path.join(configDir, '.turnsignal');
      Spool.cleanupOld(spoolDir);
      this.spool = new Spool(spoolDir, this.runKey, this.shardIndex, this.executionId);

      if (this.opts.apiUrl && this.opts.token) {
        this.sender = new Sender({
          apiUrl: this.opts.apiUrl,
          token: this.opts.token,
          runKey: this.runKey,
          executionId: this.executionId,
          jobId: this.jobId,
          shardIndex: this.shardIndex,
          shardTotal: this.shardTotal,
          requestTimeoutMs: this.opts.requestTimeoutMs,
          log: (m) => this.log(m),
        });
        this.timers.push(setInterval(() => void this.sender?.pump(), SEND_TICK_MS));
        if (this.artifactKinds.size) {
          this.uploader = new ArtifactUploader({
            apiUrl: this.opts.apiUrl,
            token: this.opts.token,
            requestTimeoutMs: Math.max(this.opts.requestTimeoutMs, 10_000),
            redactTraces: this.traceOptions.redactTraces,
            traceRedaction: { ...this.redaction, keepSource: this.traceOptions.keepSource },
            pendingFile: this.spool.filePath.replace(/\.ndjson$/, PENDING_SUFFIX),
            log: (m) => this.log(m),
          });
        }
      } else {
        this.log(`TURNSIGNAL_TOKEN not set; saving results to ${this.spool.filePath} only.`);
      }

      if (this.artifactKinds.size) this.pendingFile = this.spool.filePath.replace(/\.ndjson$/, PENDING_SUFFIX);
      const git = detectGit(configDir, ci);
      // Commit author is personal data: opt out with TURNSIGNAL_SEND_AUTHOR=0 (data minimization).
      if (setting('SEND_AUTHOR') === '0') delete git.author;
      this.emit({
        type: 'run_started',
        ci: { provider: ci.provider, buildId: ci.buildId, buildUrl: ci.buildUrl },
        git,
        playwrightVersion: config.version,
        reporterVersion: REPORTER_VERSION,
        workers: config.workers,
        projects: config.projects.map((p) => p.name),
        hostname: os.hostname(),
        configFile,
        planProjects,
        jobName: setting('JOB'),
      });

      // The plan lets the server list tests that never reported (crash, OOM, kill).
      for (let i = 0; i * PLAN_CHUNK < tests.length; i++) {
        this.emit({ type: 'run_plan', chunk: i, tests: tests.slice(i * PLAN_CHUNK, (i + 1) * PLAN_CHUNK) });
      }

      this.sample();
      const sampler = setInterval(() => this.sample(), this.opts.sampleIntervalMs);
      this.timers.push(sampler);
      for (const t of this.timers) t.unref();
    });
  }

  onTestBegin(test: TestCase, result: TestResult): void {
    this.safe('onTestBegin', () => {
      this.emit({
        type: 'test_started',
        testKey: this.ref(test).testKey,
        attempt: result.retry,
        workerIndex: result.workerIndex,
      });
    });
  }

  onTestEnd(test: TestCase, result: TestResult): void {
    this.safe('onTestEnd', () => {
      this.emit({
        type: 'test_finished',
        test: this.ref(test),
        attempt: result.retry,
        status: result.status,
        expectedStatus: test.expectedStatus,
        durationMs: Math.max(0, result.duration),
        workerIndex: result.workerIndex,
        errors: result.errors.map((e) => this.error(e)),
        annotations: test.annotations.map((a) => ({
          type: a.type,
          description: a.description === undefined ? undefined : this.redact(a.description),
        })),
        attachments: result.attachments.map((a) => ({
          name: a.name,
          contentType: a.contentType,
          path: a.path ? this.relative(a.path) : undefined,
        })),
      });
      this.queueArtifacts(test, result);
    });
  }

  /** Screenshots, videos and traces of this attempt: uploaded in the background (ADR-029). */
  private queueArtifacts(test: TestCase, result: TestResult): void {
    if (!this.artifactKinds.size) return;
    const ref = this.ref(test);
    for (const a of result.attachments) {
      const kind = classifyAttachment(a);
      if (!kind || !this.artifactKinds.has(kind) || !a.path) continue;
      const job: ArtifactJob = {
        runKey: this.runKey,
        executionId: this.executionId,
        jobId: this.jobId,
        shardIndex: this.shardIndex,
        shardTotal: this.shardTotal,
        testKey: ref.testKey,
        attempt: result.retry,
        status: result.status,
        kind,
        name: path.basename(a.path),
        contentType: a.contentType,
        path: a.path,
      };
      if (this.uploader) this.uploader.add(job);
      else if (this.pendingFile) {
        // No token/API in this process: record it so `turnsignal upload` can send it later.
        try {
          appendFileSync(this.pendingFile, JSON.stringify({ job }) + '\n');
        } catch {
          // best effort
        }
      }
    }
  }

  onError(error: TestError): void {
    this.safe('onError', () => this.emit({ type: 'global_error', error: this.error(error) }));
  }

  async onEnd(result: FullResult): Promise<void> {
    try {
      this.emit({ type: 'run_finished', status: result.status, durationMs: Math.max(0, result.duration) });
      for (const t of this.timers) clearInterval(t);
      if (this.sender) {
        const [delivered, artifactsDone] = await Promise.all([
          this.sender.flush(this.opts.flushTimeoutMs),
          this.uploader ? this.uploader.flush(this.artifactsTimeoutMs) : Promise.resolve(true),
        ]);
        if (this.uploader && !artifactsDone) {
          this.log(
            `${this.uploader.pending || 'some'} artifact upload(s) not finished; ` +
              'run `npx turnsignal upload` in an always-run step (or use `npx turnsignal run -- …`) to send them.',
          );
        }
        if (delivered && artifactsDone) {
          this.spool?.markUploaded();
          if (this.pendingFile && existsSync(this.pendingFile)) {
            try {
              renameSync(this.pendingFile, `${this.pendingFile}.uploaded`);
            } catch {
              // Harmless: `turnsignal upload` skips jobs already marked done.
            }
          }
        } else {
          this.spool?.close();
          const s = this.sender.stats;
          this.log(
            `could not deliver ${s.pending || 'some'} events (${s.lastError ?? 'timeout'}). ` +
              `Run \`npx turnsignal upload\` in an always-run CI step to recover them from ${this.spool?.filePath}.`,
          );
        }
      } else {
        this.spool?.close();
      }
    } catch (err) {
      this.log(`internal error in onEnd (ignored): ${String(err)}`);
    }
    // Deliberately return nothing: Playwright's own status decides the exit code.
  }

  // --- helpers ---------------------------------------------------------------------------------

  private emit(payload: EventPayload): void {
    const event: ReporterEvent = { id: randomUUID(), seq: this.seq++, ts: new Date().toISOString(), payload };
    this.spool?.append({
      runKey: this.runKey,
      executionId: this.executionId,
      jobId: this.jobId,
      shardIndex: this.shardIndex,
      shardTotal: this.shardTotal,
      event,
    });
    this.sender?.enqueue(event);
  }

  private sample(): void {
    this.safe('sample', () => {
      this.emit({
        type: 'resource_sample',
        freeMemMb: Math.round(os.freemem() / MB),
        totalMemMb: Math.round(os.totalmem() / MB),
        rssMb: Math.round(process.memoryUsage().rss / MB),
      });
    });
  }

  private ref(test: TestCase): TestRef {
    const cached = this.refs.get(test);
    if (cached) return cached;
    const titles: string[] = [];
    let project = '';
    for (let s: Suite | undefined = test.parent; s; s = s.parent) {
      if (s.type === 'describe') titles.unshift(s.title);
      if (s.type === 'project') project = s.title;
    }
    titles.push(test.title);
    const file = this.relative(test.location.file);
    const ref: TestRef = {
      testKey: computeTestKey(project, file, titles),
      file,
      titlePath: titles,
      project,
      line: test.location.line,
    };
    this.refs.set(test, ref);
    return ref;
  }

  private error(e: TestError): TestErrorInfo {
    return {
      message: this.redact(stripAnsi(e.message ?? e.value ?? 'Unknown error')).slice(0, 10_000),
      stack: e.stack ? this.redact(stripAnsi(e.stack)).slice(0, 20_000) : undefined,
      location: e.location
        ? { file: this.relative(e.location.file), line: e.location.line, column: e.location.column }
        : undefined,
      snippet: e.snippet ? this.redact(stripAnsi(e.snippet)).slice(0, 5_000) : undefined,
    };
  }

  private redact(text: string): string {
    return redactSecrets(text, this.redaction);
  }

  private relative(file: string): string {
    return path.relative(this.rootDir, file).replace(/\\/g, '/');
  }

  private safe(where: string, fn: () => void): void {
    try {
      fn();
    } catch (err) {
      this.log(`internal error in ${where} (ignored): ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private log(msg: string): void {
    // Always visible for actionable warnings; the reporter itself stays quiet otherwise.
    process.stderr.write(`[turnsignal] ${msg}\n`);
  }
}
