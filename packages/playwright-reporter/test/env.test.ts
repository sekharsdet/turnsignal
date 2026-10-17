import { describe, it, expect } from 'vitest';
import { selectionArgs, detectCi, setting, apiUrlFor, DEFAULT_API_URL } from '../src/env.js';

describe('settings', () => {
  it('prefers TURNSIGNAL_* and falls back to the pre-release REPORTEE_* names', () => {
    expect(setting('TOKEN', { TURNSIGNAL_TOKEN: 'new', REPORTEE_TOKEN: 'old' })).toBe('new');
    expect(setting('TOKEN', { REPORTEE_TOKEN: 'old' })).toBe('old');
    expect(setting('TOKEN', { TURNSIGNAL_TOKEN: '' })).toBeUndefined();
  });

  it('ignores an invisible byte-order mark and surrounding whitespace (seen with tokens piped from PowerShell)', () => {
    expect(setting('TOKEN', { TURNSIGNAL_TOKEN: '\uFEFFtsk_abc\r\n' })).toBe('tsk_abc');
    expect(setting('TOKEN', { TURNSIGNAL_TOKEN: '  tsk_abc  ' })).toBe('tsk_abc');
    expect(setting('TOKEN', { TURNSIGNAL_TOKEN: '\uFEFF ' })).toBeUndefined();
  });
});

describe('job selection from the Playwright CLI (ADR-018)', () => {
  it('distinguishes matrix siblings but not shards of one job', () => {
    const chromium1 = selectionArgs(['node', 'playwright', 'test', '--project=chromium', '--shard=1/4']);
    const chromium2 = selectionArgs(['node', 'playwright', 'test', '--shard=2/4', '--project', 'chromium']);
    const firefox = selectionArgs(['node', 'playwright', 'test', '--project=firefox', '--shard=1/4']);
    expect(chromium1).toEqual(chromium2);
    expect(chromium1).not.toEqual(firefox);
  });

  it('captures grep filters and comma-separated projects', () => {
    expect(selectionArgs(['x', '--project=webkit,chromium', '-g', '@smoke', '--grep-invert=@slow'])).toEqual({
      projects: ['chromium', 'webkit'],
      filters: ['--grep-invert=@slow', '-g=@smoke'],
    });
  });

  it('merges GitHub re-run attempts into one run key', () => {
    const a1 = detectCi({ GITHUB_ACTIONS: 'true', GITHUB_RUN_ID: '42', GITHUB_RUN_ATTEMPT: '1' });
    const a2 = detectCi({ GITHUB_ACTIONS: 'true', GITHUB_RUN_ID: '42', GITHUB_RUN_ATTEMPT: '2' });
    expect(a1.runKey).toBe('github:42');
    expect(a2.runKey).toBe(a1.runKey);
  });
});

describe('API URL (ADR-028)', () => {
  it('uses an explicit URL, else the hosted service when a token is set, else none', () => {
    expect(apiUrlFor('http://localhost:4000', 'tsk_x')).toBe('http://localhost:4000');
    expect(apiUrlFor(undefined, 'tsk_x')).toBe(DEFAULT_API_URL);
    expect(apiUrlFor('', 'tsk_x')).toBe(DEFAULT_API_URL);
    expect(apiUrlFor(undefined, undefined)).toBeUndefined();
    expect(apiUrlFor(undefined, '')).toBeUndefined();
    expect(DEFAULT_API_URL).toBe('https://app.turnsignal.ai');
  });
});
