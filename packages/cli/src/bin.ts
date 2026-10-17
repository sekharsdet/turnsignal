#!/usr/bin/env node
import { apiUrlFor, detectCi, setting } from '@reportee/playwright/env';
import { uploadSpool, doctor } from './index.js';
import { isHostedUrl, publishComment, publishMarkdown } from './comment.js';
import { createApi, serveMcp } from './mcp.js';
import { spawn } from 'node:child_process';

const HELP = `turnsignal <command> [options]

Commands:
  upload [--dir .turnsignal] [--strict] [--keep-open]
                                        Upload results saved locally (e.g. after a runner crash).
                                        Safe to run more than once. Use in an always-run CI step
                                        AFTER the test step: runs that never finished are closed
                                        as stopped (unless --keep-open).
  run [--dir .turnsignal] -- <test command>
                                        Runs your tests, then uploads anything still pending (results,
                                        screenshots, videos, traces) BEFORE exiting, with the test
                                        command's exit code. For containers / Kubernetes pods, where
                                        the disk disappears when the process ends.
  comment [--wait 60]                   Post the run verdict as a sticky PR comment (GitHub) and to the
                                        job summary. Run it in a final job after all shards finish.
  doctor [--dir .turnsignal]            Check configuration, connectivity and pending results.
  analyze [paths] [--json] [--strict]   Static checks for weak tests: no assertion, un-awaited assertions,
                                        hard waits, .only, swallowed errors. Runs locally; code never leaves.
  governance [--base origin/main] [--json] [--strict] [--no-comment]
                                        Classifies every test changed in a pull request (assertion weakened,
                                        expected value changed, test disabled, wait added, locator only, ...)
                                        and posts it as a sticky PR comment + job summary. Uses git on the CI
                                        machine; needs no token; nothing is uploaded. Exit 0 unless --strict
                                        and a change needs review.
  mcp                                   MCP server (stdio) for coding agents: recent runs, a run's failures
                                        with errors and evidence, test history, flaky tests. Read-only.

Environment: TURNSIGNAL_TOKEN (optional: TURNSIGNAL_API_URL, default https://app.turnsignal.ai;
             TURNSIGNAL_RUN_KEY, TURNSIGNAL_JOB)`;

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

