import { readFileSync, appendFileSync, existsSync } from 'node:fs';

/** The subset of the API's run report the comment needs (kept local: the CLI must not depend on the server). */
export interface CommentReport {
  url: string;
  status: 'running' | 'passed' | 'failed' | 'incomplete';
  run: { branch: string | null; commitSha: string | null; defaultBranch: string };
  counts: { total: number; passed: number; failed: number; flaky: number; skipped: number; missing: number; queued: number };
  verdict: { tone: 'good' | 'bad' | 'warn' | 'info'; headline: string; lines: string[] };
  tests: {
    testKey?: string;
    jobId?: string;
    /** Element id of the test on the run page (API 0.6+). */
    anchor?: string;
    titlePath: string[];
    file: string;
    line: number | null;
    outcome: string;
    context?: 'new' | 'also-on-main' | 'known-flaky' | 'no-baseline' | 'quarantined';
    /** API 0.6+: set when someone quarantined the test (report-only, CI outcome unchanged). */
    quarantine?: { reason: string; owner: string | null; expiresAt: string; active: boolean };
    failureKind?: 'crash' | 'timeout' | 'error';
    reason?: string;
    attempts: { errors: { message: string }[] }[];
  }[];
  /** Screenshots/videos/traces (API 0.3+). The links need a signed-in member of the organization. */
  artifacts?: Evidence[];
  /** Against the latest default-branch run (API 0.5+). */
  compare?: {
    fixed: Plain[];
    /** `baseMs` = the test's usual time on the default branch; `samples` (API 0.6+) = runs it's the median of. */
    slower: (Plain & { durationMs: number; baseMs: number; samples?: number })[];
  };
}

type Plain = { titlePath: string[]; file: string; line: number | null };

type Evidence = { testKey: string; jobId: string; attempt: number; kind: string; url: string };

export const MARKER = '<!-- turnsignal -->';
/** Comments posted before the rename are updated in place instead of duplicated. */
const LEGACY_MARKERS = ['<!-- reportee -->'];
const MAX_ITEMS = 10;

/** Escape text for GitHub markdown so test titles and errors can't break the layout. */
export function md(text: string): string {
  return text.replace(/[\\`*_{}[\]<>|#]/g, (c) => `\\${c}`).replace(/\r?\n/g, ' ');
}

const ICON = { good: '✅', bad: '❌', warn: '⚠️', info: '⏳' } as const;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function firstError(t: CommentReport['tests'][number]): string | undefined {
  for (let i = t.attempts.length - 1; i >= 0; i--) {
    const m = t.attempts[i]!.errors[0]?.message;
    if (m) return m.split('\n')[0]!.slice(0, 200);
  }
  return undefined;
}

/** " · Open trace · Video · Screenshot" links for the test's last recorded attempt. */
function evidence(t: CommentReport['tests'][number], artifacts: Evidence[]): string {
  const mine = t.testKey ? artifacts.filter((a) => a.testKey === t.testKey && a.jobId === t.jobId) : [];
  if (!mine.length) return '';
  const last = Math.max(...mine.map((a) => a.attempt));
  const link = (kind: string, label: string) => {
    const a = mine.find((x) => x.attempt === last && x.kind === kind);
    return a ? `[${label}](${a.url})` : '';
  };
  const links = [link('trace', 'Open trace'), link('video', 'Video'), link('screenshot', 'Screenshot')].filter(Boolean);
  return links.length ? ` · ${links.join(' · ')}` : '';
}

function item(t: CommentReport['tests'][number], detail?: string, artifacts: Evidence[] = [], reportUrl?: string): string {
  const where = `${t.file}${t.line ? `:${t.line}` : ''}`;
  const title = md(t.titlePath.join(' › '));
  const name = reportUrl && t.anchor && /^t-[\w-]+$/.test(t.anchor) ? `[${title}](${reportUrl}#${t.anchor})` : title;
  return `- **${name}** (\`${where.replace(/`/g, '')}\`)${evidence(t, artifacts)}${detail ? `<br>${md(detail)}` : ''}`;
}

function section(
  title: string,
  tests: CommentReport['tests'],
  detail: (t: CommentReport['tests'][number]) => string | undefined,
  artifacts: Evidence[] = [],
  reportUrl?: string,
): string[] {
  if (!tests.length) return [];
  const shown = tests.slice(0, MAX_ITEMS).map((t) => item(t, detail(t), artifacts, reportUrl));
  const more = tests.length > MAX_ITEMS ? [`- …and ${tests.length - MAX_ITEMS} more in the full report`] : [];
  return ['', `**${title} (${tests.length})**`, ...shown, ...more];
}

const quarantineDetail = (t: CommentReport['tests'][number]): string | undefined =>
  t.quarantine
    ? `Quarantined until ${t.quarantine.expiresAt.slice(0, 10)}${t.quarantine.owner ? `, owner ${t.quarantine.owner}` : ''}: ${t.quarantine.reason}`
    : firstError(t);

/** Fixed / slower lists: tests without attempts or evidence. */
function plainSection<T extends Plain>(title: string, tests: T[], detail: (t: T) => string | undefined): string[] {
  if (!tests.length) return [];
  const shown = tests.slice(0, MAX_ITEMS).map((t) => {
    const where = `${t.file}${t.line ? `:${t.line}` : ''}`;
    const d = detail(t);
    return `- **${md(t.titlePath.join(' › '))}** (\`${where.replace(/`/g, '')}\`)${d ? ` · ${md(d)}` : ''}`;
  });
  const more = tests.length > MAX_ITEMS ? [`- …and ${tests.length - MAX_ITEMS} more in the full report`] : [];
  return ['', `**${title} (${tests.length})**`, ...shown, ...more];
}

