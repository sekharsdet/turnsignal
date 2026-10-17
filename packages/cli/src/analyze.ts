import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { ACTIONS, ASYNC_MATCHERS, calleeName, expectRoot, findTests, isNode, parseSource, testNames, walk, type Node } from './ast.js';

/**
 * `turnsignal analyze` v0 (ADR-037): static Trust rules for Playwright tests. Runs locally; your
 * source never leaves the machine. Rules are tuned for precision: when unsure, stay silent.
 */

export type Severity = 'error' | 'warning' | 'info';
export interface Finding {
  file: string;
  line: number;
  column: number;
  rule: string;
  severity: Severity;
  test?: string;
  message: string;
  fix: string;
}

export const RULES: Record<string, { severity: Severity; why: string; fix: string }> = {
  'focused-test': {
    severity: 'error',
    why: '.only runs this test/suite alone: every other test in the run is silently skipped.',
    fix: 'Remove .only (add `forbidOnly: !!process.env.CI` to playwright.config).',
  },
  'unawaited-assertion': {
    severity: 'error',
    why: 'Web-first assertion is not awaited: the test can finish before it is checked, so it never fails.',
    fix: 'Add `await` before expect(...).',
  },
  'no-assertion': {
    severity: 'warning',
    why: 'The test checks nothing: it passes as long as no step throws, so it would not catch most bugs.',
    fix: 'Assert the outcome the user cares about, e.g. `await expect(page.getByRole(...)).toHaveText(...)`.',
  },
  'trivial-assertion': {
    severity: 'warning',
    why: 'Asserts on a constant: it can never fail.',
    fix: 'Assert on something the application produced (a locator, a response, a value from the page).',
  },
  'swallowed-error': {
    severity: 'warning',
    why: 'A catch block ignores the error, so a broken step lets the test pass.',
    fix: 'Remove the try/catch, rethrow, or assert inside the catch.',
  },
  'hard-wait': {
    severity: 'warning',
    why: 'Fixed sleeps make tests slow and flaky: too short on a slow runner, wasted time on a fast one.',
    fix: 'Wait for the condition instead: `await expect(locator).toBeVisible()` or `page.waitForResponse(...)`.',
  },
  'force-action': {
    severity: 'info',
    why: '`force: true` skips actionability checks: the test can click things a user could not.',
    fix: 'Remove `force` and wait for the element to be actionable (visible, enabled, not covered).',
  },
};

const ASSERTING_NAME = /^(assert|expect|verify|check|should|validate|ensure)/i;

/** Local functions (declared in this file) that contain an assertion: calling one counts as asserting. */
function assertingHelpers(ast: Node): Set<string> {
  const out = new Set<string>();
  const hasExpect = (n: Node) => {
    let found = false;
    walk(n, (x) => {
      if (found) return false;
      if (x.type === 'CallExpression' && expectRoot(x)) found = true;
    });
    return found;
  };
  walk(ast, (n) => {
    if (n.type === 'FunctionDeclaration' && isNode(n.id) && hasExpect(n)) out.add(n.id.name as string);
    if (n.type === 'VariableDeclarator' && isNode(n.id) && n.id.type === 'Identifier' && isNode(n.init) && /Function/.test(n.init.type) && hasExpect(n.init))
      out.add(n.id.name as string);
    if ((n.type === 'ClassMethod' || n.type === 'ObjectMethod') && isNode(n.key) && hasExpect(n)) out.add(n.key.name as string);
  });
  return out;
}

