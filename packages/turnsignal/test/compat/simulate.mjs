#!/usr/bin/env node
// Customer simulation for the published `turnsignal` package (reporter-contract skill, "before publishing").
// Installs the packed tarball into fresh Playwright projects outside any workspace (in a path with spaces)
// and runs them through what a customer's CI can hit: pass/fail/flaky/timeout/worker crash, secrets in
// errors, no token, API down / 401 / 500 / hanging / connection reset, recovery with `turnsignal upload`,
// shards, GitLab/CircleCI/Buildkite/Azure/Jenkins/Bitbucket, an HTTPS API behind a corporate proxy
// (CONNECT, with and without proxy credentials), an ESM project, repeated runs (the Windows exit-127
// regression), and the CLI (doctor, run, analyze, mcp). A stand-in API records what arrives.
// Browser-free by default; BROWSER=1 adds a Chromium test whose screenshot, video and trace must upload.
//
// Usage: TARBALL=path/to/turnsignal-x.y.z.tgz [PW_VERSION=1.45.0|latest] [PM=npm|pnpm|yarn] [REPEAT=10] [BROWSER=1] node simulate.mjs
// PM picks the customer's package manager (pnpm 9 and yarn 1 run through npx, nothing global needed).
// The proxy scenario needs `openssl` on PATH for a throwaway certificate (it is skipped, and says so, without).
// Plain Node 18+ JavaScript, no dependencies. Exit code 0 only if every check passed.
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { connect } from 'node:net';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const TARBALL = path.resolve(process.env.TARBALL ?? process.argv[2] ?? '');
const PW = process.env.PW_VERSION || 'latest';
const PM = process.env.PM || 'npm';
if (!['npm', 'pnpm', 'yarn'].includes(PM)) {
  console.error('PM must be npm, pnpm or yarn.');
  process.exit(2);
}
const REPEAT = Number(process.env.REPEAT || 10);
const KEEP = process.env.KEEP === '1';
const BROWSER = process.env.BROWSER === '1';
const TOKEN = 'tsk_compat_token_0123456789';
const SECRET = 'compat-s3cr3t-value-98765';
const win = process.platform === 'win32';
if (!TARBALL.endsWith('.tgz') || !existsSync(TARBALL)) {
  console.error('Set TARBALL to the packed turnsignal .tgz (npm pack in packages/turnsignal).');
  process.exit(2);
}

// ---------- results ----------
const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok: Boolean(ok), detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
}

