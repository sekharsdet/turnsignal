import { describe, it, expect } from 'vitest';
import http from 'node:http';
import https from 'node:https';
import net, { type AddressInfo } from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { Sender, postJson, proxyFor } from '../src/sender.js';
import type { ReporterEvent } from '@reportee/shared';

const event = (seq: number): ReporterEvent => ({
  id: randomUUID(),
  seq,
  ts: new Date().toISOString(),
  payload: { type: 'resource_sample', freeMemMb: 1, totalMemMb: 2, rssMb: 1 },
});

function server(handler: http.RequestListener): Promise<{ url: string; close: () => void }> {
  return new Promise((resolve) => {
    const s = http.createServer(handler).listen(0, '127.0.0.1', () =>
      resolve({ url: `http://127.0.0.1:${(s.address() as AddressInfo).port}`, close: () => s.close() }),
    );
  });
}

const base = { token: 't', runKey: 'r', executionId: 'e', shardIndex: 1, shardTotal: 1, requestTimeoutMs: 500 };

describe('Sender (fail-open)', () => {
  it('opens the circuit quickly when the API is unreachable', async () => {
    const s = new Sender({ ...base, apiUrl: 'http://127.0.0.1:9' });
    for (let i = 0; i < 10; i++) s.enqueue(event(i));
    const started = Date.now();
    expect(await s.flush(10_000)).toBe(false);
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(s.stats.circuitOpen).toBe(true);
  });

  it('does not retry on 401 (bad token)', async () => {
    let calls = 0;
    const srv = await server((_, res) => {
      calls++;
      res.writeHead(401).end('nope');
    });
    const s = new Sender({ ...base, apiUrl: srv.url });
    s.enqueue(event(0));
    expect(await s.flush(5_000)).toBe(false);
    expect(calls).toBe(1);
    srv.close();
  });

  it('times out a hanging API instead of blocking the run', async () => {
    const srv = await server(() => {
      /* never responds */
    });
    const s = new Sender({ ...base, apiUrl: srv.url, requestTimeoutMs: 200 });
    s.enqueue(event(0));
    const started = Date.now();
    expect(await s.flush(2_000)).toBe(false);
    expect(Date.now() - started).toBeLessThan(3_000);
    srv.close();
  });

  it('delivers in batches', async () => {
    const sizes: number[] = [];
    const srv = await server((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        sizes.push(JSON.parse(body).events.length);
        res.writeHead(200).end('{}');
      });
    });
    const s = new Sender({ ...base, apiUrl: srv.url, batchSize: 4 });
    for (let i = 0; i < 10; i++) s.enqueue(event(i));
    expect(await s.flush(5_000)).toBe(true);
    expect(sizes).toEqual([4, 4, 2]);
    srv.close();
  });

  it('drains a large backlog (30K events) well within the end-of-run flush window', async () => {
    let received = 0;
    let requests = 0;
    const srv = await server((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        requests++;
        const parsed = JSON.parse(body);
        expect(parsed.executionId).toBe('e');
        received += parsed.events.length;
        res.writeHead(200).end('{}');
      });
    });
    const s = new Sender({ ...base, apiUrl: srv.url, requestTimeoutMs: 3000 });
    for (let i = 0; i < 30_000; i++) s.enqueue(event(i));
    const started = Date.now();
    expect(await s.flush(10_000)).toBe(true);
    expect(received).toBe(30_000);
    expect(requests).toBeLessThanOrEqual(61); // batches of up to 500
    expect(Date.now() - started).toBeLessThan(10_000);
    srv.close();
  });

  it('caps batch size by bytes', async () => {
    const sizes: number[] = [];
    const srv = await server((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        sizes.push(JSON.parse(body).events.length);
        res.writeHead(200).end('{}');
      });
    });
    const s = new Sender({ ...base, apiUrl: srv.url, batchBytes: 1000 });
    for (let i = 0; i < 20; i++) s.enqueue(event(i)); // ~180 bytes each
    expect(await s.flush(5_000)).toBe(true);
    expect(Math.max(...sizes)).toBeLessThanOrEqual(6);
    expect(sizes.reduce((a, b) => a + b, 0)).toBe(20);
    srv.close();
  });
});

