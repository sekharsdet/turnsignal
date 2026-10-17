import type { FullConfig, FullResult, Reporter, Suite, TestCase, TestError, TestResult } from '@playwright/test/reporter';

export interface TurnSignalOptions {
  /** TurnSignal server URL. Defaults to env TURNSIGNAL_API_URL. */
  apiUrl?: string;
  /** Project token. Defaults to env TURNSIGNAL_TOKEN. Without it, results are only saved locally. */
  token?: string;
  /** Directory for the crash-safe local copy of results. Default: `.turnsignal` next to the Playwright config. */
  spoolDir?: string;
  /** Max time to wait for delivery at the end of the run. Default 10000 ms. */
  flushTimeoutMs?: number;
  /** Per-request timeout. Default 3000 ms. */
  requestTimeoutMs?: number;
  /** Memory sampling interval (also acts as a heartbeat). Default 10000 ms. */
  sampleIntervalMs?: number;
  /**
   * Extra values or patterns to replace with [REDACTED] in errors, stacks and snippets, on top of the
   * built-in credential formats and secret-looking env var values. Also: env TURNSIGNAL_REDACT.
   */
  redact?: (string | RegExp)[];
}

/**
 * Playwright reporter. Never changes the exit code, never blocks the run for more than
 * `flushTimeoutMs`, and writes every result to disk before sending it.
 */
export default class TurnSignalReporter implements Reporter {
  constructor(options?: TurnSignalOptions);
  printsToStdio(): boolean;
  onBegin(config: FullConfig, suite: Suite): void;
  onTestBegin(test: TestCase, result: TestResult): void;
  onTestEnd(test: TestCase, result: TestResult): void;
  onError(error: TestError): void;
  onEnd(result: FullResult): Promise<void>;
}
