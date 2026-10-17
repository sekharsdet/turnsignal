import { describe, it, expect } from 'vitest';
import { analyzeSource } from '../src/analyze.js';

const rules = (code: string, file = 'a.spec.ts') => analyzeSource(code, file).findings.map((f) => `${f.rule}@${f.line}`);
const head = "import { test, expect } from '@playwright/test';\n";

describe('turnsignal analyze v0 rules (ADR-037)', () => {
  it('focused-test: .only on tests and suites', () => {
    expect(rules(head + "test.only('a', async ({ page }) => { await expect(page).toHaveTitle('x'); });")).toEqual(['focused-test@2']);
    expect(rules(head + "test.describe.only('s', () => {});")).toEqual(['focused-test@2']);
    expect(rules(head + "test('a', async ({ page }) => { await expect(page).toHaveTitle('x'); });")).toEqual([]);
  });

  it('unawaited-assertion: web-first matchers without await; awaited, returned or Promise.all are fine', () => {
    expect(rules(head + "test('a', async ({ page }) => {\n  expect(page.getByText('Saved')).toBeVisible();\n});")).toEqual(['unawaited-assertion@3']);
    expect(rules(head + "test('a', async ({ page }) => {\n  expect(page.getByText('x')).not.toBeVisible();\n});")).toEqual(['unawaited-assertion@3']);
    expect(rules(head + "test('a', async ({ page }) => {\n  expect.poll(() => 1).toBe(1);\n});")).toEqual(['unawaited-assertion@3']);
    const fine = [
      "await expect(page.getByText('Saved')).toBeVisible();",
      "return expect(page).toHaveURL(/done/);",
      "await Promise.all([expect(page.getByText('a')).toBeVisible(), expect(page.getByText('b')).toBeVisible()]);",
      "expect(1 + 1).toBe(2);", // sync matcher
      "await expect.soft(page.getByText('x')).toHaveText('x');",
    ];
    for (const line of fine) expect(rules(head + `test('a', async ({ page }) => {\n  ${line}\n});`), line).toEqual([]);
  });

  it('no-assertion: only when nothing asserts, directly or through a helper', () => {
    expect(rules(head + "test('opens', async ({ page }) => {\n  await page.goto('/');\n  await page.getByRole('button').click();\n});")).toEqual(['no-assertion@2']);
    const asserting = [
      "await checkout.verifyTotal('42');", // page-object method named like an assertion
      'await assertLoggedIn(page);',
      'await expectToast(page);',
      'await mine(page);', // local helper that contains expect
    ];
    for (const line of asserting) {
      const code = head + "async function mine(p) { await expect(p).toHaveTitle('x'); }\n" + `test('a', async ({ page }) => {\n  ${line}\n});`;
      expect(rules(code), line).toEqual([]);
    }
    // Skipped/fixme tests are not judged; test.skip(condition) inside a test is not a test.
    expect(rules(head + "test.skip('later', async () => {});\ntest.fixme('broken', async () => {});")).toEqual([]);
    expect(rules(head + "test('a', async ({ page, browserName }) => {\n  test.skip(browserName === 'webkit');\n  await expect(page).toHaveURL('/');\n});")).toEqual([]);
  });

  it('works with test.extend fixtures and it(); ignores describe/hooks', () => {
    const code = head + "const my = test.extend({});\nmy('extended', async ({ page }) => { await page.goto('/'); });\ntest.beforeEach(async ({ page }) => { await page.goto('/'); });\ntest.describe('x', () => {});";
    expect(rules(code)).toEqual(['no-assertion@3']);
    expect(rules("it('js style', async () => { await go(); });", 'b.spec.js')).toEqual(['no-assertion@1']);
  });

  it('trivial-assertion: expect(<constant>)', () => {
    expect(rules(head + "test('a', async () => {\n  expect(true).toBe(true);\n});")).toEqual(['trivial-assertion@3']);
    expect(rules(head + "test('a', async ({ page }) => {\n  expect(await page.title()).toBe('Shop');\n});")).toEqual([]);
  });

  it('hard-wait: waitForTimeout and sleep promises', () => {
    const code = head + "test('a', async ({ page }) => {\n  await page.waitForTimeout(2000);\n  await new Promise((r) => setTimeout(r, 500));\n  await expect(page).toHaveTitle('x');\n});";
    expect(rules(code)).toEqual(['hard-wait@3', 'hard-wait@4']);
  });

  it('swallowed-error: empty or log-only catch around awaited steps', () => {
    const code = head + "test('a', async ({ page }) => {\n  try { await page.click('#x'); } catch (e) { console.log(e); }\n  await expect(page).toHaveTitle('x');\n});";
    expect(rules(code)).toEqual(['swallowed-error@3']);
    const rethrow = head + "test('a', async ({ page }) => {\n  try { await page.click('#x'); } catch (e) { throw new Error('x'); }\n  await expect(page).toHaveTitle('x');\n});";
    expect(rules(rethrow)).toEqual([]);
  });

  it('force-action: { force: true } on actions (info)', () => {
    const r = analyzeSource(head + "test('a', async ({ page }) => {\n  await page.getByRole('button').click({ force: true });\n  await expect(page).toHaveTitle('x');\n});", 'a.spec.ts');
    expect(r.findings.map((f) => [f.rule, f.severity])).toEqual([['force-action', 'info']]);
  });

  it('never throws on syntax it cannot parse, and gives file:line with a fix', () => {
    expect(analyzeSource('test(( => {', 'broken.spec.ts').findings).toEqual([]);
    const [f] = analyzeSource(head + "test('t', async () => {});", 'x/y.spec.ts').findings;
    expect(f).toMatchObject({ file: 'x/y.spec.ts', line: 2, column: 1, rule: 'no-assertion', test: 't' });
    expect(f!.fix).toMatch(/expect/);
  });
});
