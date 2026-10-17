import { describe, it, expect } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { compareFile, provenanceOf, renderMarkdown, runGovernance, counts, GOV_MARKER, type GovernanceResult } from '../src/governance.js';

const head = "import { test, expect } from '@playwright/test';\n";
const spec = (body: string, title = 'applies discount', mod = '') => `${head}test.describe('checkout', () => {\n  test${mod}('${title}', async ({ page }) => {\n${body}\n  });\n});\n`;
const base = spec(`    await page.goto('/cart');
    await page.getByText('Apply').click();
    await expect(page.getByTestId('total')).toHaveText('$89.00');`);
const classify = (after: string, before = base) => compareFile('tests/checkout.spec.ts', before, after).map((c) => c.classes);

describe('governance: what kind of change is it (spec 07, ADR-039)', () => {
  it('locator only: a different way to find the same element', () => {
    const after = spec(`    await page.goto('/cart');
    await page.getByRole('button', { name: 'Apply' }).click();
    await expect(page.getByTestId('total')).toHaveText('$89.00');`);
    const [c] = compareFile('tests/checkout.spec.ts', base, after);
    expect(c!.classes).toEqual(['LOCATOR_ONLY']);
    expect(c!.title).toEqual(['checkout', 'applies discount']);
    expect(c!.details.join(' ')).toContain("getByText('Apply')");
  });

  it('no change at all (formatting, comments): nothing reported', () => {
    const after = spec(`    // go to the cart
    await page.goto( '/cart' );
    await page.getByText('Apply').click();
    await expect(page.getByTestId('total')).toHaveText('$89.00');`);
    expect(classify(after)).toEqual([]);
  });

  it('assertion weakened: weaker matcher, expect.soft, or an assertion removed', () => {
    const weaker = spec(`    await page.goto('/cart');
    await page.getByText('Apply').click();
    await expect(page.getByTestId('total')).toBeVisible();`);
    const [w] = compareFile('tests/checkout.spec.ts', base, weaker);
    expect(w!.classes).toEqual(['ASSERTION_WEAKENED']);
    expect(w!.details[0]).toContain('`toBeVisible` checks less than `toHaveText`');

    const soft = spec(`    await page.goto('/cart');
    await page.getByText('Apply').click();
    await expect.soft(page.getByTestId('total')).toHaveText('$89.00');`);
    expect(classify(soft)).toEqual([['ASSERTION_WEAKENED']]);

    const removed = spec(`    await page.goto('/cart');
    await page.getByText('Apply').click();`);
    const [r] = compareFile('tests/checkout.spec.ts', base, removed);
    expect(r!.classes).toEqual(['ASSERTION_WEAKENED']);
    expect(r!.details[0]).toBe("Assertion removed: `expect(page.getByTestId('total')).toHaveText('$89.00')`.");

    const contain = spec(`    await page.goto('/cart');
    await page.getByText('Apply').click();
    await expect(page.getByTestId('total')).toContainText('$');`);
    expect(classify(contain)).toEqual([['ASSERTION_WEAKENED']]);
  });

  it('expected value changed, or negated', () => {
    const changed = spec(`    await page.goto('/cart');
    await page.getByText('Apply').click();
    await expect(page.getByTestId('total')).toHaveText('$99.00');`);
    const [c] = compareFile('tests/checkout.spec.ts', base, changed);
    expect(c!.classes).toEqual(['EXPECTATION_CHANGED']);
    expect(c!.details[0]).toContain("toHaveText('$89.00')");
    expect(c!.details[0]).toContain("toHaveText('$99.00')");

    const negated = spec(`    await page.goto('/cart');
    await page.getByText('Apply').click();
    await expect(page.getByTestId('total')).not.toHaveText('$89.00');`);
    expect(classify(negated)).toEqual([['EXPECTATION_CHANGED']]);
  });

  it('wait added: sleeps, force, longer timeouts, test.slow; an assertion timeout is not an expected-value change', () => {
    const sleep = spec(`    await page.goto('/cart');
    await page.waitForTimeout(3000);
    await page.getByText('Apply').click();
    await expect(page.getByTestId('total')).toHaveText('$89.00');`);
    expect(classify(sleep)).toEqual([['WAIT_ADDED']]);

    const force = spec(`    await page.goto('/cart');
    await page.getByText('Apply').click({ force: true });
    await expect(page.getByTestId('total')).toHaveText('$89.00');`);
    expect(classify(force)).toEqual([['WAIT_ADDED']]);

    const timeout = spec(`    await page.goto('/cart');
    await page.getByText('Apply').click();
    await expect(page.getByTestId('total')).toHaveText('$89.00', { timeout: 30000 });`);
    const [t] = compareFile('tests/checkout.spec.ts', base, timeout);
    expect(t!.classes).toEqual(['WAIT_ADDED']);
    expect(t!.details).toContain('Longer timeout: default → 30000 ms.');

    const slow = spec(`    test.slow();
    await page.goto('/cart');
    await page.getByText('Apply').click();
    await expect(page.getByTestId('total')).toHaveText('$89.00');`);
    expect(classify(slow)).toEqual([['WAIT_ADDED']]);
  });

  it('test disabled: skip/fixme/fail modifiers, a skip call inside, or the test deleted', () => {
    const body = `    await page.goto('/cart');
    await page.getByText('Apply').click();
    await expect(page.getByTestId('total')).toHaveText('$89.00');`;
    expect(classify(spec(body, 'applies discount', '.skip'))).toEqual([['TEST_DISABLED']]);
    expect(classify(spec(body, 'applies discount', '.fixme'))).toEqual([['TEST_DISABLED']]);
    expect(classify(spec(`    test.skip(process.env.CI === 'true', 'flaky on CI');\n${body}`))).toEqual([['TEST_DISABLED']]);

    const deleted = compareFile('tests/checkout.spec.ts', base, `${head}test.describe('checkout', () => {});\n`);
    expect(deleted.map((c) => [c.classes, c.details[0]])).toEqual([[['TEST_DISABLED'], 'The test was deleted (it had 1 assertion).']]);
    expect(compareFile('tests/checkout.spec.ts', base, null)[0]!.details[0]).toBe('The test file was deleted.');
  });

  it('steps changed; several kinds at once are all reported, worst first', () => {
    const steps = spec(`    await page.goto('/cart?coupon=1');
    await page.getByText('Apply').click();
    await expect(page.getByTestId('total')).toHaveText('$89.00');`);
    expect(classify(steps)).toEqual([['STEPS_CHANGED']]);

    const mixed = spec(`    await page.goto('/cart');
    await page.waitForTimeout(1000);
    await page.getByRole('button').click();
    await expect(page.getByTestId('total')).toBeVisible();`);
    expect(classify(mixed)).toEqual([['ASSERTION_WEAKENED', 'WAIT_ADDED']]);
  });

  it('new tests carry static checks; a rename with the same body is safe', () => {
    const added = `${base}test('opens home', async ({ page }) => {\n  await page.goto('/');\n});\n`;
    const [n] = compareFile('tests/checkout.spec.ts', base, added);
    expect(n!.classes).toEqual(['NEW_TEST']);
    expect(n!.findings?.map((f) => f.rule)).toEqual(['no-assertion']);

    const renamed = base.replace("'applies discount'", "'applies a discount code'");
    const [r] = compareFile('tests/checkout.spec.ts', base, renamed);
    expect(r!.classes).toEqual(['TEST_RENAMED']);
    expect(r!.details[0]).toBe('Renamed from "checkout › applies discount".');
  });
});