/** Markdown body of the sticky PR comment. Answer first; every item says why. */
export function renderComment(r: CommentReport): string {
  const failed = r.tests.filter((t) => t.outcome === 'failed');
  const byCtx = (c: string) => failed.filter((t) => (t.context ?? 'no-baseline') === c);
  const kind = (t: CommentReport['tests'][number]) =>
    t.failureKind === 'crash' ? 'Crash: ' : t.failureKind === 'timeout' ? 'Timeout: ' : '';

  const c = r.counts;
  const tally = [
    c.failed && `${c.failed} failed`,
    c.missing && `${c.missing} missing`,
    c.flaky && `${c.flaky} flaky`,
    `${c.passed} passed`,
    c.skipped && `${c.skipped} skipped`,
  ]
    .filter(Boolean)
    .join(' · ');

  return [
    MARKER,
    `### ${ICON[r.verdict.tone]} ${md(r.verdict.headline)}`,
    ...r.verdict.lines.map((l) => `- ${md(l)}`),
    ...section('New failures: likely caused by this change', byCtx('new'), (t) => `${kind(t)}${firstError(t) ?? ''}`, r.artifacts, r.url),
    ...section('Failures without history', byCtx('no-baseline'), (t) => `${kind(t)}${firstError(t) ?? ''}`, r.artifacts, r.url),
    ...section('Known flaky tests that failed', byCtx('known-flaky'), (t) => `${kind(t)}${firstError(t) ?? ''}`, r.artifacts, r.url),
    ...section(`Also failing on ${r.run.defaultBranch}`, byCtx('also-on-main'), (t) => firstError(t), r.artifacts, r.url),
    ...section('Quarantined tests that failed (not counted as new)', byCtx('quarantined'), quarantineDetail, r.artifacts, r.url),
    ...section('Missing: never reported a result', r.tests.filter((t) => t.outcome === 'missing'), (t) => t.reason, [], r.url),
    ...section('Flaky', r.tests.filter((t) => t.outcome === 'flaky'), (t) => t.reason, r.artifacts, r.url),
    ...plainSection(`Fixed since ${r.run.defaultBranch}`, r.compare?.fixed ?? [], () => undefined),
    ...plainSection(`Slower than ${r.run.defaultBranch}`, r.compare?.slower ?? [], (t) => `${t.samples ? 'usually ' : ''}${(t.baseMs / 1000).toFixed(1)} s → ${(t.durationMs / 1000).toFixed(1)} s`),
    '',
    `${tally} · [Open the full report](${r.url})`,
    ...poweredBy(r.url),
  ].join('\n');
}

/** Hosted only: a small attribution line, so people who see the verdict can find TurnSignal (ADR-050). */
const HOSTED_APP = 'https://app.turnsignal.ai';
export function isHostedUrl(url: string): boolean {
  return url === HOSTED_APP || url.startsWith(`${HOSTED_APP}/`);
}
function poweredBy(reportUrl: string): string[] {
  return isHostedUrl(reportUrl) ? ['', '<sub>Verdict by [TurnSignal for Playwright](https://turnsignal.ai/?ref=pr-comment)</sub>'] : [];
}

export interface GitHubTarget {
  apiUrl: string;
  repo: string;
  token: string;
  prNumber: number;
}

/**
 * Creates the sticky comment, or updates it if one with our marker already exists. With
 * `createIfMissing: false` an existing comment is updated but no new one is posted.
 */
export async function upsertPrComment(
  gh: GitHubTarget,
  body: string,
  opts: { markers?: string[]; createIfMissing?: boolean } = {},
): Promise<'created' | 'updated' | 'unchanged'> {
  const markers = opts.markers ?? [MARKER, ...LEGACY_MARKERS];
  const headers = {
    authorization: `Bearer ${gh.token}`,
    accept: 'application/vnd.github+json',
    'content-type': 'application/json',
    'user-agent': 'turnsignal-cli',
  };
  const base = `${gh.apiUrl.replace(/\/$/, '')}/repos/${gh.repo}`;
  for (let page = 1; page <= 10; page++) {
    const res = await fetch(`${base}/issues/${gh.prNumber}/comments?per_page=100&page=${page}`, { headers });
    if (!res.ok) throw new GitHubError(res.status, await res.text());
    const comments = (await res.json()) as { id: number; body?: string }[];
    const mine = comments.find((c) => markers.some((m) => c.body?.includes(m)));
    if (mine) {
      const upd = await fetch(`${base}/issues/comments/${mine.id}`, { method: 'PATCH', headers, body: JSON.stringify({ body }) });
      if (!upd.ok) throw new GitHubError(upd.status, await upd.text());
      return 'updated';
    }
    if (comments.length < 100) break;
  }
  if (opts.createIfMissing === false) return 'unchanged';
  const created = await fetch(`${base}/issues/${gh.prNumber}/comments`, { method: 'POST', headers, body: JSON.stringify({ body }) });
  if (!created.ok) throw new GitHubError(created.status, await created.text());
  return 'created';
}

