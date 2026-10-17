import { createInterface } from 'node:readline';
import { REPORTER_VERSION } from '@reportee/shared';

/**
 * `turnsignal mcp`: a Model Context Protocol server over stdio (JSON-RPC 2.0, one message per line)
 * so coding agents (Claude Code, Cursor, Copilot, ...) can ask TurnSignal about CI runs. Read-only,
 * scoped to the project token. stdout carries protocol messages only; diagnostics go to stderr.
 */

const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];

interface Tool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  run: (args: Record<string, unknown>) => Promise<string>;
}

type Json = Record<string, unknown>;
type Api = (path: string) => Promise<Json>;

export function createApi(apiUrl: string, token: string, fetchImpl: typeof fetch = fetch): Api {
  const base = apiUrl.replace(/\/$/, '');
  return async (path) => {
    const res = await fetchImpl(`${base}${path}`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15_000) });
    const body = (await res.json().catch(() => ({}))) as Json;
    if (!res.ok) throw new Error(`TurnSignal API ${res.status}: ${String(body.error ?? res.statusText)}`);
    return body;
  };
}

const str = (v: unknown, max = 300) => (typeof v === 'string' ? v : v == null ? '' : String(v)).slice(0, max);
const int = (v: unknown, dflt: number, min: number, max: number) => {
  const n = Number(v ?? dflt);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.trunc(n))) : dflt;
};

interface RunJson {
  url: string;
  status: string;
  run: { id: string; branch: string | null; commitSha: string | null; startedAt: string; defaultBranch: string; ciBuildUrl?: string | null };
  counts: Record<string, number>;
  verdict: { headline: string; lines: string[] };
  tests: {
    testKey: string;
    jobId: string;
    titlePath: string[];
    file: string;
    line: number | null;
    project: string;
    outcome: string;
    context?: string;
    quarantine?: { reason: string; owner: string | null; expiresAt: string; active: boolean };
    failureKind?: string;
    reason?: string;
    attempts: { status?: string; errors: { message: string; stack?: string; snippet?: string }[] }[];
  }[];
  artifacts?: { testKey: string; jobId: string; attempt: number; kind: string; url: string }[];
  compare?: { baseRunId: string; fixed: { titlePath: string[]; file: string }[]; slower: { titlePath: string[]; file: string; durationMs: number; baseMs: number; samples?: number }[] };
}