async function main(): Promise<number> {
  const [command, ...args] = process.argv.slice(2);
  const dir = flag(args, '--dir') ?? setting('SPOOL_DIR') ?? '.turnsignal';
  const token = setting('TOKEN');
  const explicitUrl = setting('API_URL');
  const apiUrl = apiUrlFor(explicitUrl, token);
  const strict = args.includes('--strict');

  switch (command) {
    case 'upload': {
      if (!apiUrl || !token) {
        console.error('[turnsignal] TURNSIGNAL_TOKEN is required for upload.');
        return strict ? 1 : 0;
      }
      const s = await uploadSpool({
        dir,
        apiUrl,
        token,
        keepOpen: args.includes('--keep-open'),
        log: (m) => console.log(`[turnsignal] ${m}`),
      });
      console.log(`[turnsignal] ${s.uploadedFiles}/${s.files} file(s), ${s.events} event(s)${s.artifacts ? `, ${s.artifacts} artifact(s)` : ''} uploaded.`);
      if (s.aborted) console.log(`[turnsignal] ${s.aborted} run(s) had not finished; marked as stopped without finishing.`);
      for (const f of s.failures) console.error(`[turnsignal] failed: ${f}`);
      // Fail-open by default: an upload problem must not turn a CI job red.
      return s.failures.length && strict ? 1 : 0;
    }
    case 'comment': {
      if (!apiUrl || !token) {
        console.error('[turnsignal] TURNSIGNAL_TOKEN is required for comment.');
        return strict ? 1 : 0;
      }
      const runKey = detectCi().runKey;
      if (runKey.startsWith('local:')) {
        console.error('[turnsignal] could not detect the CI run; set TURNSIGNAL_RUN_KEY to the value used by the test jobs.');
        return strict ? 1 : 0;
      }
      const waitSec = Number(flag(args, '--wait') ?? 60);
      const out = await publishComment({ apiUrl, token, runKey, waitMs: waitSec * 1000, log: (m) => console.log(`[turnsignal] ${m}`) });
      if (out.summaryWritten) console.log('[turnsignal] verdict written to the job summary.');
      if (out.posted === 'skipped') console.log(`[turnsignal] PR comment skipped: ${out.reason}.`);
      return 0;
    }
    case 'run': {
      const sep = args.indexOf('--');
      const cmd = sep >= 0 ? args.slice(sep + 1) : [];
      if (!cmd.length) {
        console.error('[turnsignal] usage: turnsignal run -- npx playwright test [args]');
        return 2;
      }
      const code = await runChild(cmd);
      if (apiUrl && token) {
        try {
          const s = await uploadSpool({ dir, apiUrl, token, log: (m) => console.log(`[turnsignal] ${m}`) });
          if (s.files || s.artifacts) console.log(`[turnsignal] after the run: ${s.events} event(s), ${s.artifacts} artifact(s) uploaded.`);
          for (const f of s.failures) console.error(`[turnsignal] failed: ${f}`);
        } catch (err) {
          console.error(`[turnsignal] upload after the run failed (ignored): ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      // Always the test command's own exit code: TurnSignal never changes whether CI passes.
      return code;
    }
    case 'analyze': {
      // Loaded on demand: the parser is large and other commands don't need it.
      const { analyzePaths, formatText } = await import('./analyze.js');
      const paths = args.filter((a) => !a.startsWith('--'));
      const result = analyzePaths(paths);
      console.log(args.includes('--json') ? JSON.stringify({ version: 0, ...result }, null, 2) : formatText(result));
      const blocking = result.findings.filter((f) => f.severity !== 'info').length;
      return args.includes('--strict') && blocking ? 1 : 0;
    }
    case 'governance': {
      // Loaded on demand (shares the parser chunk with analyze).
      const { runGovernance, renderMarkdown, renderText, counts, GOV_MARKER } = await import('./governance.js');
      const out = runGovernance({ base: flag(args, '--base') });
      if (!out.ok) {
        console.error(`[turnsignal] governance skipped: ${out.reason}.`);
        return 0;
      }
      const r = out.result;
      console.log(args.includes('--json') ? JSON.stringify({ version: 0, ...r }, null, 2) : renderText(r));
      if (!args.includes('--no-comment')) {
        const hasNews = r.tests.length > 0 || r.snapshots.length > 0;
        // Attribution only for the hosted service; a self-hosted server gets none.
        const attribution = !explicitUrl || isHostedUrl(explicitUrl);
        const pub = await publishMarkdown(renderMarkdown(r, { attribution, tokenless: !token }), { marker: GOV_MARKER, createIfMissing: hasNews, log: (m) => console.error(`[turnsignal] ${m}`) });
        if (pub.posted === 'skipped' && process.env.GITHUB_ACTIONS) console.error(`[turnsignal] PR comment skipped: ${pub.reason}.`);
      }
      return strict && counts(r).review > 0 ? 1 : 0;
    }
    case 'mcp': {
      // stdout is the protocol channel: nothing else may be printed there.
      if (!apiUrl || !token) {
        console.error('[turnsignal] TURNSIGNAL_TOKEN is required for mcp (a project token; read-only use).');
        return 1;
      }
      await serveMcp({ api: createApi(apiUrl, token) });
      return 0;
    }
    case 'doctor': {
      const checks = await doctor({ dir, apiUrl, token, apiUrlIsDefault: Boolean(apiUrl) && !explicitUrl });
      for (const c of checks) console.log(`${c.ok ? '✔' : '✖'} ${c.name}: ${c.detail}`);
      return checks.every((c) => c.ok) ? 0 : 1;
    }
    default:
      console.log(HELP);
      return command && !['--help', '-h', 'help'].includes(command) ? 1 : 0;
  }
}

// Never call process.exit(): on Windows, exiting while fetch/undici sockets are still closing aborts
// Node (libuv UV_HANDLE_CLOSING) with exit code 127, which would fail CI steps. Set the code and
// let the event loop drain instead (reporter-contract skill, rule 4).
main().then(
  (code) => {
    process.exitCode = code;
  },
  (err) => {
    console.error(`[turnsignal] ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 0;
  },
);

/**
 * Runs the test command with inherited stdio. SIGINT/SIGTERM (e.g. a pod being stopped) are passed
 * to the child so Playwright can finish its reporters; we then upload before exiting.
 */
function runChild(cmd: string[]): Promise<number> {
  return new Promise((resolve) => {
    // Windows needs a shell to find npx/npm (.cmd shims); pass ONE quoted command line so arguments
    // with spaces or quotes survive (and avoid Node's unescaped-args warning, DEP0190).
    const child =
      process.platform === 'win32'
        ? spawn(cmd.map(quoteWindowsArg).join(' '), { stdio: 'inherit', shell: true })
        : spawn(cmd[0]!, cmd.slice(1), { stdio: 'inherit' });
    const forward = (signal: NodeJS.Signals) => () => {
      if (child.exitCode === null) child.kill(signal);
    };
    const onInt = forward('SIGINT');
    const onTerm = forward('SIGTERM');
    process.on('SIGINT', onInt);
    process.on('SIGTERM', onTerm);
    child.on('error', (err) => {
      console.error(`[turnsignal] could not start ${cmd[0]}: ${err.message}`);
      resolve(127);
    });
    child.on('exit', (code, signal) => {
      process.off('SIGINT', onInt);
      process.off('SIGTERM', onTerm);
      resolve(code ?? (signal === 'SIGINT' ? 130 : signal === 'SIGTERM' ? 143 : 1));
    });
  });
}

/** Quotes one argument for cmd.exe: wrap in double quotes when needed, doubling inner quotes. */
function quoteWindowsArg(arg: string): string {
  return /^[\w@%+=:,./\-]+$/.test(arg) ? arg : `"${arg.replace(/"/g, '""')}"`;
}
