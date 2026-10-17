import { describe, it, expect } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { renderComment, isHostedUrl, publishComment, publishMarkdown, MARKER, md, type CommentReport } from '../src/comment.js';

function report(overrides: Partial<CommentReport> = {}): CommentReport {
  return {
    url: 'https://reportee.example/runs/abc',
    status: 'failed',
    run: { branch: 'feature/x', commitSha: 'abc1234', defaultBranch: 'main' },
    counts: { total: 6, passed: 3, failed: 2, flaky: 1, skipped: 0, missing: 0, queued: 0 },
    verdict: {
      tone: 'bad',
      headline: '2 tests failed.',
      lines: ['1 new failure: passed on the latest main run, fails here. Most likely caused by this change.'],
    },
    tests: [
      {
        titlePath: ['checkout', 'applies discount'],
        file: 'tests/checkout.spec.ts',
        line: 8,
        outcome: 'failed',
        context: 'new',
        attempts: [{ errors: [{ message: 'Expected: 89\nReceived: 99' }] }],
      },
      {
        titlePath: ['uploads avatar'],
        file: 'tests/profile.spec.ts',
        line: 7,
        outcome: 'failed',
        context: 'also-on-main',
        failureKind: 'crash',
        attempts: [{ errors: [{ message: 'worker process exited unexpectedly' }] }],
      },
      {
        titlePath: ['shows <b>toast</b> | now'],
        file: 'tests/checkout.spec.ts',
        line: 14,
        outcome: 'flaky',
        reason: 'Failed on attempt 1 (toast gone), passed on attempt 2.',
        attempts: [],
      },
    ],
    ...overrides,
  };
}

describe('renderComment', () => {
  it('adds the attribution line only for the hosted service (ADR-050)', () => {
    const hosted = renderComment(report({ url: 'https://app.turnsignal.ai/runs/abc' }));
    expect(hosted.trimEnd().endsWith('<sub>Verdict by [TurnSignal for Playwright](https://turnsignal.ai/?ref=pr-comment)</sub>')).toBe(true);
    expect(renderComment(report())).not.toContain('Verdict by');
    expect(renderComment(report({ url: 'https://app.turnsignal.ai.evil.example/runs/abc' }))).not.toContain('Verdict by');
  });

  it('treats only app.turnsignal.ai as the hosted service', () => {
    expect(isHostedUrl('https://app.turnsignal.ai')).toBe(true);
    expect(isHostedUrl('https://app.turnsignal.ai/v1')).toBe(true);
    expect(isHostedUrl('https://app.turnsignal.ai.evil.example')).toBe(false);
    expect(isHostedUrl('https://reports.example.com')).toBe(false);
  });

  it('answers first and explains every item', () => {
    expect(renderComment(report())).toBe(
      [
        MARKER,
        '### ❌ 2 tests failed.',
        '- 1 new failure: passed on the latest main run, fails here. Most likely caused by this change.',
        '',
        '**New failures: likely caused by this change (1)**',
        '- **checkout › applies discount** (`tests/checkout.spec.ts:8`)<br>Expected: 89',
        '',
        '**Also failing on main (1)**',
        '- **uploads avatar** (`tests/profile.spec.ts:7`)<br>worker process exited unexpectedly',
        '',
        '**Flaky (1)**',
        '- **shows \\<b\\>toast\\</b\\> \\| now** (`tests/checkout.spec.ts:14`)<br>Failed on attempt 1 (toast gone), passed on attempt 2.',
        '',
        '2 failed · 1 flaky · 3 passed · [Open the full report](https://reportee.example/runs/abc)',
      ].join('\n'),
    );
  });

  it('caps long lists', () => {
    const many = Array.from({ length: 13 }, (_, i) => ({
      titlePath: [`t${i}`],
      file: 'a.spec.ts',
      line: i,
      outcome: 'failed',
      context: 'new' as const,
      attempts: [],
    }));
    const body = renderComment(report({ tests: many }));
    expect(body).toContain('**New failures: likely caused by this change (13)**');
    expect(body).toContain('- …and 3 more in the full report');
  });

  it('links each test to its card on the run page when the API sends an anchor', () => {
    const r = report();
    r.tests[0]!.anchor = 't-0123456789ab';
    r.tests[1]!.anchor = 'javascript:alert(1)';
    const body = renderComment(r);
    expect(body).toContain('- **[checkout › applies discount](https://reportee.example/runs/abc#t-0123456789ab)** (`tests/checkout.spec.ts:8`)');
    expect(body).toContain('- **uploads avatar** (`tests/profile.spec.ts:7`)');
    expect(body).not.toContain('javascript');
  });

  it('escapes markdown in user text', () => {
    expect(md('a|b *c* [d](e) `f`')).toBe('a\\|b \\*c\\* \\[d\\](e) \\`f\\`');
  });
});