describe('governance: provenance (who or what changed the test)', () => {
  it('bots, agents and AI co-author trailers', () => {
    expect(provenanceOf([{ author: 'Alice', email: 'alice@example.com', message: 'fix test' }])).toEqual({ kind: 'human', names: [] });
    expect(provenanceOf([{ author: 'Alice', email: 'a@x', message: 'heal\n\nCo-authored-by: Claude <noreply@anthropic.com>' }])).toEqual({ kind: 'ai-assisted', names: ['Claude'] });
    expect(provenanceOf([{ author: 'Copilot', email: '198982749+Copilot@users.noreply.github.com', message: 'Fix locator' }])).toEqual({ kind: 'agent', names: ['Copilot'] });
    expect(provenanceOf([{ author: 'dependabot[bot]', email: 'x@users.noreply.github.com', message: 'bump' }])).toEqual({ kind: 'bot', names: ['dependabot[bot]'] });
    expect(provenanceOf([])).toEqual({ kind: 'unknown', names: [] });
  });
});

describe('governance: PR comment', () => {
  const result = (over: Partial<GovernanceResult> = {}): GovernanceResult => ({
    base: 'origin/main',
    mergeBase: 'abcdef1234567',
    tests: [],
    snapshots: [],
    helpers: [],
    appFiles: [],
    provenance: {},
    ...over,
  });

  it('answers first: what needs review, why, and by whom', () => {
    const weakened = compareFile(
      'tests/checkout.spec.ts',
      base,
      spec(`    await page.goto('/cart');
    await page.getByText('Apply').click();
    await expect(page.getByTestId('total')).toBeVisible();`),
    );
    const locator = compareFile('tests/other.spec.ts', base, base.replace("getByText('Apply')", "getByRole('button')"));
    const r = result({ tests: [...weakened, ...locator], snapshots: [{ file: 'tests/a.spec.ts-snapshots/cart.png', status: 'changed' }], provenance: { 'tests/checkout.spec.ts': { kind: 'ai-assisted', names: ['Claude'] } } });
    const body = renderMarkdown(r);
    expect(body.startsWith(`${GOV_MARKER}\n### ⚠️ Test changes: 1 test needs a human review.`)).toBe(true);
    expect(body).toContain('1 assertion weakened · 1 snapshot updated · 1 locator only');
    expect(body).toContain('**Needs a human review (1)**');
    expect(body).toContain('- **checkout › applies discount** (`tests/checkout.spec.ts:3`) · Assertion weakened · AI-assisted (Claude)');
    expect(body).toContain('`toBeVisible` checks less than `toHaveText`');
    expect(body).toContain('Why it matters: The test now checks less than before');
    expect(body).toContain('<details><summary>Safe: locators and renames only (1)</summary>');
    expect(body).toContain('Nothing was uploaded.');
    expect(counts(r)).toEqual({ review: 1, warn: 1, info: 0, ok: 1 });
  });

  it('adds the attribution line only when asked (hosted), with the token hint when there is no token', () => {
    const plain = renderMarkdown(result());
    expect(plain).not.toContain('turnsignal.ai/?ref=pr-governance');
    expect(renderMarkdown(result(), { attribution: true })).toMatch(/<sub>Review by \[TurnSignal for Playwright\]\(https:\/\/turnsignal\.ai\/\?ref=pr-governance\)<\/sub>$/);
    const tokenless = renderMarkdown(result(), { attribution: true, tokenless: true });
    expect(tokenless).toContain('With a free project token it also shows which failures are new, flaky or missing on this PR.');
    expect(tokenless.startsWith(GOV_MARKER)).toBe(true);
  });

  it('says so when a PR changes no tests', () => {
    expect(renderMarkdown(result())).toContain('### ✅ No test changes in this pull request.');
  });
});

