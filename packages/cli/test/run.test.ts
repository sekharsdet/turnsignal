import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const bin = path.resolve(__dirname, '../dist/bin.js');

function run(args: string[], env: Record<string, string> = {}): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [bin, ...args], {
      env: { ...process.env, TURNSIGNAL_TOKEN: '', REPORTEE_TOKEN: '', TURNSIGNAL_API_URL: '', REPORTEE_API_URL: '', ...env },
    });
    let out = '';
    child.stdout.on('data', (c) => (out += c));
    child.stderr.on('data', (c) => (out += c));
    child.on('close', (code) => resolve({ code, out }));
  });
}

describe('turnsignal run -- <command> (containers / Kubernetes)', () => {
  it('returns the test command exit code, whatever happens to the upload', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'ts-run-'));
    try {
      for (const code of [0, 1, 3]) {
        const r = await run(['run', '--dir', dir, '--', process.execPath, '-e', `process.exit(${code})`]);
        expect(r.code, r.out).toBe(code);
      }
      // With a token but an unreachable API: still the child's code, never a CI failure of our own.
      const r = await run(['run', '--dir', dir, '--', process.execPath, '-e', 'process.exit(1)'], {
        TURNSIGNAL_TOKEN: 'tsk_x', TURNSIGNAL_API_URL: 'http://127.0.0.1:9',
      });
      expect(r.code).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('passes arguments with spaces and quotes through unchanged', async () => {
    const r = await run(['run', '--', process.execPath, '-e', 'console.log(JSON.stringify(process.argv.slice(1)))', 'a b', 'say "hi"']);
    expect(r.code).toBe(0);
    expect(r.out).toContain('["a b","say \\"hi\\""]');
  });

  it('explains usage without a command', async () => {
    const r = await run(['run']);
    expect(r.code).toBe(2);
    expect(r.out).toMatch(/usage: turnsignal run -- /);
  });
});