describe('proxy support', () => {
  it('resolves HTTPS_PROXY / HTTP_PROXY and honors NO_PROXY', () => {
    const env = { HTTPS_PROXY: 'http://proxy.corp:3128', HTTP_PROXY: 'proxy.corp:8080', NO_PROXY: 'localhost,.internal' };
    expect(proxyFor(new URL('https://api.reportee.dev'), env)?.href).toBe('http://proxy.corp:3128/');
    expect(proxyFor(new URL('http://api.reportee.dev'), env)?.href).toBe('http://proxy.corp:8080/');
    expect(proxyFor(new URL('http://localhost:4000'), env)).toBeUndefined();
    expect(proxyFor(new URL('https://ci.build.internal'), env)).toBeUndefined();
    expect(proxyFor(new URL('https://api.reportee.dev'), {})).toBeUndefined();
  });

  it('sends plain HTTP requests through the proxy in absolute form', async () => {
    const seen: string[] = [];
    const proxy = await server((req, res) => {
      seen.push(`${req.method} ${req.url} auth=${req.headers['proxy-authorization'] ?? ''}`);
      res.writeHead(200).end('{}');
    });
    const prev = process.env.HTTP_PROXY;
    process.env.HTTP_PROXY = proxy.url.replace('http://', 'http://user:pass@');
    try {
      const res = await postJson('http://api.example.test/v1/ingest', 't', { x: 1 }, 2000);
      expect(res).toEqual({ status: 200, text: '{}' });
      expect(seen).toEqual([`POST http://api.example.test/v1/ingest auth=Basic ${Buffer.from('user:pass').toString('base64')}`]);
    } finally {
      if (prev === undefined) delete process.env.HTTP_PROXY;
      else process.env.HTTP_PROXY = prev;
      proxy.close();
    }
  });

  // Regression (2026-10-18): the CONNECT tunnel was opened but never used (Node ignores a request's
  // createConnection when an agent is set), so behind a proxy-only network nothing was delivered.
  // The API host exists only inside this proxy, so a 200 proves the tunnel carried the request, and
  // the TLS certificate is verified for that host name. Needs openssl for a throwaway certificate.
  const openssl = spawnSync('openssl', ['version']).status === 0;
  it.skipIf(!openssl)('sends HTTPS requests and uploads through a CONNECT tunnel, verifying the certificate', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'ts-proxy-'));
    const key = path.join(dir, 'key.pem');
    const cert = path.join(dir, 'cert.pem');
    const gen = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '2', '-subj', '/CN=api.proxied.test', '-addext', 'subjectAltName=DNS:api.proxied.test'], { env: { ...process.env, MSYS_NO_PATHCONV: '1' } });
    expect(gen.status).toBe(0);
    const seen: string[] = [];
    const api = https.createServer({ key: readFileSync(key), cert: readFileSync(cert) }, (req, res) => {
      req.resume();
      req.on('end', () => {
        seen.push(`${req.method} ${req.url}`);
        res.writeHead(200).end('{"ok":true}');
      });
    });
    await new Promise<void>((r) => api.listen(0, '127.0.0.1', r));
    const tunnels: string[] = [];
    const proxy = http.createServer();
    proxy.on('connect', (req, client, head) => {
      tunnels.push(`${req.url} ${req.headers['proxy-authorization'] ?? ''}`);
      const upstream = net.connect((api.address() as AddressInfo).port, '127.0.0.1', () => {
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head.length) upstream.write(head);
        upstream.pipe(client);
        client.pipe(upstream);
      });
      upstream.on('error', () => client.destroy());
      client.on('error', () => upstream.destroy());
    });
    await new Promise<void>((r) => proxy.listen(0, '127.0.0.1', r));
    const apiUrl = `https://api.proxied.test:${(api.address() as AddressInfo).port}`;
    // NODE_EXTRA_CA_CERTS is only read at process start, so the client runs in a child process.
    const sender = pathToFileURL(path.resolve(__dirname, '../dist/sender.js')).href;
    const script = `const { postJson, putFile } = await import(${JSON.stringify(sender)});
      const a = await postJson(${JSON.stringify(`${apiUrl}/v1/ingest`)}, 't', { x: 1 }, 5000);
      const b = await putFile(${JSON.stringify(`${apiUrl}/upload/1`)}, {}, { buffer: new Uint8Array([1, 2, 3]) }, 5000);
      console.log(JSON.stringify([a, b]));`;
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
      env: { ...process.env, HTTPS_PROXY: `http://ci:p%40ss@127.0.0.1:${(proxy.address() as AddressInfo).port}`, NO_PROXY: '', NODE_EXTRA_CA_CERTS: cert },
    });
    let out = '';
    child.stdout.on('data', (c) => (out += c));
    child.stderr.on('data', (c) => (out += c));
    await new Promise((r) => child.on('close', r));
    try {
      expect(JSON.parse(out.trim().split('\n').pop()!)).toEqual([{ status: 200, text: '{"ok":true}' }, { status: 200 }]);
      expect(seen).toEqual(['POST /v1/ingest', 'PUT /upload/1']);
      const auth = `Basic ${Buffer.from('ci:p@ss').toString('base64')}`;
      expect(tunnels).toEqual([`api.proxied.test:${(api.address() as AddressInfo).port} ${auth}`, `api.proxied.test:${(api.address() as AddressInfo).port} ${auth}`]);
    } finally {
      api.close();
      proxy.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