// --- End to end: a real git repository and the built CLI.

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

function cli(cwd: string, args: string[], env: Record<string, string> = {}): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const bin = path.resolve(__dirname, '../dist/bin.js');
  return new Promise((resolve) => {
    const clean = { ...process.env };
    for (const k of ['GITHUB_ACTIONS', 'GITHUB_EVENT_PATH', 'GITHUB_STEP_SUMMARY', 'GITHUB_BASE_REF', 'GITHUB_TOKEN', 'CI_MERGE_REQUEST_DIFF_BASE_SHA', 'CI_MERGE_REQUEST_TARGET_BRANCH_NAME']) delete clean[k];
    const child = spawn(process.execPath, [bin, ...args], { cwd, env: { ...clean, ...env } });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('exit', (code) => resolve({ code, stdout, stderr }));
  });
}

describe('turnsignal governance in a git repository', () => {
  it('classifies the PR against its merge base, names the AI co-author, writes the job summary, and fails only with --strict', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'ts-gov-'));
    try {
      git(dir, 'init', '-q', '-b', 'main');
      git(dir, 'config', 'user.email', 'dev@example.com');
      git(dir, 'config', 'user.name', 'Dev');
      git(dir, 'config', 'commit.gpgsign', 'false');
      mkdirSync(path.join(dir, 'tests'));
      mkdirSync(path.join(dir, 'src'));
      writeFileSync(path.join(dir, 'tests/checkout.spec.ts'), base);
      writeFileSync(path.join(dir, 'src/cart.ts'), 'export const total = 89;\n');
      git(dir, 'add', '.');
      git(dir, 'commit', '-q', '-m', 'base');

      git(dir, 'checkout', '-q', '-b', 'heal');
      writeFileSync(
        path.join(dir, 'tests/checkout.spec.ts'),
        spec(`    await page.goto('/cart');
    await page.getByText('Apply').click();
    await expect(page.getByTestId('total')).toHaveText('$99.00');`),
      );
      writeFileSync(path.join(dir, 'src/cart.ts'), 'export const total = 99;\n');
      git(dir, 'commit', '-q', '-am', 'heal checkout test\n\nCo-authored-by: Claude <noreply@anthropic.com>');

      const summary = path.join(dir, 'summary.md');
      const text = await cli(dir, ['governance', '--base', 'main'], { GITHUB_STEP_SUMMARY: summary });
      expect(text.code).toBe(0);
      expect(text.stdout).toContain('Test changes: 1 test needs a human review.');
      expect(text.stdout).toContain('[review] checkout › applies discount  tests/checkout.spec.ts:3');
      expect(text.stdout).toContain('Expected value changed · AI-assisted (Claude)');
      expect(text.stdout).toContain('This PR also changes 1 application file (e.g. src/cart.ts)');
      expect(readFileSync(summary, 'utf8')).toContain('**Needs a human review (1)**');

      const json = await cli(dir, ['governance', '--base', 'main', '--json', '--no-comment']);
      const parsed = JSON.parse(json.stdout) as GovernanceResult & { version: number };
      expect(parsed.version).toBe(0);
      expect(parsed.tests.map((t) => t.classes)).toEqual([['EXPECTATION_CHANGED']]);
      expect(parsed.appFiles).toEqual(['src/cart.ts']);

      expect((await cli(dir, ['governance', '--base', 'main', '--strict', '--no-comment'])).code).toBe(1);

      // The API used by the CLI, directly: base from the CI environment.
      const out = runGovernance({ cwd: dir, env: { GITHUB_BASE_REF: 'main' } });
      expect(out.ok && out.result.base).toBe('main');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails open with a clear reason: not a repository, unknown base', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'ts-gov-none-'));
    try {
      const none = await cli(dir, ['governance', '--strict']);
      expect(none.code).toBe(0);
      expect(none.stderr).toContain('governance skipped: not a git repository');

      git(dir, 'init', '-q', '-b', 'feature');
      git(dir, 'config', 'user.email', 'dev@example.com');
      git(dir, 'config', 'user.name', 'Dev');
      writeFileSync(path.join(dir, 'a.txt'), 'x');
      git(dir, 'add', '.');
      git(dir, 'commit', '-q', '-m', 'x');
      const noBase = await cli(dir, ['governance', '--strict']);
      expect(noBase.code).toBe(0);
      expect(noBase.stderr).toContain('no base branch found; pass --base origin/<branch>');
      const missing = await cli(dir, ['governance', '--base', 'origin/main']);
      expect(missing.stderr).toContain('base "origin/main" not found');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