// ---------- stand-in API ----------
const api = { mode: 'ok', events: new Map(), batches: [], requests: 0, sockets: new Set(), presigned: [], puts: new Map(), completed: [] };
function handle(req, res) {
  api.requests++;
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const raw = Buffer.concat(chunks);
    const body = raw.toString('utf8');
    const json = (status, obj) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(obj));
    };
    const authed = req.headers.authorization === `Bearer ${TOKEN}`;
    if (req.method === 'GET' && req.url === '/healthz') return json(200, { ok: true });
    if (req.method === 'GET' && req.url === '/v1/whoami')
      return authed ? json(200, { project: 'web', projectId: 'p1', artifacts: { enabled: true, policy: 'failures' } }) : json(401, { error: 'invalid token' });
    // Artifacts: presign hands out upload URLs on this same server (its own host, so HTTPS-behind-proxy
    // uploads go through the proxy too), PUT stores the bytes, complete records what was finished.
    if (req.method === 'POST' && req.url === '/v1/artifacts/presign') {
      if (!authed) return json(401, { error: 'invalid token' });
      const items = JSON.parse(body).items.map((it) => {
        const id = `a${api.presigned.length + 1}`;
        api.presigned.push({ id, ...it });
        const proto = req.socket.encrypted ? 'https' : 'http';
        return { accepted: true, id, url: `${proto}://${req.headers.host}/_put/${id}`, headers: { 'content-type': it.contentType } };
      });
      return json(200, { items });
    }
    if (req.method === 'PUT' && req.url?.startsWith('/_put/')) {
      api.puts.set(req.url.slice(6), raw);
      res.writeHead(200);
      return res.end();
    }
    if (req.method === 'POST' && req.url === '/v1/artifacts/complete') {
      if (!authed) return json(401, { error: 'invalid token' });
      api.completed.push(...JSON.parse(body).ids);
      return json(200, { ok: true });
    }
    if (req.method === 'POST' && req.url === '/v1/ingest') {
      if (api.mode === 'hang') return; // never answers; the socket is destroyed at shutdown
      if (api.mode === 'reset') return req.socket.destroy();
      if (api.mode === '500') return json(500, { error: 'boom' });
      if (api.mode === '401' || !authed) return json(401, { error: 'invalid token' });
      let batch;
      try {
        batch = JSON.parse(body);
      } catch {
        return json(400, { error: 'bad json' });
      }
      api.batches.push({ raw: body, batch });
      const list = api.events.get(batch.runKey) ?? new Map();
      for (const e of batch.events ?? []) list.set(e.id, { ...e, shardIndex: batch.shardIndex, shardTotal: batch.shardTotal });
      api.events.set(batch.runKey, list);
      return json(200, { ok: true, accepted: batch.events?.length ?? 0 });
    }
    json(404, { error: 'not found' });
  });
}
const track = (srv) =>
  srv.on('connection', (s) => {
    api.sockets.add(s);
    s.on('close', () => api.sockets.delete(s));
  });
const server = track(createServer(handle));
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const API_URL = `http://127.0.0.1:${server.address().port}`;
// A port nobody listens on: "API down".
const deadServer = createServer();
await new Promise((r) => deadServer.listen(0, '127.0.0.1', r));
const DEAD_URL = `http://127.0.0.1:${deadServer.address().port}`;
await new Promise((r) => deadServer.close(r));

const eventsOf = (runKey) => [...(api.events.get(runKey)?.values() ?? [])];
const payloads = (runKey, type) => eventsOf(runKey).map((e) => e.payload).filter((p) => p.type === type);

// ---------- projects ----------
const root = mkdtempSync(path.join(tmpdir(), 'ts compat '));
const SPEC = `import { test, expect } from '@playwright/test';

test('passes @pass', async () => {
  expect(1 + 1).toBe(2);
});
test('Ünïcödé 名前 🚀 and a very long title ${'x'.repeat(300)} @pass', async () => {
  expect(true).toBeTruthy();
});
test('skipped @pass', async () => {
  test.skip(true, 'not today');
});
test.fixme('fixme @pass', async () => {});
test.describe('nested group @pass', () => {
  test('inside describe', async () => {
    expect([1, 2]).toContain(2);
  });
});
test('flaky @flaky', async ({}, info) => {
  expect(info.retry).toBe(1);
});
test('fails @fail', async () => {
  expect('real').toBe('bug');
});
test('leaks a secret @secret', async () => {
  throw new Error('token was ' + process.env.MY_API_SECRET);
});
test('times out @timeout', async () => {
  test.setTimeout(1000);
  await new Promise((r) => setTimeout(r, 5000));
});
test('worker crash @crash', async () => {
  process.exit(137);
});
test('real browser fails @browser', async ({ page }) => {
  await page.setContent('<h1>Checkout</h1>');
  await expect(page.locator('h1')).toHaveText('Paid', { timeout: 1000 });
});
`;
// COMPAT_BROWSER: record evidence like a customer would, so failed browser tests have a screenshot,
// a video and a trace to upload.
const CONFIG = `import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests',
  retries: 1,
  workers: 2,
  reporter: [['list'], ['turnsignal']],
  use: process.env.COMPAT_BROWSER ? { screenshot: 'only-on-failure', video: 'retain-on-failure', trace: 'retain-on-failure' } : {},
});
`;

