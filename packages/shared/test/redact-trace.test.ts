import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { unzipSync, zipSync, strFromU8, strToU8 } from 'fflate';
import { redactTraceZip } from '../src/redact-trace.js';

/**
 * fixtures/api-trace.zip is a REAL Playwright 1.63 trace of an API test that sent FAKE credentials:
 * Authorization header, request cookie, response set-cookie, password in the body, api_key in the
 * query string, token in the response body, and a console line.
 */
const fixture = readFileSync(fileURLToPath(new URL('./fixtures/api-trace.zip', import.meta.url)));
const text = (bytes: Uint8Array) => Object.values(unzipSync(bytes)).map(strFromU8).join('\n');

describe('redactTraceZip (ADR-029)', () => {
  it('removes every credential from a real trace but keeps it useful', () => {
    const before = text(fixture);
    for (const s of ['HEADERTOKEN', 'COOKIESECRET', 'SESSIONSECRET', 'PLAINPASSWORD', 'QUERYKEY', 'BODYTOKEN']) expect(before).toContain(s);

    const { bytes, droppedSourceFiles } = redactTraceZip(fixture);
    const after = text(bytes);
    for (const s of ['HEADERTOKEN', 'COOKIESECRET', 'SESSIONSECRET', 'PLAINPASSWORD', 'QUERYKEY', 'BODYTOKEN']) expect(after).not.toContain(s);
    expect(after).toContain('[REDACTED]');
    expect(after).toContain('/login'); // the request itself is still visible
    expect(after).toContain('ada'); // non-secret data survives
    expect(droppedSourceFiles).toBe(1);
    expect(Object.keys(unzipSync(bytes)).some((n) => n.startsWith('src/'))).toBe(false);
    // Every JSON-lines entry is still valid JSON (the viewer can parse it).
    for (const [name, data] of Object.entries(unzipSync(bytes))) {
      if (!/\.(trace|network|stacks)$/.test(name)) continue;
      for (const line of strFromU8(data).split('\n').filter(Boolean)) expect(() => JSON.parse(line)).not.toThrow();
    }
  });

  it('keeps test source only when asked, and masks CI secret values anywhere', () => {
    const { droppedSourceFiles } = redactTraceZip(fixture, { keepSource: true });
    expect(droppedSourceFiles).toBe(0);
    const custom = zipSync({ '0-trace.trace': strToU8(JSON.stringify({ type: 'log', message: 'deploying with Zebra-1234567' }) + '\n') });
    expect(text(redactTraceZip(custom, { values: ['Zebra-1234567'] }).bytes)).not.toContain('Zebra-1234567');
  });

  it('blanks every cookie value regardless of the cookie name', () => {
    const har = { type: 'resource-snapshot', snapshot: { request: { cookies: [{ name: 'sid', value: 'abc123secret' }], headers: [{ name: 'Accept', value: 'text/html' }] } } };
    const out = text(redactTraceZip(zipSync({ '0-trace.network': strToU8(JSON.stringify(har)) })).bytes);
    expect(out).not.toContain('abc123secret');
    expect(out).toContain('text/html');
  });

  it('refuses input that is not a zip (the caller must then not upload it)', () => {
    expect(() => redactTraceZip(new Uint8Array([1, 2, 3, 4]))).toThrow();
  });
});
