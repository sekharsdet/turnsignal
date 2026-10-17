# turnsignal

Playwright reporter and CLI for [TurnSignal](https://turnsignal.ai): for every CI run, answers **"did my change break this?"**, explains **flaky** tests, and lists tests that **never reported** because a runner crashed or ran out of memory.

> **Free during the public beta**, no credit card and no repository access ([limits](https://turnsignal.ai/#pricing), [terms](https://turnsignal.ai/terms), [privacy](https://turnsignal.ai/privacy)). Docs: https://turnsignal.ai/docs · Questions: hello@turnsignal.ai. The package is 0.x: options may still change.

## What it answers

TurnSignal keeps every Playwright test's results across CI runs and branches, so you can:

- **Track flaky Playwright tests across CI runs**: which tests were flaky in the last 7 to 90 days, how often, and the exact runs and attempts behind each label.
- **See whether a pull request caused a failure or it was already failing on main**: every failure is labelled *new failure*, *also failing on main* or *known flaky*.
- **Find tests that never reported because a shard crashed** or ran out of memory: they are listed as *missing* with the likely reason, instead of disappearing.
- **Keep Playwright test history** without building it yourself: one more reporter next to the HTML report, which keeps working.

More: [what TurnSignal is](https://turnsignal.ai/product) · [security and data](https://turnsignal.ai/security) · [guides](https://turnsignal.ai/blog).

## Install

```bash
npm i -D turnsignal
```

```ts
// playwright.config.ts
export default defineConfig({
  reporter: [['list'], ['turnsignal']],
});
```

Set `TURNSIGNAL_TOKEN` in CI (create a project at https://app.turnsignal.ai to get one). `TURNSIGNAL_API_URL` is only needed for a self-hosted server; it defaults to https://app.turnsignal.ai. Without a token, results are still saved to `.turnsignal/` next to your config.

## GitHub Actions

```yaml
- run: npx playwright test --shard=${{ matrix.shard }}/${{ strategy.job-total }}
  env:
    TURNSIGNAL_TOKEN: ${{ secrets.TURNSIGNAL_TOKEN }}

# Recovers results if the runner crashed or the API was unreachable. Run it after the test step.
- if: always()
  run: npx turnsignal upload
  env:
    TURNSIGNAL_TOKEN: ${{ secrets.TURNSIGNAL_TOKEN }}
```

PR comment (a final job after all shards):

```yaml
  report:
    needs: tests
    if: always()
    runs-on: ubuntu-latest
    permissions:
      pull-requests: write
    steps:
      - run: npx -y turnsignal comment
        env:
          TURNSIGNAL_TOKEN: ${{ secrets.TURNSIGNAL_TOKEN }}
          GITHUB_TOKEN: ${{ github.token }}
```

## Guarantees

- **Never changes your exit code**, and never blocks the run for more than 10 s at the end (up to 30 s while screenshots, videos and traces finish uploading; see Artifacts).
- **Crash-proof:** every result is written to disk before it is sent. Tests that never reported are shown as *Missing*, with the reason.
- **Fail-open:** if the server is unreachable, the run continues and `turnsignal upload` delivers the results later.
- Sharding, CI re-runs, browser matrices and monorepos are merged correctly. Set `TURNSIGNAL_JOB` to name a job (e.g. `staging`), or `TURNSIGNAL_RUN_KEY` if your CI isn't detected (GitHub, GitLab, CircleCI, Buildkite, Azure Pipelines and Jenkins are).
- Honors `HTTPS_PROXY` / `HTTP_PROXY` / `NO_PROXY`.

## Secrets never leave your CI

Before anything is written to disk or sent, error messages, stacks and code snippets are scanned and credentials are replaced with `[REDACTED]`: `Authorization` headers, passwords in URLs, `password=`/`api_key=`-style values, common token formats (GitHub, npm, AWS, Slack, Stripe, Google, JWTs, private keys), and the **values of your CI's secret-looking environment variables** (`*TOKEN*`, `*SECRET*`, `*PASSWORD*`, `*KEY*`). Add your own patterns with `reporter: [['turnsignal', { redact: [/INTERNAL-\d+/] }]]` or `TURNSIGNAL_REDACT` (comma-separated regexes). Set `TURNSIGNAL_SEND_AUTHOR=0` to not send commit author names.

## Screenshots, videos and traces

Playwright decides what is recorded; TurnSignal uploads it (0.3.0+) and your project setting decides what is kept (failed and flaky tests by default, 30 days). Open a failed test on the run page to watch the video or open the trace in the hosted trace viewer.

```ts
use: {
  trace: 'retain-on-failure',
  video: 'retain-on-failure',
  screenshot: 'only-on-failure',
},
```

- Uploads run in the background during the run; at the end TurnSignal waits at most 30 s (`TURNSIGNAL_ARTIFACTS_TIMEOUT_MS`). Anything left is sent by `turnsignal upload`.
- **Traces are redacted in your CI before upload** (authorization headers, cookies, secrets) and ship without your test source (`TURNSIGNAL_TRACE_SOURCE=1` to include it). Screenshots and videos can't be redacted: choose what to send with `TURNSIGNAL_ARTIFACTS=trace,screenshot` (or `none`).
- In containers or Kubernetes pods, wrap the command so uploads finish before the pod stops: `npx turnsignal run -- npx playwright test` (exit code is the test command's).


## Find weak tests (`turnsignal analyze`, v0)

Static checks for Playwright tests that pass without really testing anything, run locally (your code never leaves the machine):

| Rule | Why it matters |
|---|---|
| `focused-test` | `.only` silently skips every other test |
| `unawaited-assertion` | `expect(locator).toBeVisible()` without `await` is never checked |
| `no-assertion` | the test passes as long as nothing throws |
| `trivial-assertion` | `expect(true).toBe(true)` can never fail |
| `swallowed-error` | an empty `catch` hides broken steps |
| `hard-wait` | `waitForTimeout` makes tests slow and flaky |
| `force-action` | `{ force: true }` clicks things a user couldn't (note) |

```
npx turnsignal analyze tests/            # human-readable, exit code 0
npx turnsignal analyze --json            # for tools and agents
npx turnsignal analyze --strict          # exit 1 on errors or warnings (for a CI gate)
```

## Review test changes in a PR (`turnsignal governance`, v0)

AI agents and healers fix failing tests fast; sometimes the "fix" stops the test from checking the bug. `turnsignal governance` compares every test changed in a pull request with the base branch and posts one sticky PR comment (and the job summary):

| Change | Policy |
|---|---|
| Assertion weakened (`toHaveText` → `toBeVisible`, `expect` → `expect.soft`, assertion removed) | needs review |
| Expected value changed (flagged louder when the PR also changes app code) | needs review |
| Test disabled or deleted (`skip`, `fixme`, `fail`, `test.skip()` inside) | needs review |
| Wait added (sleep, longer timeout, `force: true`, `test.slow()`), snapshot updated | worth a look |
| New test (with `analyze` checks), other step changes | information |
| Locator only, renamed | safe |

Each change says who made it when git knows: a person, an agent, a bot, or AI-assisted (`Co-authored-by: Claude …`). It uses git on the CI machine, needs no TurnSignal token, and uploads nothing.

```yaml
test-changes:
  if: github.event_name == 'pull_request'
  runs-on: ubuntu-latest
  permissions: { contents: read, pull-requests: write }
  steps:
    - uses: actions/checkout@v4
      with: { fetch-depth: 0 }
    - run: npx -y turnsignal governance        # add --strict to fail when a change needs review
      env: { GITHUB_TOKEN: "${{ secrets.GITHUB_TOKEN }}" }
```

Elsewhere: `npx turnsignal governance --base origin/main` (add `--json` for scripts). Exit code 0 unless `--strict`.

## AI coding agents (MCP)

`turnsignal mcp` is a read-only [Model Context Protocol](https://modelcontextprotocol.io) server, so an agent can answer "why did CI fail?" from your real runs: recent runs, one run's failures with file:line, error, snippet, whether each failure is new or already on your default branch, test history and flaky tests.

```json
{
  "mcpServers": {
    "turnsignal": {
      "command": "npx",
      "args": ["-y", "turnsignal", "mcp"],
      "env": { "TURNSIGNAL_TOKEN": "<your project token>" }
    }
  }
}
```

## CLI

```
turnsignal upload [--dir .turnsignal] [--strict] [--keep-open]
turnsignal run -- npx playwright test      # containers / Kubernetes: upload before the pod exits
turnsignal comment [--wait 60]
turnsignal doctor
turnsignal mcp                             # MCP server for coding agents (stdio)
turnsignal analyze [paths] [--json|--strict]  # static checks for weak tests (local)
turnsignal governance [--base origin/main] [--json] [--strict] [--no-comment]  # classify test changes in a PR
```

## License

MIT