function sh(cmd, args, cwd, env = process.env) {
  // npm/npx are .cmd shims on Windows: they need a shell, so quote arguments with spaces.
  const q = (a) => (win && /[\s&()]/.test(a) ? `"${a}"` : a);
  return spawnSync(win ? `${cmd}.cmd` : cmd, args.map(q), { cwd, env, encoding: 'utf8', shell: win, timeout: 600_000 });
}

function makeProject(name, { esm = false } = {}) {
  const dir = path.join(root, name);
  mkdirSync(path.join(dir, 'tests'), { recursive: true });
  writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: name.replace(/\W+/g, '-').toLowerCase(), private: true, ...(esm ? { type: 'module' } : {}) }, null, 2));
  writeFileSync(path.join(dir, 'playwright.config.ts'), CONFIG);
  writeFileSync(path.join(dir, 'tests', 'app.spec.ts'), SPEC);
  const tarball = `file:${TARBALL.replace(/\\/g, '/')}`;
  const r =
    PM === 'npm'
      ? sh('npm', ['install', '--no-audit', '--no-fund', '--loglevel=error', `@playwright/test@${PW}`, TARBALL], dir)
      : PM === 'pnpm'
        ? sh('npx', ['-y', 'pnpm@9', 'add', `@playwright/test@${PW}`, tarball], dir)
        : sh('npx', ['-y', 'yarn@1', 'add', '--non-interactive', '--no-lockfile', `@playwright/test@${PW}`, tarball], dir);
  check(`${name}: ${PM} install @playwright/test@${PW} + turnsignal tarball`, r.status === 0, r.status === 0 ? '' : (r.stderr || r.stdout || String(r.error)).slice(-400));
  if (r.status !== 0) return undefined;
  const pwVersion = JSON.parse(readFileSync(path.join(dir, 'node_modules/@playwright/test/package.json'), 'utf8')).version;
  return { dir, pwVersion, pwCli: path.join(dir, 'node_modules/@playwright/test/cli.js'), tsCli: path.join(dir, 'node_modules/turnsignal/dist/cli.js') };
}

// A clean CI environment: nothing from the machine running this script leaks in.
let runSeq = 0;
function ciEnv({ provider = 'github', token = TOKEN, apiUrl = API_URL, extra = {} } = {}) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (/^(TURNSIGNAL_|REPORTEE_|GITHUB_|GITLAB_|CI_|CIRCLE|BUILDKITE|JENKINS|BITBUCKET|TF_BUILD|SYSTEM_|BUILD_|RUNNER_|ACTIONS_|HTTPS?_PROXY$|NO_PROXY$|NODE_EXTRA_CA_CERTS$)/i.test(k) || k === 'CI') continue;
    env[k] = v;
  }
  const id = `${Date.now()}${++runSeq}`;
  // Each provider's own variables (from its docs), as its CI would set them.
  const providers = {
    github: { GITHUB_ACTIONS: 'true', GITHUB_RUN_ID: id, GITHUB_RUN_ATTEMPT: '1', GITHUB_REF_NAME: 'main', GITHUB_SHA: `sha${id}`, GITHUB_REPOSITORY: 'acme/web', GITHUB_SERVER_URL: 'https://github.com', GITHUB_JOB: 'tests' },
    gitlab: { GITLAB_CI: 'true', CI_PIPELINE_ID: id, CI_COMMIT_REF_NAME: 'main', CI_COMMIT_SHA: `sha${id}`, CI_JOB_NAME: 'e2e' },
    circleci: { CIRCLECI: 'true', CIRCLE_WORKFLOW_ID: id, CIRCLE_BRANCH: 'main', CIRCLE_SHA1: `sha${id}`, CIRCLE_BUILD_URL: `https://circleci.com/gh/acme/web/${id}` },
    buildkite: { BUILDKITE: 'true', BUILDKITE_BUILD_ID: id, BUILDKITE_BRANCH: 'main', BUILDKITE_COMMIT: `sha${id}`, BUILDKITE_BUILD_URL: `https://buildkite.com/acme/web/builds/${id}` },
    azure: { TF_BUILD: 'True', BUILD_BUILDID: id, BUILD_SOURCEBRANCHNAME: 'main', BUILD_SOURCEVERSION: `sha${id}` },
    jenkins: { JENKINS_URL: 'https://jenkins.acme.example/', BUILD_TAG: id, BUILD_NUMBER: '7', BUILD_URL: `https://jenkins.acme.example/job/web/7/`, GIT_BRANCH: 'origin/main', GIT_COMMIT: `sha${id}` },
    bitbucket: { BITBUCKET_PIPELINE_UUID: `{${id}}`, BITBUCKET_BUILD_NUMBER: '17', BITBUCKET_REPO_FULL_NAME: 'acme/web', BITBUCKET_BRANCH: 'main', BITBUCKET_COMMIT: `sha${id}` },
  };
  Object.assign(env, { CI: 'true' }, providers[provider]);
  if (token) env.TURNSIGNAL_TOKEN = token;
  if (apiUrl) env.TURNSIGNAL_API_URL = apiUrl;
  env.MY_API_SECRET = SECRET;
  Object.assign(env, extra);
  return { env, runKey: `${provider}:${provider === 'bitbucket' ? `{${id}}` : id}` };
}

