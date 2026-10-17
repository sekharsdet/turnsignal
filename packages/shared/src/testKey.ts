import { createHash } from 'node:crypto';

/**
 * Stable identity of a test across runs: Playwright project + file (posix, relative to rootDir)
 * + describe/title path. See memory-bank/06-data-model.md "Test identity".
 */
export function computeTestKey(project: string, file: string, titlePath: readonly string[]): string {
  const normalizedFile = file.replace(/\\/g, '/');
  return createHash('sha1')
    .update([project, normalizedFile, ...titlePath].join('\u0000'))
    .digest('hex');
}

const ANSI = /\u001b\[[0-9;]*m/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI, '');
}
