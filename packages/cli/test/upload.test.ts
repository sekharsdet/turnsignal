import { describe, it, expect } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, writeFileSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { uploadSpool } from '../src/index.js';

function spoolLine(seq: number, payload: object): string {
  return JSON.stringify({
    runKey: 'github:1',
    executionId: 'exec-1',
    jobId: 'job-1',
    shardIndex: 1,
    shardTotal: 1,
    event: { id: randomUUID(), seq, ts: new Date().toISOString(), payload },
  });
}

interface Batch {
  executionId?: string;
  jobId?: string;
  events: { seq: number; payload: { type: string } }[];
}

async function withApi(fn: (url: string, batches: Batch[]) => Promise<void>): Promise<void> {
  const batches: Batch[] = [];
  const srv = http.createServer((req, res) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => {
      batches.push(JSON.parse(b) as Batch);
      res.writeHead(200).end('{}');
    });
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  try {
    await fn(`http://127.0.0.1:${(srv.address() as AddressInfo).port}`, batches);
  } finally {
    srv.close();
  }
}

function unfinishedSpool(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'reportee-upload-'));
  writeFileSync(
    path.join(dir, 'github_1.shard1.exec-1.ndjson'),
    [
      spoolLine(0, { type: 'run_started', ci: { provider: 'github' }, git: {}, reporterVersion: 't', projects: [] }),
      spoolLine(1, { type: 'test_started', testKey: 'k', attempt: 0 }),
    ].join('\n') + '\n',
  );
  return dir;
}

describe('turnsignal upload (ADR-019)', () => {
  it('closes a spool that never finished with run_aborted, keeping job and execution ids', async () => {
    const dir = unfinishedSpool();
    await withApi(async (url, batches) => {
      const s = await uploadSpool({ dir, apiUrl: url, token: 't' });
      expect(s).toMatchObject({ uploadedFiles: 1, aborted: 1, failures: [] });
      const events = batches.flatMap((b) => b.events);
      expect(events.at(-1)!.payload.type).toBe('run_aborted');
      expect(events.at(-1)!.seq).toBe(2);
      expect(batches[0]).toMatchObject({ executionId: 'exec-1', jobId: 'job-1' });
    });
    expect(readdirSync(dir)).toEqual(['github_1.shard1.exec-1.ndjson.uploaded']);
    rmSync(dir, { recursive: true, force: true });
  });

  it('--keep-open leaves the execution open', async () => {
    const dir = unfinishedSpool();
    await withApi(async (url, batches) => {
      const s = await uploadSpool({ dir, apiUrl: url, token: 't', keepOpen: true });
      expect(s.aborted).toBe(0);
      expect(batches.flatMap((b) => b.events).some((e) => e.payload.type === 'run_aborted')).toBe(false);
    });
    rmSync(dir, { recursive: true, force: true });
  });
});