export class GitHubError extends Error {
  constructor(
    readonly status: number,
    body: string,
  ) {
    super(`GitHub API HTTP ${status}: ${body.slice(0, 200)}`);
  }
}

/** PR number from the GitHub Actions event payload (pull_request / pull_request_target events). */
export function prNumberFromEvent(eventPath: string | undefined): number | undefined {
  if (!eventPath || !existsSync(eventPath)) return undefined;
  try {
    const event = JSON.parse(readFileSync(eventPath, 'utf8')) as { pull_request?: { number?: number }; number?: number };
    return event.pull_request?.number ?? undefined;
  } catch {
    return undefined;
  }
}

export interface CommentOptions {
  apiUrl: string;
  token: string;
  runKey: string;
  /** Wait for the run to finish (the last shard's final batch may still be processing). */
  waitMs?: number;
  env?: Record<string, string | undefined>;
  log?: (msg: string) => void;
}

export interface CommentOutcome {
  posted: 'created' | 'updated' | 'skipped';
  reason?: string;
  summaryWritten: boolean;
  body?: string;
}

async function fetchReport(apiUrl: string, token: string, runKey: string): Promise<CommentReport | null> {
  const res = await fetch(`${apiUrl.replace(/\/$/, '')}/v1/run-by-key?key=${encodeURIComponent(runKey)}`, {
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(15_000),
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`TurnSignal API HTTP ${res.status}`);
  return (await res.json()) as CommentReport;
}

/** Fetch the run's verdict and publish it as a PR comment and/or job summary. Never throws. */
export async function publishComment(opts: CommentOptions): Promise<CommentOutcome> {
  const env = opts.env ?? process.env;
  const log = opts.log ?? (() => {});
  const deadline = Date.now() + (opts.waitMs ?? 60_000);
  let report: CommentReport | null = null;
  try {
    for (;;) {
      report = await fetchReport(opts.apiUrl, opts.token, opts.runKey);
      if ((report && report.status !== 'running') || Date.now() >= deadline) break;
      await new Promise((r) => setTimeout(r, 3000));
    }
  } catch (err) {
    return { posted: 'skipped', reason: `could not load the run: ${err instanceof Error ? err.message : String(err)}`, summaryWritten: false };
  }
  if (!report) return { posted: 'skipped', reason: `no run found for ${opts.runKey}`, summaryWritten: false };

  return publishMarkdown(renderComment(report), { marker: MARKER, legacyMarkers: LEGACY_MARKERS, env, log });
}

/**
 * Writes a sticky-comment body to the GitHub job summary and the pull request (when running for a
 * PR with a token). Never throws: every problem becomes a `skipped` reason.
 */
export async function publishMarkdown(
  body: string,
  opts: { marker: string; legacyMarkers?: string[]; createIfMissing?: boolean; env?: Record<string, string | undefined>; log?: (msg: string) => void },
): Promise<CommentOutcome> {
  const env = opts.env ?? process.env;
  const log = opts.log ?? (() => {});
  let summaryWritten = false;
  if (env.GITHUB_STEP_SUMMARY) {
    try {
      appendFileSync(env.GITHUB_STEP_SUMMARY, body.replace(opts.marker, '') + '\n');
      summaryWritten = true;
    } catch {
      // not fatal
    }
  }

  const prNumber = prNumberFromEvent(env.GITHUB_EVENT_PATH);
  if (!prNumber) return { posted: 'skipped', reason: 'not a pull request event', summaryWritten, body };
  const token = env.GITHUB_TOKEN ?? env.GH_TOKEN;
  if (!token || !env.GITHUB_REPOSITORY) {
    return { posted: 'skipped', reason: 'GITHUB_TOKEN or GITHUB_REPOSITORY not set', summaryWritten, body };
  }
  try {
    const posted = await upsertPrComment(
      { apiUrl: env.GITHUB_API_URL ?? 'https://api.github.com', repo: env.GITHUB_REPOSITORY, token, prNumber },
      body,
      { markers: [opts.marker, ...(opts.legacyMarkers ?? [])], createIfMissing: opts.createIfMissing },
    );
    if (posted === 'unchanged') return { posted: 'skipped', reason: 'nothing to report and no earlier comment to update', summaryWritten, body };
    log(`PR #${prNumber}: comment ${posted}.`);
    return { posted, summaryWritten, body };
  } catch (err) {
    const status = err instanceof GitHubError ? err.status : 0;
    const reason =
      status === 403 || status === 404
        ? 'no permission to comment (fork pull request, or the job lacks `permissions: pull-requests: write`)'
        : err instanceof Error
          ? err.message
          : String(err);
    return { posted: 'skipped', reason, summaryWritten, body };
  }
}