function run(cmd, args, cwd, env, timeoutMs = 240_000) {
  const started = Date.now();
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, env });
    let out = '';
    child.stdout.on('data', (c) => (out += c));
    child.stderr.on('data', (c) => (out += c));
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.on('close', (status) => {
      clearTimeout(timer);
      resolve({ status, out, ms: Date.now() - started });
    });
  });
}
const pw = (p, grep, env, extra = []) => run(process.execPath, [p.pwCli, 'test', '--grep', grep, ...extra], p.dir, env);
const ts = (p, args, env, opts) => run(process.execPath, [p.tsCli, ...args], p.dir, env, opts);
const spoolText = (p) => {
  const dir = path.join(p.dir, '.turnsignal');
  return existsSync(dir) ? readdirSync(dir).map((f) => readFileSync(path.join(dir, f), 'utf8')).join('\n') : '';
};
const clearSpool = (p) => rmSync(path.join(p.dir, '.turnsignal'), { recursive: true, force: true });

// ---------- scenarios ----------
console.log(`turnsignal compat: node ${process.version} on ${process.platform}/${process.arch}, ${PM}, Playwright ${PW}, project root "${root}"`);
try {
  const p = makeProject('cjs project');
  if (p) {
    console.log(`Playwright ${p.pwVersion}`);

    // 1. Passing suite: exit 0, everything delivered, unicode intact.
    let c = ciEnv();
    let r = await pw(p, '@pass', c.env);
    const okMs = r.ms;
    check('pass: exit code 0', r.status === 0, `got ${r.status}`);
    const started = payloads(c.runKey, 'run_started')[0];
    check('pass: run_started with GitHub provider', started?.ci?.provider === 'github', JSON.stringify(started?.ci ?? null));
    check('pass: run_finished = passed', payloads(c.runKey, 'run_finished')[0]?.status === 'passed');
    const finished = payloads(c.runKey, 'test_finished');
    check('pass: passed and skipped results delivered', finished.filter((t) => t.status === 'passed').length >= 3 && finished.some((t) => t.status === 'skipped'), `${finished.length} results`);
    check('pass: unicode title intact', finished.some((t) => t.test.titlePath.join(' ').includes('Ünïcödé 名前 🚀')));

    // 2. Real failure: exit 1 kept.
    c = ciEnv();
    r = await pw(p, '@fail', c.env);
    check('fail: exit code 1 kept', r.status === 1, `got ${r.status}`);
    check('fail: failed result + run_finished failed', payloads(c.runKey, 'test_finished').some((t) => t.status === 'failed') && payloads(c.runKey, 'run_finished')[0]?.status === 'failed');

    // 3. Flaky: exit 0 (Playwright's default), both attempts delivered.
    c = ciEnv();
    r = await pw(p, '@flaky', c.env);
    const attempts = payloads(c.runKey, 'test_finished').map((t) => `${t.attempt}:${t.status}`).sort();
    check('flaky: exit code 0', r.status === 0, `got ${r.status}`);
    check('flaky: attempt 0 failed, attempt 1 passed', attempts.join(',') === '0:failed,1:passed', attempts.join(','));

    // 4. Timeout.
    c = ciEnv();
    r = await pw(p, '@timeout', c.env);
    check('timeout: exit code 1', r.status === 1, `got ${r.status}`);
    check('timeout: timedOut result delivered', payloads(c.runKey, 'test_finished').some((t) => t.status === 'timedOut'));

    // 5. Worker killed mid-test (OOM-like): Playwright's exit code kept, reporter doesn't hang.
    c = ciEnv();
    r = await pw(p, '@crash', c.env);
    check('worker crash: exit code 1 kept', r.status === 1, `got ${r.status}`);
    check('worker crash: finished in bounded time', r.ms < 120_000, `${r.ms} ms`);
    check('worker crash: run_started delivered', payloads(c.runKey, 'run_started').length === 1);

    // 6. Secrets in errors never leave CI.
    clearSpool(p);
    c = ciEnv();
    r = await pw(p, '@secret', c.env);
    const raw = api.batches.filter((b) => b.batch.runKey === c.runKey).map((b) => b.raw).join('');
    check('secret: exit code 1', r.status === 1, `got ${r.status}`);
    check('secret: error delivered', raw.includes('token was'));
    check('secret: value not sent to the API', !raw.includes(SECRET));
    check('secret: value not in the local spool', !spoolText(p).includes(SECRET));

    // 7. No token: local only, no network, exit untouched.
    clearSpool(p);
    const before = api.requests;
    c = ciEnv({ token: '', apiUrl: '' });
    r = await pw(p, '@pass', c.env);
    check('no token: exit code 0', r.status === 0, `got ${r.status}`);
    check('no token: no request made', api.requests === before);
    check('no token: results saved in .turnsignal/', spoolText(p).includes('run_finished'));

    // 8. Outages: exit code never changes, time stays bounded, `turnsignal upload` recovers everything.
    for (const mode of ['down', '401', '500', 'hang', 'reset']) {
      clearSpool(p);
      api.mode = mode === 'down' ? 'ok' : mode;
      c = ciEnv({ apiUrl: mode === 'down' ? DEAD_URL : API_URL });
      r = await pw(p, '@pass', c.env);
      check(`API ${mode}: exit code 0`, r.status === 0, `got ${r.status}`);
      check(`API ${mode}: bounded delay`, r.ms < okMs + 30_000, `${r.ms} ms vs ${okMs} ms`);
      for (const s of api.sockets) s.destroy();
      api.mode = 'ok';
      const up = await ts(p, ['upload'], { ...c.env, TURNSIGNAL_API_URL: API_URL });
      check(`API ${mode}: \`turnsignal upload\` exit 0`, up.status === 0, `got ${up.status}: ${up.out.slice(-200)}`);
      check(`API ${mode}: run recovered`, payloads(c.runKey, 'run_finished')[0]?.status === 'passed');
      const n = eventsOf(c.runKey).length;
      const again = await ts(p, ['upload'], { ...c.env, TURNSIGNAL_API_URL: API_URL });
      check(`API ${mode}: second upload is a no-op`, again.status === 0 && eventsOf(c.runKey).length === n);
    }

    // 9. Shards of one CI run land on one run key.
    c = ciEnv();
    const [s1, s2] = await Promise.all([pw(p, '@pass', c.env, ['--shard=1/2']), pw(p, '@pass', c.env, ['--shard=2/2'])]);
    const shardIdx = new Set(eventsOf(c.runKey).map((e) => `${e.shardIndex}/${e.shardTotal}`));
    check('shards: both exit 0', s1.status === 0 && s2.status === 0, `${s1.status}, ${s2.status}`);
    check('shards: one run key, shards 1/2 and 2/2', shardIdx.has('1/2') && shardIdx.has('2/2'), [...shardIdx].join(' '));

    // 10. Other CI providers: detected by name, one run key per pipeline, branch and commit from their variables.
    for (const provider of ['gitlab', 'circleci', 'buildkite', 'azure', 'jenkins', 'bitbucket']) {
      c = ciEnv({ provider });
      r = await pw(p, '@pass', c.env);
      const st = payloads(c.runKey, 'run_started')[0];
      check(`${provider}: exit 0, provider and run key`, r.status === 0 && st?.ci?.provider === provider, `got ${r.status}, ${st ? JSON.stringify(st.ci) : `nothing under ${c.runKey}`}`);
      check(`${provider}: commit from its variables`, String(st?.git?.commit ?? '').startsWith('sha'), String(st?.git?.commit));
    }
    // Parallel Bitbucket steps of one pipeline merge into one run.
    c = ciEnv({ provider: 'bitbucket' });
    await Promise.all([pw(p, '@pass', c.env, ['--shard=1/2']), pw(p, '@pass', c.env, ['--shard=2/2'])]);
    const bb = new Set(eventsOf(c.runKey).map((e) => `${e.shardIndex}/${e.shardTotal}`));
    check('bitbucket: parallel steps share one run', bb.has('1/2') && bb.has('2/2'), [...bb].join(' '));

    // 11. Repeated runs: exit code must be 0 every time (Windows exit-127 regression).
    const codes = [];
    for (let i = 0; i < REPEAT; i++) codes.push((await pw(p, '@pass', ciEnv().env)).status);
    check(`repeat: ${REPEAT} runs all exit 0`, codes.every((x) => x === 0), codes.join(','));

    // 12. CLI.
    c = ciEnv();
    r = await ts(p, ['--help'], c.env);
    check('cli --help: exit 0', r.status === 0 && /upload/.test(r.out), `got ${r.status}`);
    r = await ts(p, ['doctor'], c.env);
    check('cli doctor: token valid, API reachable', /Token valid/.test(r.out) && !/✗|FAIL/i.test(r.out.split('\n').filter((l) => /Token valid|API reachable/.test(l)).join('\n')), r.out.slice(-300));
    // The way customers call it with each package manager (exercises the bin shim on Windows).
    const npx =
      PM === 'npm'
        ? sh('npx', ['--no-install', 'turnsignal', '--help'], p.dir, c.env)
        : PM === 'pnpm'
          ? sh('npx', ['-y', 'pnpm@9', 'exec', 'turnsignal', '--help'], p.dir, c.env)
          : sh('npx', ['-y', 'yarn@1', '--silent', 'turnsignal', '--help'], p.dir, c.env);
    check(`cli via ${PM} bin shim: exit 0`, npx.status === 0, `got ${npx.status}: ${(npx.stderr || '').slice(-200)}`);
    r = await ts(p, ['run', '--', process.execPath, p.pwCli, 'test', '--grep', '@fail'], c.env);
    check('cli run: test exit code 1 passed through', r.status === 1, `got ${r.status}`);
    r = await ts(p, ['run', '--', process.execPath, p.pwCli, 'test', '--grep', '@pass'], ciEnv().env);
    check('cli run: exit 0 passed through', r.status === 0, `got ${r.status}`);
    r = await ts(p, ['analyze', 'tests'], c.env);
    check('cli analyze: exit 0 (not strict)', r.status === 0, `got ${r.status}`);

    // 13. MCP server over stdio.
    const mcp = await new Promise((resolve) => {
      const child = spawn(process.execPath, [p.tsCli, 'mcp'], { cwd: p.dir, env: c.env });
      let out = '';
      child.stdout.on('data', (d) => (out += d));
      child.on('close', (status) => resolve({ status, out }));
      child.stdin.write('{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18"}}\n');
      child.stdin.end('{"jsonrpc":"2.0","id":2,"method":"tools/list"}\n');
      setTimeout(() => child.kill(), 20_000);
    });
    const tools = (() => {
      try {
        return JSON.parse(mcp.out.trim().split('\n').find((l) => l.includes('"id":2'))).result.tools.map((t) => t.name);
      } catch {
        return [];
      }
    })();
    check('mcp: 4 tools listed, clean exit', tools.length === 4 && mcp.status === 0, `${tools.join(',')} exit ${mcp.status}`);

    // 14. HTTPS API behind a corporate proxy. The API host only exists inside the proxy (it maps
    // api.compat.test to this machine), so a delivered run proves the CONNECT tunnel was used.
    const tlsDir = path.join(root, 'tls');
    mkdirSync(tlsDir, { recursive: true });
    const keyFile = path.join(tlsDir, 'key.pem');
    const certFile = path.join(tlsDir, 'cert.pem');
    const ssl = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', keyFile, '-out', certFile, '-days', '2', '-subj', '/CN=api.compat.test', '-addext', 'subjectAltName=DNS:api.compat.test'], { encoding: 'utf8', env: { ...process.env, MSYS_NO_PATHCONV: '1' } });
    if (ssl.status !== 0) {
      // In CI the proxy check must run; on a laptop without openssl it is reported as skipped.
      check('proxy: openssl available for a test certificate', !process.env.GITHUB_ACTIONS, `SKIPPED: ${(ssl.stderr || String(ssl.error)).slice(0, 200)}`);
    } else {
      const httpsServer = track(createHttpsServer({ key: readFileSync(keyFile), cert: readFileSync(certFile) }, handle));
      await new Promise((r) => httpsServer.listen(0, '127.0.0.1', r));
      const httpsPort = httpsServer.address().port;
      const tunnels = [];
      const proxy = track(createServer((req, res) => res.writeHead(405).end()));
      proxy.on('connect', (req, client, head) => {
        tunnels.push({ target: req.url, auth: req.headers['proxy-authorization'] ?? null });
        const [host, port] = req.url.split(':');
        if (host !== 'api.compat.test') return client.end('HTTP/1.1 403 Forbidden\r\n\r\n');
        const upstream = connect(Number(port), '127.0.0.1', () => {
          client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
          if (head?.length) upstream.write(head);
          upstream.pipe(client);
          client.pipe(upstream);
        });
        upstream.on('error', () => client.destroy());
        client.on('error', () => upstream.destroy());
      });
      await new Promise((r) => proxy.listen(0, '127.0.0.1', r));
      const PROXY = `127.0.0.1:${proxy.address().port}`;
      const viaProxy = (proxyUrl) => ({ apiUrl: `https://api.compat.test:${httpsPort}`, extra: { HTTPS_PROXY: proxyUrl, NODE_EXTRA_CA_CERTS: certFile } });

      c = ciEnv(viaProxy(`http://${PROXY}`));
      r = await pw(p, '@pass', c.env);
      check('proxy: exit 0', r.status === 0, `got ${r.status}`);
      check('proxy: run delivered through the CONNECT tunnel', payloads(c.runKey, 'run_finished')[0]?.status === 'passed' && tunnels.some((t) => t.target === `api.compat.test:${httpsPort}`), `${tunnels.length} tunnels`);

      const before = tunnels.length;
      c = ciEnv(viaProxy(`http://ci-user:p%40ss@${PROXY}`));
      r = await pw(p, '@pass', c.env);
      const expected = `Basic ${Buffer.from('ci-user:p@ss').toString('base64')}`;
      check('proxy with credentials: exit 0, delivered, Proxy-Authorization sent', r.status === 0 && payloads(c.runKey, 'run_finished').length === 1 && tunnels.slice(before).some((t) => t.auth === expected), tunnels.slice(before).map((t) => t.auth).join(','));

      // API errors behind the proxy, then `turnsignal upload` through the same proxy recovers.
      api.mode = '500';
      c = ciEnv(viaProxy(`http://${PROXY}`));
      clearSpool(p);
      r = await pw(p, '@pass', c.env);
      api.mode = 'ok';
      const up = await ts(p, ['upload'], c.env);
      check('proxy: API error then `turnsignal upload` through the proxy recovers', r.status === 0 && up.status === 0 && payloads(c.runKey, 'run_finished')[0]?.status === 'passed', `run ${r.status}, upload ${up.status}`);

      // A proxy that is down: exit code unchanged, bounded time.
      c = ciEnv(viaProxy(DEAD_URL));
      r = await pw(p, '@pass', c.env);
      check('proxy down: exit 0 in bounded time', r.status === 0 && r.ms < okMs + 30_000, `got ${r.status} in ${r.ms} ms`);
      for (const s of api.sockets) s.destroy();
      httpsServer.close();
      proxy.close();
    }

    // 15. A real browser (BROWSER=1): a failing Chromium test's screenshot, video and trace upload.
    if (BROWSER) {
      const inst = await run(process.execPath, [p.pwCli, 'install', ...(process.platform === 'linux' ? ['--with-deps'] : []), 'chromium'], p.dir, process.env, 900_000);
      check('browser: Chromium installed', inst.status === 0, inst.status === 0 ? '' : inst.out.slice(-300));
      if (inst.status === 0) {
        const before = api.presigned.length;
        c = ciEnv({ extra: { COMPAT_BROWSER: '1' } });
        r = await pw(p, '@browser', c.env);
        const items = api.presigned.slice(before);
        const kinds = new Set(items.map((i) => i.kind));
        check('browser: exit code 1 kept', r.status === 1, `got ${r.status}`);
        check('browser: screenshot, video and trace offered for upload', kinds.has('screenshot') && kinds.has('video') && kinds.has('trace'), [...kinds].join(','));
        check('browser: every file uploaded with content', items.length > 0 && items.every((i) => (api.puts.get(i.id)?.length ?? 0) > 0), `${items.length} files`);
        check('browser: uploads marked complete', items.every((i) => api.completed.includes(i.id)));
        const magic = (kind, prefix) => items.filter((i) => i.kind === kind).every((i) => api.puts.get(i.id)?.subarray(0, prefix.length).equals(Buffer.from(prefix)));
        check('browser: files are real (PNG, ZIP)', magic('screenshot', [0x89, 0x50, 0x4e, 0x47]) && magic('trace', [0x50, 0x4b]));
      }
    }
  }

  // 16. ESM project ("type": "module").
  const e = makeProject('esm project', { esm: true });
  if (e) {
    const c = ciEnv();
    const r = await pw(e, '@pass', c.env);
    check('esm: exit 0 and run delivered', r.status === 0 && payloads(c.runKey, 'run_finished')[0]?.status === 'passed', `got ${r.status}: ${r.status ? r.out.slice(-300) : ''}`);
  }
} catch (err) {
  check('harness did not crash', false, err?.stack ?? String(err));
} finally {
  for (const s of api.sockets) s.destroy();
  server.close();
  if (!KEEP) rmSync(root, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed (node ${process.version}, ${process.platform}, ${PM}, Playwright ${PW})`);
for (const f of failed) console.log(`  FAILED: ${f.name}  ${f.detail}`);
process.exitCode = failed.length ? 1 : 0;
