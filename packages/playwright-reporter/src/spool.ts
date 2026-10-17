import { mkdirSync, renameSync, existsSync, openSync, writeSync, closeSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import type { SpoolLine } from '@reportee/shared';

export const SPOOL_SUFFIX = '.ndjson';
export const UPLOADED_SUFFIX = '.ndjson.uploaded';

export function spoolFileName(runKey: string, shardIndex: number, executionId: string): string {
  const safe = runKey.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 120);
  return `${safe}.shard${shardIndex}.${executionId.slice(0, 8)}${SPOOL_SUFFIX}`;
}

/**
 * Append-only local journal. Every event is written synchronously BEFORE any network send, so
 * results survive a killed/OOM'd runner and can be replayed with `turnsignal upload` (ADR-012).
 * One file descriptor for the whole run: `write` goes to the OS page cache, which survives the
 * process being killed.
 */
export class Spool {
  readonly filePath: string;
  private fd: number | undefined;
  private broken = false;

  constructor(dir: string, runKey: string, shardIndex: number, executionId: string) {
    this.filePath = path.resolve(dir, spoolFileName(runKey, shardIndex, executionId));
    try {
      mkdirSync(path.dirname(this.filePath), { recursive: true });
      this.fd = openSync(this.filePath, 'a');
    } catch {
      this.broken = true;
    }
  }

  append(line: SpoolLine): void {
    if (this.broken || this.fd === undefined) return;
    try {
      writeSync(this.fd, JSON.stringify(line) + '\n');
    } catch {
      // Disk full / read-only FS: keep going without a spool rather than failing the run.
      this.broken = true;
    }
  }

  close(): void {
    if (this.fd === undefined) return;
    try {
      closeSync(this.fd);
    } catch {
      // ignore
    }
    this.fd = undefined;
  }

  /** Mark as fully delivered so `turnsignal upload` skips it. */
  markUploaded(): void {
    this.close();
    try {
      if (existsSync(this.filePath)) renameSync(this.filePath, this.filePath.replace(/\.ndjson$/, UPLOADED_SUFFIX));
    } catch {
      // Harmless: a later upload replays idempotently.
    }
  }

  /**
   * Deletes delivered spools older than `maxAgeDays` so the directory doesn't grow forever on dev
   * machines and persistent self-hosted runners. Undelivered (*.ndjson) files are never touched.
   */
  static cleanupOld(dir: string, maxAgeDays = 7): void {
    try {
      const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
      for (const name of readdirSync(dir)) {
        if (!name.endsWith(UPLOADED_SUFFIX) && !name.endsWith('.artifacts.jsonl.uploaded')) continue;
        const file = path.join(dir, name);
        if (statSync(file).mtimeMs < cutoff) unlinkSync(file);
      }
    } catch {
      // Best effort only.
    }
  }

  get isBroken(): boolean {
    return this.broken;
  }
}
