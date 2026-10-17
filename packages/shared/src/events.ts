import { z } from 'zod';

/** A string that is truncated (never rejected) above `max` characters: old reporters must not lose batches. */
const capped = (max: number) => z.string().transform((s) => (s.length > max ? s.slice(0, max) : s));

/**
 * Wire format between the reporter/CLI and the ingest API.
 * Versioned via the URL (/v1). Additive changes only; see memory-bank/06-data-model.md.
 */

export const TestStatus = z.enum(['passed', 'failed', 'timedOut', 'skipped', 'interrupted']);
export type TestStatus = z.infer<typeof TestStatus>;

export const TestRef = z.object({
  testKey: z.string().min(1),
  file: capped(1_000),
  titlePath: z.array(capped(1_000)).max(50),
  project: capped(200),
  line: z.number().int().optional(),
});
export type TestRef = z.infer<typeof TestRef>;

export const TestErrorInfo = z.object({
  message: capped(10_000),
  stack: capped(20_000).optional(),
  location: z.object({ file: z.string(), line: z.number(), column: z.number() }).optional(),
  snippet: capped(5_000).optional(),
});
export type TestErrorInfo = z.infer<typeof TestErrorInfo>;

const RunStarted = z.object({
  type: z.literal('run_started'),
  ci: z.object({
    provider: z.string(),
    buildId: z.string().optional(),
    buildUrl: z.string().optional(),
  }),
  git: z.object({
    branch: z.string().optional(),
    commit: z.string().optional(),
    message: z.string().optional(),
    author: z.string().optional(),
  }),
  playwrightVersion: z.string().optional(),
  reporterVersion: z.string(),
  workers: z.number().int().optional(),
  projects: z.array(z.string()).default([]),
  hostname: z.string().optional(),
  /** Playwright config path relative to the repo root (label for matrix/monorepo jobs). */
  configFile: z.string().optional(),
  /** Distinct Playwright projects that have tests in this execution's plan. */
  planProjects: z.array(z.string()).optional(),
  /** Human job name (TURNSIGNAL_JOB), used as the label when a run has several jobs. */
  jobName: z.string().max(200).optional(),
});

const RunPlan = z.object({
  type: z.literal('run_plan'),
  /** Chunk index; large suites are split into several plan events. */
  chunk: z.number().int().nonnegative(),
  tests: z.array(TestRef),
});

const TestStarted = z.object({
  type: z.literal('test_started'),
  testKey: z.string(),
  attempt: z.number().int().nonnegative(),
  workerIndex: z.number().int().optional(),
});

const TestFinished = z.object({
  type: z.literal('test_finished'),
  test: TestRef,
  attempt: z.number().int().nonnegative(),
  status: TestStatus,
  expectedStatus: TestStatus,
  durationMs: z.number().nonnegative(),
  workerIndex: z.number().int().optional(),
  errors: z.array(TestErrorInfo).default([]),
  annotations: z.array(z.object({ type: capped(200), description: capped(2_000).optional() })).max(50).default([]),
  attachments: z
    .array(z.object({ name: z.string(), contentType: z.string(), path: z.string().optional() }))
    .default([]),
});

const ResourceSample = z.object({
  type: z.literal('resource_sample'),
  freeMemMb: z.number(),
  totalMemMb: z.number(),
  rssMb: z.number(),
});

const GlobalError = z.object({
  type: z.literal('global_error'),
  error: TestErrorInfo,
});

/** Sent by `turnsignal upload` for a spool that never reached run_finished (runner killed / crashed). */
const RunAborted = z.object({
  type: z.literal('run_aborted'),
  reason: z.string().max(500),
});

const RunFinished = z.object({
  type: z.literal('run_finished'),
  status: z.enum(['passed', 'failed', 'timedout', 'interrupted']),
  durationMs: z.number().nonnegative(),
});

export const EventPayload = z.discriminatedUnion('type', [
  RunStarted,
  RunPlan,
  TestStarted,
  TestFinished,
  ResourceSample,
  GlobalError,
  RunFinished,
  RunAborted,
]);
export type EventPayload = z.infer<typeof EventPayload>;

export const ReporterEvent = z.object({
  /** Globally unique id; the server ignores duplicates (idempotent replay). */
  id: z.string().uuid(),
  /** Monotonic per shard, for ordering. */
  seq: z.number().int().nonnegative(),
  ts: z.string().datetime(),
  payload: EventPayload,
});
export type ReporterEvent = z.infer<typeof ReporterEvent>;

export const IngestBatch = z.object({
  runKey: z.string().min(1).max(300),
  /**
   * One reporter process = one execution of a shard. A CI re-run of a shard is a new execution of
   * the same run; the latest execution per shard is authoritative (ADR-015). Optional for v1 compat.
   */
  executionId: z.string().min(1).max(100).optional(),
  /**
   * Identifies a CI job within a run: matrix siblings (e.g. chromium vs firefox) and different
   * Playwright configs are separate jobs whose results are combined; only executions of the same
   * job + shard supersede each other (ADR-018). Optional for v1 compat.
   */
  jobId: z.string().min(1).max(100).optional(),
  /** 1-based shard index, 1 when not sharded. */
  shardIndex: z.number().int().positive(),
  shardTotal: z.number().int().positive(),
  events: z.array(ReporterEvent).max(1000),
});
export type IngestBatch = z.infer<typeof IngestBatch>;

/** One line of the local spool file (NDJSON). */
export const SpoolLine = z.object({
  runKey: z.string(),
  executionId: z.string().optional(),
  jobId: z.string().optional(),
  shardIndex: z.number().int().positive(),
  shardTotal: z.number().int().positive(),
  event: ReporterEvent,
});
export type SpoolLine = z.infer<typeof SpoolLine>;

export type EventOf<T extends EventPayload['type']> = Extract<EventPayload, { type: T }>;