export function analyzeSource(source: string, file: string): { findings: Finding[]; tests: number } {
  const findings: Finding[] = [];
  const ast = parseSource(source, file);
  if (!ast) return { findings, tests: 0 };
  const add = (n: Node, rule: keyof typeof RULES, test?: string, detail?: string) => {
    const r = RULES[rule]!;
    findings.push({ file, line: n.loc?.start.line ?? 0, column: (n.loc?.start.column ?? 0) + 1, rule, severity: r.severity, test, message: detail ? `${r.why} ${detail}` : r.why, fix: r.fix });
  };

  // Focused tests and suites anywhere in the file.
  walk(ast, (n) => {
    if (n.type === 'CallExpression' && (n.callee as Node).type === 'MemberExpression' && calleeName(n.callee as Node) === 'only') add(n, 'focused-test');
  });

  const helpers = assertingHelpers(ast);
  const tests = findTests(ast, testNames(ast));
  for (const t of tests) {
    if (!t.body || t.modifier === 'skip' || t.modifier === 'fixme') continue;
    let asserts = false;
    walk(t.body, (n, parents) => {
      const parent = parents[parents.length - 1];
      if (n.type === 'CallExpression') {
        const callee = n.callee as Node;
        const name = calleeName(callee);
        const root = expectRoot(n);
        if (root) {
          asserts = true;
          const matcher = name;
          const arg = (root.arguments as Node[])[0];
          // Only the outermost call of a chain: expect(x).not.toBe(...) is the matcher call.
          if (callee.type === 'MemberExpression' && root !== n) {
            const soft = calleeName(root.callee as Node) === 'poll';
            if ((matcher && ASYNC_MATCHERS.has(matcher)) || soft) {
              const handled = parents.some((p) => p.type === 'AwaitExpression' || p.type === 'ReturnStatement' || p.type === 'ArrayExpression' || (p.type === 'ArrowFunctionExpression' && p.body === n));
              if (!handled && parent?.type === 'ExpressionStatement') add(n, 'unawaited-assertion', t.title, `(${matcher})`);
            }
            if (arg && ['BooleanLiteral', 'NumericLiteral', 'StringLiteral', 'NullLiteral'].includes(arg.type)) add(n, 'trivial-assertion', t.title);
          }
          return;
        }
        if (name && (ASSERTING_NAME.test(name) || helpers.has(name))) asserts = true;
        if (name === 'waitForTimeout') add(n, 'hard-wait', t.title);
        if (name && ACTIONS.has(name)) {
          for (const a of n.arguments as Node[]) {
            if (a.type !== 'ObjectExpression') continue;
            for (const p of a.properties as Node[]) {
              if (p.type === 'ObjectProperty' && isNode(p.key) && (p.key.name === 'force' || p.key.value === 'force') && isNode(p.value) && p.value.type === 'BooleanLiteral' && p.value.value === true) add(p, 'force-action', t.title);
            }
          }
        }
      }
      // new Promise((r) => setTimeout(r, 1000))
      if (n.type === 'NewExpression' && (n.callee as Node).type === 'Identifier' && (n.callee as Node).name === 'Promise') {
        let sleeps = false;
        walk(n, (x) => {
          if (x.type === 'CallExpression' && (x.callee as Node).type === 'Identifier' && (x.callee as Node).name === 'setTimeout') sleeps = true;
        });
        if (sleeps) add(n, 'hard-wait', t.title);
      }
      if (n.type === 'TryStatement' && isNode(n.handler)) {
        const stmts = ((n.handler.body as Node).body as Node[]) ?? [];
        const onlyLogs = stmts.every(
          (s) => s.type === 'ExpressionStatement' && isNode(s.expression) && s.expression.type === 'CallExpression' && isNode(s.expression.callee) && s.expression.callee.type === 'MemberExpression' && isNode(s.expression.callee.object) && s.expression.callee.object.name === 'console',
        );
        let awaits = false;
        walk(n.block as Node, (x) => {
          if (x.type === 'AwaitExpression') awaits = true;
        });
        if (onlyLogs && awaits) add(n, 'swallowed-error', t.title);
      }
    });
    if (!asserts) add(t.node, 'no-assertion', t.title);
  }
  return { findings, tests: tests.length };
}

const TEST_FILE = /\.(spec|test)\.[cm]?[jt]sx?$/;
export function findTestFiles(paths: string[]): string[] {
  const out: string[] = [];
  const visit = (p: string) => {
    let s;
    try {
      s = statSync(p);
    } catch {
      return;
    }
    if (s.isDirectory()) {
      const base = path.basename(p);
      if (base === 'node_modules' || base.startsWith('.') && base !== '.' && base !== '..') return;
      for (const e of readdirSync(p)) visit(path.join(p, e));
    } else if (TEST_FILE.test(p)) out.push(p);
  };
  for (const p of paths) visit(p);
  return [...new Set(out)].sort();
}

export interface AnalyzeResult {
  files: number;
  tests: number;
  findings: Finding[];
}

export function analyzePaths(paths: string[], cwd = process.cwd()): AnalyzeResult {
  const files = findTestFiles(paths.length ? paths : ['.']);
  const findings: Finding[] = [];
  let tests = 0;
  for (const f of files) {
    const r = analyzeSource(readFileSync(f, 'utf8'), path.relative(cwd, path.resolve(f)).replace(/\\/g, '/'));
    findings.push(...r.findings);
    tests += r.tests;
  }
  return { files: files.length, tests, findings };
}

export function formatText(r: AnalyzeResult): string {
  const icon = { error: '✖', warning: '▲', info: '·' } as const;
  const lines: string[] = [];
  let lastFile = '';
  for (const f of r.findings) {
    if (f.file !== lastFile) {
      lines.push('', f.file);
      lastFile = f.file;
    }
    lines.push(`  ${icon[f.severity]} ${f.line}:${f.column}  ${f.rule}${f.test ? `  (${f.test})` : ''}`, `      ${f.message}`, `      fix: ${f.fix}`);
  }
  const count = (s: Severity) => r.findings.filter((f) => f.severity === s).length;
  lines.push(
    '',
    `turnsignal analyze v0: ${r.tests} test(s) in ${r.files} file(s): ${count('error')} error(s), ${count('warning')} warning(s), ${count('info')} note(s).`,
    'Static rules only; your source code never leaves this machine.',
  );
  return lines.join('\n').replace(/^\n/, '');
}