function server(handler: http.RequestListener): Promise<{ url: string; close: () => void }> {
  return new Promise((resolve) => {
    const s = http.createServer(handler).listen(0, '127.0.0.1', () =>
      resolve({ url: `http://127.0.0.1:${(s.address() as AddressInfo).port}`, close: () => s.close() }),
    );
  });
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((r) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => r(b));
  });
}

describe('publishComment', () => {
  it('creates the sticky comment once, then updates it, and writes the job summary', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'reportee-comment-'));
    const eventPath = path.join(dir, 'event.json');
    const summaryPath = path.join(dir, 'summary.md');
    writeFileSync(eventPath, JSON.stringify({ pull_request: { number: 42 } }));
    writeFileSync(summaryPath, '');

    const api = await server((req, res) => {
      expect(req.headers.authorization).toBe('Bearer rpt_x');
      expect(req.url).toBe('/v1/run-by-key?key=github%3A777');
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(report()));
    });
    const calls: string[] = [];
    let stored: { id: number; body: string }[] = [{ id: 1, body: 'unrelated comment' }];
    const gh = await server(async (req, res) => {
      calls.push(`${req.method} ${req.url}`);
      const body = await readBody(req);
      if (req.method === 'GET') return res.writeHead(200).end(JSON.stringify(stored));
      if (req.method === 'POST') {
        stored = [...stored, { id: 2, body: JSON.parse(body).body }];
        return res.writeHead(201).end('{}');
      }
      stored = stored.map((c) => (c.id === 2 ? { ...c, body: JSON.parse(body).body } : c));
      return res.writeHead(200).end('{}');
    });

    const env = {
      GITHUB_EVENT_PATH: eventPath,
      GITHUB_STEP_SUMMARY: summaryPath,
      GITHUB_TOKEN: 'ghs_x',
      GITHUB_REPOSITORY: 'acme/web',
      GITHUB_API_URL: gh.url,
    };
    const first = await publishComment({ apiUrl: api.url, token: 'rpt_x', runKey: 'github:777', waitMs: 0, env });
    const second = await publishComment({ apiUrl: api.url, token: 'rpt_x', runKey: 'github:777', waitMs: 0, env });

    expect(first).toMatchObject({ posted: 'created', summaryWritten: true });
    expect(second).toMatchObject({ posted: 'updated' });
    expect(calls).toEqual([
      'GET /repos/acme/web/issues/42/comments?per_page=100&page=1',
      'POST /repos/acme/web/issues/42/comments',
      'GET /repos/acme/web/issues/42/comments?per_page=100&page=1',
      'PATCH /repos/acme/web/issues/comments/2',
    ]);
    expect(stored.filter((c) => c.body.includes(MARKER))).toHaveLength(1);
    expect(readFileSync(summaryPath, 'utf8')).toContain('### ❌ 2 tests failed.');

    api.close();
    gh.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('a second sticky comment (governance) lives next to the run comment; with nothing to say it only updates', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'reportee-comment-'));
    const eventPath = path.join(dir, 'event.json');
    writeFileSync(eventPath, JSON.stringify({ pull_request: { number: 42 } }));
    let stored: { id: number; body: string }[] = [{ id: 1, body: `${MARKER}\nrun verdict` }];
    const methods: string[] = [];
    const gh = await server(async (req, res) => {
      methods.push(req.method!);
      const body = await readBody(req);
      if (req.method === 'GET') return res.writeHead(200).end(JSON.stringify(stored));
      if (req.method === 'POST') {
        stored = [...stored, { id: 2, body: JSON.parse(body).body }];
        return res.writeHead(201).end('{}');
      }
      stored = stored.map((c) => (req.url!.endsWith(`/${c.id}`) ? { ...c, body: JSON.parse(body).body } : c));
      return res.writeHead(200).end('{}');
    });
    const env = { GITHUB_EVENT_PATH: eventPath, GITHUB_TOKEN: 'ghs_x', GITHUB_REPOSITORY: 'acme/web', GITHUB_API_URL: gh.url };
    const marker = '<!-- turnsignal-governance -->';

    expect(await publishMarkdown(`${marker}\nnothing`, { marker, createIfMissing: false, env })).toMatchObject({ posted: 'skipped', reason: 'nothing to report and no earlier comment to update' });
    expect(await publishMarkdown(`${marker}\n1 weakened`, { marker, env })).toMatchObject({ posted: 'created' });
    expect(await publishMarkdown(`${marker}\nnothing now`, { marker, createIfMissing: false, env })).toMatchObject({ posted: 'updated' });
    expect(stored.map((c) => c.body)).toEqual([`${MARKER}\nrun verdict`, `${marker}\nnothing now`]);
    expect(methods).toEqual(['GET', 'GET', 'POST', 'GET', 'PATCH']);
    gh.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('skips with a clear reason on fork PRs (no permission) and never throws', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'reportee-comment-'));
    const eventPath = path.join(dir, 'event.json');
    writeFileSync(eventPath, JSON.stringify({ pull_request: { number: 7 } }));
    const api = await server((_, res) => res.writeHead(200).end(JSON.stringify(report())));
    const gh = await server((_, res) => res.writeHead(403).end('Resource not accessible by integration'));
    const out = await publishComment({
      apiUrl: api.url,
      token: 'rpt_x',
      runKey: 'github:1',
      waitMs: 0,
      env: { GITHUB_EVENT_PATH: eventPath, GITHUB_TOKEN: 't', GITHUB_REPOSITORY: 'a/b', GITHUB_API_URL: gh.url },
    });
    expect(out.posted).toBe('skipped');
    expect(out.reason).toMatch(/fork pull request/);
    api.close();
    gh.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('reports a missing run and an unreachable API without throwing', async () => {
    const api = await server((_, res) => res.writeHead(404).end('{}'));
    expect(await publishComment({ apiUrl: api.url, token: 't', runKey: 'k', waitMs: 0, env: {} })).toMatchObject({
      posted: 'skipped',
      reason: 'no run found for k',
    });
    api.close();
    const down = await publishComment({ apiUrl: 'http://127.0.0.1:9', token: 't', runKey: 'k', waitMs: 0, env: {} });
    expect(down.posted).toBe('skipped');
    expect(down.reason).toMatch(/could not load the run/);
  });
});