/** A run as plain text an agent can act on: verdict, then each failure with its error and evidence. */
export function describeRun(r: RunJson, maxTests = 20): string {
  const out = [
    `${r.verdict.headline}`,
    ...r.verdict.lines.map((l) => `- ${l}`),
    `Run: ${r.url} · status ${r.status} · branch ${r.run.branch ?? '?'} (default ${r.run.defaultBranch}) · commit ${r.run.commitSha?.slice(0, 7) ?? '?'}${r.run.ciBuildUrl ? ` · CI ${r.run.ciBuildUrl}` : ''}`,
    `Counts: ${Object.entries(r.counts).filter(([, n]) => n).map(([k, n]) => `${k} ${n}`).join(', ')}`,
  ];
  const attention = r.tests.filter((t) => t.outcome !== 'passed' && t.outcome !== 'skipped');
  for (const t of attention.slice(0, maxTests)) {
    const label = t.outcome === 'failed' ? `FAILED${t.context ? ` (${t.context})` : ''}${t.failureKind && t.failureKind !== 'error' ? ` [${t.failureKind}]` : ''}` : t.outcome.toUpperCase();
    out.push('', `${label}: ${t.titlePath.join(' › ')}`, `  at ${t.file}${t.line ? `:${t.line}` : ''}${t.project ? ` · project ${t.project}` : ''} · testKey ${t.testKey}`);
    if (t.reason) out.push(`  why: ${t.reason}`);
    const q = t.quarantine;
    if (q)
      out.push(
        q.active
          ? `  quarantined until ${q.expiresAt.slice(0, 10)}${q.owner ? ` (owner ${q.owner})` : ''}: ${q.reason}. Known broken, not a new failure; don't try to fix it as part of this change.`
          : `  quarantine expired on ${q.expiresAt.slice(0, 10)}: ${q.reason}. It counts as a normal failure again.`,
      );
    const last = [...t.attempts].reverse().find((a) => a.errors.length);
    const err = last?.errors[0];
    if (err) {
      out.push(`  error: ${str(err.message, 1500).replace(/\n/g, '\n         ')}`);
      if (err.snippet) out.push(`  snippet:\n${str(err.snippet, 1500).replace(/^/gm, '    ')}`);
    }
    const ev = (r.artifacts ?? []).filter((a) => a.testKey === t.testKey && a.jobId === t.jobId);
    if (ev.length) out.push(`  evidence (needs a signed-in browser): ${ev.map((a) => `${a.kind}#${a.attempt + 1} ${a.url}`).join(' · ')}`);
  }
  if (attention.length > maxTests) out.push('', `…and ${attention.length - maxTests} more; open the run for all of them.`);
  if (!attention.length) out.push('', 'Nothing needs attention in this run.');
  const main = r.run.defaultBranch;
  if (r.compare?.fixed.length) {
    out.push('', `Fixed since the ${main} run ${r.compare.baseRunId}:`, ...r.compare.fixed.slice(0, 20).map((t) => `- ${t.titlePath.join(' › ')} (${t.file})`));
  }
  if (r.compare?.slower.length) {
    const s = (ms: number) => `${(ms / 1000).toFixed(1)} s`;
    out.push(
      '',
      `Slower than usual on ${main}:`,
      ...r.compare.slower.map((t) => `- ${t.titlePath.join(' › ')} (${t.file}): ${t.samples ? `usually ${s(t.baseMs)} (median of ${t.samples} ${main} runs)` : s(t.baseMs)} → ${s(t.durationMs)}`),
    );
  }
  return out.join('\n');
}

export function tools(api: Api): Tool[] {
  return [
    {
      name: 'turnsignal_recent_runs',
      description: 'Recent CI runs of this project, newest first: verdict, status, branch, commit, counts and run id. Use it to find a run to inspect.',
      inputSchema: {
        type: 'object',
        properties: { branch: { type: 'string', description: 'Only runs on this branch' }, limit: { type: 'integer', minimum: 1, maximum: 50, default: 10 } },
      },
      run: async (a) => {
        const q = new URLSearchParams({ limit: String(int(a.limit, 10, 1, 50)) });
        if (a.branch) q.set('branch', str(a.branch, 200));
        const body = (await api(`/v1/runs?${q}`)) as { runs: { run: { id: string; branch: string | null; commitSha: string | null; startedAt: string }; status: string; counts?: Record<string, number>; verdict?: { headline: string } | null; url: string }[] };
        if (!body.runs.length) return 'No runs yet for this project.';
        return body.runs
          .map((r) => `${r.run.id} · ${r.status} · ${r.run.branch ?? '?'} @ ${r.run.commitSha?.slice(0, 7) ?? '?'} · ${r.run.startedAt}\n  ${r.verdict?.headline ?? ''}\n  ${r.url}`)
          .join('\n');
      },
    },
    {
      name: 'turnsignal_run',
      description:
        'One run explained: the verdict, and every failed, flaky or missing test with its file:line, error message, code snippet, whether the failure is new or already on the default branch, and links to its trace/video/screenshot. Pass runId, or runKey (e.g. "github:1234567"), or neither for the latest run.',
      inputSchema: {
        type: 'object',
        properties: { runId: { type: 'string' }, runKey: { type: 'string' }, branch: { type: 'string', description: 'With neither id nor key: the latest run on this branch' } },
      },
      run: async (a) => {
        let id = str(a.runId, 100);
        if (!id && a.runKey) return describeRun((await api(`/v1/run-by-key?key=${encodeURIComponent(str(a.runKey, 300))}`)) as unknown as RunJson);
        if (!id) {
          const q = new URLSearchParams({ limit: '1' });
          if (a.branch) q.set('branch', str(a.branch, 200));
          const latest = (await api(`/v1/runs?${q}`)) as { runs: { run: { id: string } }[] };
          if (!latest.runs[0]) return 'No runs yet for this project.';
          id = latest.runs[0].run.id;
        }
        if (!/^[0-9a-f-]{36}$/i.test(id)) throw new Error('runId must be a run id (UUID) from turnsignal_recent_runs');
        return describeRun((await api(`/v1/runs/${id}`)) as unknown as RunJson);
      },
    },
    {
      name: 'turnsignal_test_history',
      description: "One test's recent results across runs (newest first): outcome, branch, run. Use it to tell a new breakage from a long-flaky test. testKey comes from turnsignal_run.",
      inputSchema: { type: 'object', properties: { testKey: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 } }, required: ['testKey'] },
      run: async (a) => {
        const key = str(a.testKey, 100);
        if (!key) throw new Error('testKey is required');
        const h = (await api(`/v1/tests/${encodeURIComponent(key)}/history?limit=${int(a.limit, 20, 1, 100)}`)) as { test?: { titlePath?: string[]; file?: string }; runs: { outcome: string; branch: string | null; startedAt?: string; runId?: string; error?: string; reason?: string }[] };
        const head = h.test?.titlePath ? `${h.test.titlePath.join(' › ')} (${h.test.file})\n` : '';
        if (!h.runs.length) return `${head}No results for this test yet.`;
        const detail = (r: (typeof h.runs)[number]) => (r.error ? ` · ${str(r.error, 200)}` : r.reason ? ` · ${str(r.reason, 200)}` : '');
        return head + h.runs.map((r) => `${r.startedAt ?? ''} · ${r.branch ?? '?'} · ${r.outcome}${detail(r)}${r.runId ? ` · run ${r.runId}` : ''}`).join('\n');
      },
    },
    {
      name: 'turnsignal_flaky_tests',
      description: 'Tests that were flaky (failed, then passed on retry) in the last N days, most flaky first, with counts.',
      inputSchema: { type: 'object', properties: { days: { type: 'integer', minimum: 1, maximum: 90, default: 14 } } },
      run: async (a) => {
        const body = (await api(`/v1/flaky?days=${int(a.days, 14, 1, 90)}`)) as { days: number; tests: { testKey: string; titlePath?: string[]; file?: string; flaky: number; failed: number; results: number }[] };
        if (!body.tests.length) return `No flaky tests in the last ${body.days} days.`;
        return body.tests
          .map((t) => `${t.titlePath?.join(' › ') ?? t.testKey} (${t.file ?? ''}) · flaky ${t.flaky}, failed ${t.failed} of ${t.results} results · testKey ${t.testKey}`)
          .join('\n');
      },
    },
  ];
}

