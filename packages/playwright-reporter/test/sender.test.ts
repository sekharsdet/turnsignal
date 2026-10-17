import { describe, it, expect } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
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
});
