# TurnSignal for Playwright

Source of the [`turnsignal`](https://www.npmjs.com/package/turnsignal) npm package: the Playwright reporter, the `turnsignal` CLI and the TurnSignal **MCP server** for coding agents. MIT licensed.

[TurnSignal](https://turnsignal.ai) keeps every Playwright test's results across CI runs and branches, and labels each failure as a *new failure*, *also failing on main* or *known flaky*. Package docs: [packages/turnsignal/README.md](packages/turnsignal/README.md).

## MCP server

Read-only Playwright CI results for coding agents (Claude Code, Cursor, Copilot, ...). Before an agent "fixes" a failing test, it can check whether the failure is new in this pull request, already failing on main, or known flaky.

| Tool | What it returns |
|---|---|
| `turnsignal_recent_runs` | Recent CI runs: verdict, status, branch, commit, counts, run id |
| `turnsignal_run` | One run's results: new failures, already failing, flaky, missing tests, with errors |
| `turnsignal_test_history` | One test's recent outcomes across runs |
| `turnsignal_flaky_tests` | Tests that were flaky in the last N days, most flaky first |

```json
{
  "mcpServers": {
    "turnsignal": {
      "command": "npx",
      "args": ["-y", "turnsignal", "mcp"],
      "env": { "TURNSIGNAL_TOKEN": "<project token from https://app.turnsignal.ai>" }
    }
  }
}
```

Claude Code: `claude mcp add turnsignal -e TURNSIGNAL_TOKEN=<token> -- npx -y turnsignal mcp`

The server talks JSON-RPC over stdio and only reads data the project token can see. It is listed in the official MCP Registry as `ai.turnsignal/turnsignal`.

## Layout

| Path | What |
|---|---|
| `packages/shared` | Wire format, test identity, secret redaction |
| `packages/playwright-reporter` | The Playwright reporter (crash-safe local copy, never changes your exit code) |
| `packages/cli` | `turnsignal upload`, `comment`, `governance`, `doctor`, `mcp` ([src/mcp.ts](packages/cli/src/mcp.ts)) |
| `packages/turnsignal` | The published package: an esbuild bundle of the three above |

```bash
npm ci
npm test            # build + unit tests
npm run package     # builds packages/turnsignal/dist
```

The hosted service (API and web app) is not part of this repository; `ADR-NNN` references in code comments point to its internal design records. This repository is a mirror: changes land upstream and are synced here, so please report issues to hello@turnsignal.ai or open an issue. Questions: hello@turnsignal.ai.