export interface McpOptions {
  api: Api;
  input?: NodeJS.ReadableStream;
  write?: (line: string) => void;
  log?: (msg: string) => void;
}

/** Runs the stdio server until the input closes. */
export function serveMcp(opts: McpOptions): Promise<void> {
  const write = opts.write ?? ((l: string) => process.stdout.write(l + '\n'));
  const log = opts.log ?? ((m: string) => process.stderr.write(`[turnsignal mcp] ${m}\n`));
  const all = tools(opts.api);
  const reply = (id: unknown, result: unknown) => write(JSON.stringify({ jsonrpc: '2.0', id, result }));
  const fail = (id: unknown, code: number, message: string) => write(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }));

  async function handle(msg: { id?: unknown; method?: string; params?: Json }) {
    const { id, method, params = {} } = msg;
    const isRequest = id !== undefined && id !== null;
    switch (method) {
      case 'initialize': {
        const asked = str(params.protocolVersion, 20);
        return reply(id, {
          protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
          capabilities: { tools: {} },
          serverInfo: { name: 'turnsignal', title: 'TurnSignal for Playwright', version: REPORTER_VERSION },
          instructions: 'Read-only access to this project\'s Playwright CI runs in TurnSignal for Playwright. Start with turnsignal_run (latest run) or turnsignal_recent_runs.',
        });
      }
      case 'ping':
        return reply(id, {});
      case 'tools/list':
        return reply(id, { tools: all.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
      case 'tools/call': {
        const tool = all.find((t) => t.name === params.name);
        if (!tool) return fail(id, -32602, `unknown tool: ${str(params.name, 100)}`);
        try {
          const text = await tool.run((params.arguments as Json) ?? {});
          return reply(id, { content: [{ type: 'text', text }] });
        } catch (err) {
          // Tool errors are results the model can read, not protocol errors.
          return reply(id, { content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }], isError: true });
        }
      }
      default:
        if (isRequest) return fail(id, -32601, `method not found: ${str(method, 100)}`);
        return; // notifications (e.g. notifications/initialized) need no answer
    }
  }

  return new Promise((resolve) => {
    const rl = createInterface({ input: opts.input ?? process.stdin, crlfDelay: Infinity });
    const inflight = new Set<Promise<void>>();
    rl.on('line', (line) => {
      if (!line.trim()) return;
      let msg: { id?: unknown; method?: string; params?: Json };
      try {
        msg = JSON.parse(line);
      } catch {
        return fail(null, -32700, 'parse error');
      }
      const p = handle(msg).catch((err) => log(`internal error: ${String(err)}`));
      inflight.add(p);
      void p.finally(() => inflight.delete(p));
    });
    rl.on('close', () => void Promise.allSettled([...inflight]).then(() => resolve()));
  });
}