describe('evidence links in the PR comment (ADR-029)', () => {
  it('links the trace, video and screenshot of the last attempt of each failure', () => {
    const r = report();
    r.tests[0]!.testKey = 'k1';
    r.tests[0]!.jobId = 'j';
    r.tests[2]!.testKey = 'k3';
    r.tests[2]!.jobId = 'j';
    r.artifacts = [
      { testKey: 'k1', jobId: 'j', attempt: 0, kind: 'trace', url: 'https://x/artifacts/old/trace' },
      { testKey: 'k1', jobId: 'j', attempt: 1, kind: 'trace', url: 'https://x/artifacts/t1/trace' },
      { testKey: 'k1', jobId: 'j', attempt: 1, kind: 'screenshot', url: 'https://x/artifacts/s1' },
      { testKey: 'k3', jobId: 'j', attempt: 0, kind: 'video', url: 'https://x/artifacts/v3' },
      { testKey: 'k1', jobId: 'other-job', attempt: 2, kind: 'video', url: 'https://x/artifacts/wrong' },
    ];
    const body = renderComment(r);
    expect(body).toContain('[Open trace](https://x/artifacts/t1/trace) · [Screenshot](https://x/artifacts/s1)');
    expect(body).not.toContain('artifacts/old');
    expect(body).not.toContain('artifacts/wrong');
    expect(body).toContain('[Video](https://x/artifacts/v3)');
  });

  it('comments from older servers (no artifacts) are unchanged', () => {
    expect(renderComment(report())).not.toContain('Open trace');
  });
});
