import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';
import type { IngestBatch, ReporterEvent } from '@reportee/shared';

export interface SenderOptions {
  apiUrl: string;
  token: string;
  runKey: string;
  executionId: string;
  /** CI job identity (ADR-018). */
  jobId?: string;
  shardIndex: number;
  shardTotal: number;
  requestTimeoutMs: number;
  /** Max events per request. */
  batchSize?: number;
  /** Max serialized bytes per request (the API rejects bodies over 10 MB). */
  batchBytes?: number;
  /** Consecutive failures before we stop sending and rely on the spool. */
  maxConsecutiveFailures?: number;
  log?: (msg: string) => void;
}

export type PostResult = { ok: true } | { ok: false; retryable: boolean; reason: string };

type Env = Record<string, string | undefined>;

/** Proxy URL for a target, honoring HTTPS_PROXY / HTTP_PROXY / NO_PROXY (upper or lower case). */
export function proxyFor(target: URL, env: Env = process.env): URL | undefined {
  const noProxy = (env.NO_PROXY ?? env.no_proxy ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const host = target.hostname.toLowerCase();
  if (host === 'localhost' || host === '127.0.0.1' || host === '[::1]') return undefined;
  if (noProxy.some((p) => p === '*' || host === p.replace(/^\./, '') || host.endsWith(p.startsWith('.') ? p : `.${p}`))) {
    return undefined;
  }
  const raw =
    target.protocol === 'https:'
      ? env.HTTPS_PROXY ?? env.https_proxy ?? env.HTTP_PROXY ?? env.http_proxy
      : env.HTTP_PROXY ?? env.http_proxy;
  if (!raw) return undefined;
  try {
    return new URL(raw.includes('://') ? raw : `http://${raw}`);
  } catch {
    return undefined;
  }
}

function proxyAuth(proxy: URL): Record<string, string> {
  if (!proxy.username) return {};
  const creds = `${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`;
  return { 'proxy-authorization': `Basic ${Buffer.from(creds).toString('base64')}` };
}

/** Opens a CONNECT tunnel through an HTTP proxy. Resolves with the raw socket. */
function tunnel(proxy: URL, target: URL, timeoutMs: number): Promise<import('node:net').Socket> {
  return new Promise((resolve, reject) => {
    const port = target.port || (target.protocol === 'https:' ? '443' : '80');
    const req = http.request({
      host: proxy.hostname,
      port: proxy.port || 80,
      method: 'CONNECT',
      path: `${target.hostname}:${port}`,
      headers: { host: `${target.hostname}:${port}`, ...proxyAuth(proxy) },
      agent: false,
      timeout: timeoutMs,
    });
    req.on('connect', (res, socket) => {
      if (res.statusCode === 200) resolve(socket);
      else {
        socket.destroy();
        reject(new Error(`proxy CONNECT failed: HTTP ${res.statusCode}`));
      }
    });
    req.on('timeout', () => req.destroy(new Error(`proxy timed out after ${timeoutMs} ms`)));
    req.on('error', reject);
    req.end();
  });
}

/**
 * A single-use agent whose only connection is the proxy tunnel. Node ignores a request's own
 * `createConnection` whenever an agent is in play, and `agent: false` creates one, so the tunnel has
 * to come from the agent itself. Otherwise Node connects straight to the API (DNS lookup and all) and
 * the proxy is bypassed: behind a proxy-only network nothing was delivered (fixed 2026-10-18).
 * keepAlive off and `connection: close`: nothing is pooled (see postJson).
 */
function tunnelAgent(socket: import('node:net').Socket, servername: string): https.Agent {
  const agent = new https.Agent({ keepAlive: false, maxSockets: 1 });
  (agent as unknown as { createConnection: () => tls.TLSSocket }).createConnection = () => tls.connect({ socket, servername });
  return agent;
}

/**
 * Plain node:http with no connection pooling, NOT global fetch: undici's pooled sockets can still
 * be closing when Playwright calls process.exit(), which aborts Node on Windows (libuv
 * UV_HANDLE_CLOSING assertion) and turns a green run into exit code 127. Never throws.
 */
export function postJson(
  url: string,
  token: string,
  body: unknown,
  timeoutMs: number,
): Promise<{ status: number; text: string } | { error: string }> {
  return new Promise((resolve) => {
    let settled = false;
    // Safety net on top of socket timeouts (e.g. a proxy that accepts but never answers).
    const timer = setTimeout(() => done({ error: `timed out after ${timeoutMs} ms` }), timeoutMs + 1000);
    timer.unref();
    function done(v: { status: number; text: string } | { error: string }) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(v);
    }

    void (async () => {
      try {
        const target = new URL(url);
        const payload = Buffer.from(JSON.stringify(body));
        const headers = {
          'content-type': 'application/json',
          'content-length': String(payload.length),
          authorization: `Bearer ${token}`,
          connection: 'close',
        };
        const proxy = proxyFor(target);
        const onResponse = (res: http.IncomingMessage) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => done({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') }));
          res.on('error', (err) => done({ error: err.message }));
        };

        let req: http.ClientRequest;
        if (proxy && target.protocol === 'https:') {
          const socket = await tunnel(proxy, target, timeoutMs);
          const agent = tunnelAgent(socket, target.hostname);
          req = https.request(target, { method: 'POST', headers, timeout: timeoutMs, agent }, onResponse);
          req.on('close', () => agent.destroy());
        } else if (proxy) {
          // Plain HTTP through a proxy: absolute-form request to the proxy.
          req = http.request(
            {
              host: proxy.hostname,
              port: proxy.port || 80,
              method: 'POST',
              path: target.href,
              headers: { ...headers, host: target.host, ...proxyAuth(proxy) },
              timeout: timeoutMs,
              agent: false,
            },
            onResponse,
          );
        } else {
          req = (target.protocol === 'https:' ? https : http).request(
            target,
            { method: 'POST', agent: false, headers, timeout: timeoutMs },
            onResponse,
          );
        }
        req.on('timeout', () => req.destroy(new Error(`timed out after ${timeoutMs} ms`)));
        req.on('error', (err) => done({ error: err.message }));
        req.end(payload);
      } catch (err) {
        done({ error: err instanceof Error ? err.message : String(err) });
      }
    })();
  });
}

/** POST one batch. Never throws. */
export async function postBatch(
  apiUrl: string,
  token: string,
  batch: IngestBatch,
  timeoutMs: number,
): Promise<PostResult> {
  const res = await postJson(`${apiUrl.replace(/\/$/, '')}/v1/ingest`, token, batch, timeoutMs);
  if ('error' in res) return { ok: false, retryable: true, reason: res.error };
  if (res.status >= 200 && res.status < 300) return { ok: true };
  // 4xx (except 429) will not succeed on retry: bad token or schema. Don't hammer the API.
  const retryable = res.status === 429 || res.status >= 500;
  return { ok: false, retryable, reason: `HTTP ${res.status} ${res.text.slice(0, 200)}` };
}

/**
 * Delivers events to the API in the background: one request in flight, draining continuously
 * while there is a backlog. Fail-open: after repeated failures the circuit opens and we stop
 * trying; everything is still in the spool (ADR-004, ADR-012).
 */
export class Sender {
  private queue: { event: ReporterEvent; bytes: number }[] = [];
  private draining: Promise<void> | null = null;
  private consecutiveFailures = 0;
  private circuitOpen = false;
  private delivered = 0;
  private lastError: string | undefined;
  private readonly batchSize: number;
  private readonly batchBytes: number;
  private readonly maxFailures: number;

  constructor(private readonly opts: SenderOptions) {
    this.batchSize = opts.batchSize ?? 500;
    this.batchBytes = opts.batchBytes ?? 1_000_000;
    this.maxFailures = opts.maxConsecutiveFailures ?? 3;
  }

  enqueue(event: ReporterEvent): void {
    if (this.circuitOpen) return;
    this.queue.push({ event, bytes: Buffer.byteLength(JSON.stringify(event)) });
    // Bounded memory: the spool is the source of truth, so dropping from memory is safe.
    if (this.queue.length > 100_000) this.queue.splice(0, this.queue.length - 100_000);
    if (this.queue.length >= this.batchSize) void this.pump();
  }

  /** Starts draining if not already. Resolves when the queue is empty, the circuit opens, or a send fails. */
  pump(): Promise<void> {
    if (this.draining) return this.draining;
    if (this.circuitOpen || this.queue.length === 0) return Promise.resolve();
    this.draining = (async () => {
      while (!this.circuitOpen && this.queue.length > 0) {
        if (!(await this.sendOne())) break; // on failure, wait for the next tick instead of spinning
      }
    })().finally(() => {
      this.draining = null;
    });
    return this.draining;
  }

  private takeBatch(): ReporterEvent[] {
    const out: ReporterEvent[] = [];
    let bytes = 0;
    for (const item of this.queue) {
      if (out.length >= this.batchSize) break;
      if (out.length > 0 && bytes + item.bytes > this.batchBytes) break;
      out.push(item.event);
      bytes += item.bytes;
    }
    return out;
  }

  private async sendOne(): Promise<boolean> {
    const events = this.takeBatch();
    const result = await postBatch(
      this.opts.apiUrl,
      this.opts.token,
      {
        runKey: this.opts.runKey,
        executionId: this.opts.executionId,
        jobId: this.opts.jobId,
        shardIndex: this.opts.shardIndex,
        shardTotal: this.opts.shardTotal,
        events,
      },
      this.opts.requestTimeoutMs,
    );
    if (result.ok) {
      this.queue.splice(0, events.length);
      this.delivered += events.length;
      this.consecutiveFailures = 0;
      return true;
    }
    this.lastError = result.reason;
    this.consecutiveFailures++;
    if (!result.retryable || this.consecutiveFailures >= this.maxFailures) {
      this.circuitOpen = true;
      this.opts.log?.(
        result.retryable
          ? `API unreachable (${result.reason}); results are kept in the local spool.`
          : `the API did not accept results (${result.reason}); they are kept in the local spool. Your test run is not affected.`,
      );
    }
    return false;
  }

  /** Drain until empty, circuit open, or deadline. Returns true if everything was delivered. */
  async flush(deadlineMs: number): Promise<boolean> {
    let timer: NodeJS.Timeout | undefined;
    const expired = new Promise<void>((r) => {
      timer = setTimeout(r, deadlineMs);
      timer.unref();
    });
    let timedOut = false;
    void expired.then(() => (timedOut = true));
    while (!this.circuitOpen && this.queue.length > 0 && !timedOut) {
      await Promise.race([this.pump(), expired]);
    }
    clearTimeout(timer);
    return !this.circuitOpen && this.queue.length === 0;
  }

  get stats() {
    return {
      delivered: this.delivered,
      pending: this.queue.length,
      circuitOpen: this.circuitOpen,
      lastError: this.lastError,
    };
  }
}

export type PutBody = { buffer: Uint8Array } | { path: string; size: number };

/**
 * Streams a file (or buffer) to a presigned URL with PUT. Same transport rules as postJson: node:http,
 * no pooling, proxy-aware, bounded. `idleTimeoutMs` is the socket inactivity limit, so large files on
 * slow links are fine as long as bytes keep moving. Never throws.
 */
export function putFile(
  url: string,
  headers: Record<string, string>,
  body: PutBody,
  idleTimeoutMs = 30_000,
  totalTimeoutMs = 10 * 60_000,
): Promise<{ status: number } | { error: string }> {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => done({ error: `upload timed out after ${totalTimeoutMs} ms` }), totalTimeoutMs);
    timer.unref();
    function done(v: { status: number } | { error: string }) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(v);
    }
    void (async () => {
      try {
        const target = new URL(url);
        const length = 'buffer' in body ? body.buffer.length : body.size;
        const h = { ...headers, 'content-length': String(length), connection: 'close' };
        const proxy = proxyFor(target);
        const onResponse = (res: http.IncomingMessage) => {
          res.resume(); // drain
          res.on('end', () => done({ status: res.statusCode ?? 0 }));
          res.on('error', (err) => done({ error: err.message }));
        };
        let req: http.ClientRequest;
        if (proxy && target.protocol === 'https:') {
          const socket = await tunnel(proxy, target, idleTimeoutMs);
          const agent = tunnelAgent(socket, target.hostname);
          req = https.request(target, { method: 'PUT', headers: h, timeout: idleTimeoutMs, agent }, onResponse);
          req.on('close', () => agent.destroy());
        } else if (proxy) {
          req = http.request(
            { host: proxy.hostname, port: proxy.port || 80, method: 'PUT', path: target.href, headers: { ...h, host: target.host, ...proxyAuth(proxy) }, timeout: idleTimeoutMs, agent: false },
            onResponse,
          );
        } else {
          req = (target.protocol === 'https:' ? https : http).request(target, { method: 'PUT', agent: false, headers: h, timeout: idleTimeoutMs }, onResponse);
        }
        req.on('timeout', () => req.destroy(new Error(`upload stalled for ${idleTimeoutMs} ms`)));
        req.on('error', (err) => done({ error: err.message }));
        if ('buffer' in body) {
          req.end(body.buffer);
        } else {
          const { createReadStream } = await import('node:fs');
          const stream = createReadStream(body.path);
          stream.on('error', (err) => {
            req.destroy(err);
            done({ error: err.message });
          });
          stream.pipe(req);
        }
      } catch (err) {
        done({ error: err instanceof Error ? err.message : String(err) });
      }
    })();
  });
}
