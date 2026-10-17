import { execFileSync } from 'node:child_process';
import { analyzeSource } from './analyze.js';
import { calleeName, expectRoot, findTests, isNode, parseSource, testNames, walk, type Node, type TestCall } from './ast.js';

/**
 * `turnsignal governance` v0 (ADR-039): Heal Governance for pull requests. Compares every changed
 * test with its version on the base branch and says what kind of change it is (locator only, wait
 * added, assertion weakened, expectation changed, test disabled, ...), so a reviewer sees the
 * changes that could turn a real bug green. Runs on the CI machine with git; nothing is uploaded.
 */

export type ChangeClass =
  | 'TEST_DISABLED'
  | 'ASSERTION_WEAKENED'
  | 'EXPECTATION_CHANGED'
  | 'WAIT_ADDED'
  | 'SNAPSHOT_UPDATED'
  | 'STEPS_CHANGED'
  | 'NEW_TEST'
  | 'LOCATOR_ONLY'
  | 'TEST_RENAMED';

export type Policy = 'review' | 'warn' | 'info' | 'ok';

export const CLASSES: Record<ChangeClass, { policy: Policy; label: string; why: string }> = {
  TEST_DISABLED: {
    policy: 'review',
    label: 'Test disabled or deleted',
    why: 'A test that no longer runs can hide a real bug. Make sure there is a reason and a plan to bring it back.',
  },
  ASSERTION_WEAKENED: {
    policy: 'review',
    label: 'Assertion weakened',
    why: 'The test now checks less than before, so a bug it used to catch can pass. This is how an AI "fix" can turn a real failure green.',
  },
  EXPECTATION_CHANGED: {
    policy: 'review',
    label: 'Expected value changed',
    why: 'The test now expects a different result. Confirm the new value is the intended behavior, not the bug.',
  },
  WAIT_ADDED: {
    policy: 'warn',
    label: 'Wait or timeout added',
    why: 'Sleeps, longer timeouts and `force: true` often hide a slow or broken page instead of fixing the test.',
  },
  SNAPSHOT_UPDATED: {
    policy: 'warn',
    label: 'Snapshot updated',
    why: 'An updated baseline accepts whatever the page shows now. Look at the before and after images or trees.',
  },
  STEPS_CHANGED: {
    policy: 'info',
    label: 'Steps changed',
    why: 'The test does something different now. Read the diff.',
  },
  NEW_TEST: { policy: 'info', label: 'New test', why: 'New coverage. Static checks below, if any.' },
  LOCATOR_ONLY: { policy: 'ok', label: 'Locator only', why: 'Only how elements are found changed; the steps and assertions are the same.' },
  TEST_RENAMED: { policy: 'ok', label: 'Renamed', why: 'Same steps and assertions under a new name.' },
};

const ORDER: ChangeClass[] = ['TEST_DISABLED', 'ASSERTION_WEAKENED', 'EXPECTATION_CHANGED', 'WAIT_ADDED', 'SNAPSHOT_UPDATED', 'STEPS_CHANGED', 'NEW_TEST', 'LOCATOR_ONLY', 'TEST_RENAMED'];

export const TEST_FILE = /\.(spec|test)\.[cm]?[jt]sx?$/;
const SNAPSHOT_FILE = /(^|\/)[^/]*-snapshots\/|(^|\/)__snapshots__\/|\.aria\.ya?ml$|\.snap$/;
/** Files that belong to the test suite without being tests (page objects, fixtures, config). */
const HELPER_FILE = /(^|\/)(e2e|tests?|__tests__|playwright|specs?|fixtures|page-objects|pageobjects)\/|(^|\/)playwright\.config\.[cm]?[jt]s$|\.(page|po|fixture|fixtures)\.[cm]?[jt]sx?$/i;
/** Changes that aren't application behavior: docs, CI config, lockfiles. */
const NOT_APP = /(^|\/)\.github\/|\.(md|mdx|txt)$|(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?)$|(^|\/)\.[^/]+$/;

/** Assertion strength: a drop between two known matchers means the test now checks less. */
const STRENGTH: Record<string, number> = {};
for (const m of ['toBeTruthy', 'toBeFalsy', 'toBeDefined', 'toBeAttached', 'toBeVisible', 'toBeInViewport', 'toBeOK']) STRENGTH[m] = 0;
for (const m of ['toContainText', 'toContain', 'toContainEqual', 'toMatch', 'toMatchObject', 'toHaveProperty', 'toContainClass', 'toHaveLength', 'toBeGreaterThan', 'toBeGreaterThanOrEqual', 'toBeLessThan', 'toBeLessThanOrEqual', 'toBeCloseTo'])
  STRENGTH[m] = 1;
for (const m of [
  'toHaveText', 'toHaveValue', 'toHaveValues', 'toEqual', 'toStrictEqual', 'toBe', 'toBeNull', 'toBeUndefined', 'toHaveURL', 'toHaveTitle', 'toHaveAttribute', 'toHaveCount',
  'toMatchAriaSnapshot', 'toHaveScreenshot', 'toMatchSnapshot', 'toHaveClass', 'toHaveAccessibleName', 'toHaveJSProperty', 'toHaveCSS', 'toHaveId', 'toHaveRole',
  'toBeChecked', 'toBeEnabled', 'toBeDisabled', 'toBeHidden', 'toBeEmpty', 'toBeEditable', 'toBeFocused',
])
  STRENGTH[m] = 2;

const LOCATOR_METHODS = new Set(['getByRole', 'getByText', 'getByLabel', 'getByPlaceholder', 'getByAltText', 'getByTitle', 'getByTestId', 'locator', 'frameLocator', '$', '$$', 'filter', 'nth', 'first', 'last', 'and', 'or']);

// ---------------------------------------------------------------------------------------------
// Fingerprint of one test body

interface Assertion {
  matcher: string;
  not: boolean;
  soft: boolean;
  subject: string;
  expected: string;
  text: string;
}

export interface Fingerprint {
  assertions: Assertion[];
  locators: string[];
  hardWaits: number;
  forces: number;
  maxTimeout: number;
  slow: boolean;
  skips: number;
  shape: string;
}

const squash = (s: string) => s.replace(/\s+/g, ' ').trim();
const short = (s: string, max = 90) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

function src(source: string, n: Node): string {
  return typeof n.start === 'number' && typeof n.end === 'number' ? squash(source.slice(n.start as number, n.end as number)) : '';
}

const isTimeoutOnly = (n: Node) =>
  n.type === 'ObjectExpression' &&
  (n.properties as Node[]).length > 0 &&
  (n.properties as Node[]).every((p) => p.type === 'ObjectProperty' && isNode(p.key) && (p.key.name === 'timeout' || p.key.value === 'timeout'));

/** The outermost call of an `expect(...)...matcher(...)` chain, as an assertion. */
function assertionOf(n: Node, source: string): Assertion | null {
  if (n.type !== 'CallExpression') return null;
  const root = expectRoot(n);
  const callee = n.callee as Node;
  if (!root || root === n || callee.type !== 'MemberExpression') return null;
  const matcher = calleeName(callee);
  if (!matcher) return null;
  let not = false;
  for (let c: Node = callee.object as Node; c && c !== root; c = (c.type === 'MemberExpression' ? c.object : c.callee) as Node) {
    if (c.type === 'MemberExpression' && calleeName(c) === 'not') not = true;
    if (c.type !== 'MemberExpression' && c.type !== 'CallExpression') break;
  }
  const soft = calleeName(root.callee as Node) === 'soft';
  const subjectNode = (root.arguments as Node[])[0];
  const expected = (n.arguments as Node[]).filter((a) => !isTimeoutOnly(a)).map((a) => src(source, a)).join(', ');
  return { matcher, not, soft, subject: subjectNode ? src(source, subjectNode) : '', expected, text: short(src(source, n)) };
}

const isWaitCall = (n: Node) => n.type === 'CallExpression' && calleeName(n.callee as Node) === 'waitForTimeout';
const isSleep = (n: Node) => {
  if (n.type !== 'NewExpression' || (n.callee as Node).type !== 'Identifier' || (n.callee as Node).name !== 'Promise') return false;
  let sleeps = false;
  walk(n, (x) => {
    if (x.type === 'CallExpression' && (x.callee as Node).type === 'Identifier' && (x.callee as Node).name === 'setTimeout') sleeps = true;
  });
  return sleeps;
};
/** `test.skip()` / `test.fixme()` / `test.skip(condition, reason)` inside a test body. */
const isSkipCall = (n: Node, names: Set<string>) => {
  if (n.type !== 'CallExpression') return false;
  const c = n.callee as Node;
  const m = calleeName(c);
  return c.type === 'MemberExpression' && (m === 'skip' || m === 'fixme' || m === 'fail') && (c.object as Node).type === 'Identifier' && names.has((c.object as Node).name as string);
};
const isSlowCall = (n: Node, names: Set<string>) =>
  n.type === 'CallExpression' &&
  (n.callee as Node).type === 'MemberExpression' &&
  ['slow', 'setTimeout'].includes(calleeName(n.callee as Node) ?? '') &&
  ((n.callee as Node).object as Node).type === 'Identifier' &&
  names.has(((n.callee as Node).object as Node).name as string);

/** Statements that are only an assertion, a wait or a skip: they don't count as "steps". */
function isNonStep(stmt: Node, names: Set<string>): boolean {
  if (stmt.type !== 'ExpressionStatement') return false;
  let e = stmt.expression as Node;
  while (e.type === 'AwaitExpression' || e.type === 'ParenthesizedExpression') e = (e.argument ?? e.expression) as Node;
  return Boolean(assertionOf(e, '')) || isWaitCall(e) || isSleep(e) || isSkipCall(e, names) || isSlowCall(e, names);
}

const isWaitOption = (n: Node) => n.type === 'ObjectProperty' && isNode(n.key) && ['timeout', 'force'].includes((n.key.name ?? n.key.value) as string);

/** Structure of the steps: node types, names and literal values, without assertions, waits and locator arguments. */
function shapeOf(n: Node, names: Set<string>, out: string[]): void {
  if (n.type === 'ExpressionStatement' && isNonStep(n, names)) return;
  if (n.type === 'CallExpression' && LOCATOR_METHODS.has(calleeName(n.callee as Node) ?? '')) {
    // Which locator method and its arguments are "locators"; only the receiver is part of the steps.
    out.push('L(');
    const callee = n.callee as Node;
    if (callee.type === 'MemberExpression') shapeOf(callee.object as Node, names, out);
    out.push(')');
    return;
  }
  if (isWaitOption(n)) return;
  // `click({ force: true })` vs `click()`: the options object only carries waits.
  if (n.type === 'ObjectExpression' && (n.properties as Node[]).length > 0 && (n.properties as Node[]).every(isWaitOption)) return;
  out.push(n.type);
  if (n.type === 'Identifier') out.push(`:${n.name as string}`);
  else if (n.type.endsWith('Literal') && 'value' in n) out.push(`=${JSON.stringify(n.value)}`);
  else if ('operator' in n) out.push(`:${String(n.operator)}`);
  out.push('{');
  for (const [k, v] of Object.entries(n)) {
    if (k === 'loc' || k === 'start' || k === 'end' || k === 'extra' || k.endsWith('Comments') || k === 'range') continue;
    if (Array.isArray(v)) for (const x of v) isNode(x) && shapeOf(x, names, out);
    else if (isNode(v)) shapeOf(v, names, out);
  }
  out.push('}');
}

export function fingerprint(body: Node | undefined, source: string, names: Set<string>): Fingerprint {
  const fp: Fingerprint = { assertions: [], locators: [], hardWaits: 0, forces: 0, maxTimeout: 0, slow: false, skips: 0, shape: '' };
  if (!body) return fp;
  walk(body, (n) => {
    const a = assertionOf(n, source);
    if (a) fp.assertions.push(a);
    if (n.type === 'CallExpression') {
      const name = calleeName(n.callee as Node);
      if (name && LOCATOR_METHODS.has(name)) fp.locators.push(`${name}(${(n.arguments as Node[]).map((x) => src(source, x)).join(', ')})`);
      if (isWaitCall(n)) fp.hardWaits++;
      if (isSkipCall(n, names)) fp.skips++;
      if (isSlowCall(n, names)) {
        if (calleeName(n.callee as Node) === 'slow') fp.slow = true;
        const arg = (n.arguments as Node[])[0];
        if (arg?.type === 'NumericLiteral') fp.maxTimeout = Math.max(fp.maxTimeout, arg.value as number);
      }
    }
    if (isSleep(n)) fp.hardWaits++;
    if (n.type === 'ObjectProperty' && isNode(n.key) && isNode(n.value)) {
      const key = (n.key.name ?? n.key.value) as string;
      if (key === 'force' && n.value.type === 'BooleanLiteral' && n.value.value === true) fp.forces++;
      if (key === 'timeout' && n.value.type === 'NumericLiteral') fp.maxTimeout = Math.max(fp.maxTimeout, n.value.value as number);
    }
  });
  const out: string[] = [];
  shapeOf(body, names, out);
  fp.shape = out.join('');
  return fp;
}

// ---------------------------------------------------------------------------------------------
// Comparing two versions of a test

export interface TestChange {
  file: string;
  line: number;
  /** Describe titles + test title. */
  title: string[];
  classes: ChangeClass[];
  /** One plain sentence per thing that changed, with before → after. */
  details: string[];
  /** Static checks on new tests (analyze rules; errors and warnings only). */
  findings?: { rule: string; line: number; message: string }[];
  renamedFrom?: string;
}

const sig = (a: Assertion) => `${a.soft ? 'soft:' : ''}${a.not ? 'not.' : ''}${a.matcher}(${a.expected})|${a.subject}`;
const disabledBy = (m?: string) => (m === 'skip' ? 'test.skip' : m === 'fixme' ? 'test.fixme' : m === 'fail' ? 'test.fail' : null);

/** Multiset difference, keeping order: items of `a` not matched by an equal item of `b`. */
function minus<T>(a: T[], b: T[], key: (x: T) => string): T[] {
  const left = new Map<string, number>();
  for (const x of b) left.set(key(x), (left.get(key(x)) ?? 0) + 1);
  return a.filter((x) => {
    const n = left.get(key(x)) ?? 0;
    if (n > 0) {
      left.set(key(x), n - 1);
      return false;
    }
    return true;
  });
}

export function compareTests(
  before: { fp: Fingerprint; modifier?: string },
  after: { fp: Fingerprint; modifier?: string },
): { classes: ChangeClass[]; details: string[] } {
  const classes = new Set<ChangeClass>();
  const details: string[] = [];
  const o = before.fp;
  const n = after.fp;

  const wasOff = disabledBy(before.modifier);
  const isOff = disabledBy(after.modifier);
  if (isOff && isOff !== wasOff) {
    classes.add('TEST_DISABLED');
    details.push(isOff === 'test.fail' ? 'Marked `test.fail`: the test is now expected to fail, so a pass is reported as a failure and a failure as a pass.' : `Marked \`${isOff}\`: the test no longer runs.`);
  }
  if (n.skips > o.skips) {
    classes.add('TEST_DISABLED');
    details.push('Adds a `test.skip`/`test.fixme` call inside the test: it stops running (possibly only under a condition).');
  }

  const removed = minus(o.assertions, n.assertions, sig);
  const added = minus(n.assertions, o.assertions, sig);
  const pairs = Math.min(removed.length, added.length);
  let locatorInAssertion = false;
  for (let i = 0; i < pairs; i++) {
    const b = removed[i]!;
    const a = added[i]!;
    const change = `\`${b.text}\` → \`${a.text}\``;
    const sb = STRENGTH[b.matcher];
    const sa = STRENGTH[a.matcher];
    if (!b.soft && a.soft) {
      classes.add('ASSERTION_WEAKENED');
      details.push(`${change}: \`expect.soft\` records the failure but lets the test continue.`);
    } else if (sb !== undefined && sa !== undefined && sa < sb) {
      classes.add('ASSERTION_WEAKENED');
      details.push(`${change}: \`${a.matcher}\` checks less than \`${b.matcher}\`.`);
    } else if (b.not !== a.not) {
      classes.add('EXPECTATION_CHANGED');
      details.push(`${change}: the assertion is now negated.`);
    } else if (b.matcher !== a.matcher || b.expected !== a.expected) {
      classes.add('EXPECTATION_CHANGED');
      details.push(`${change}: different expected result.`);
    } else {
      locatorInAssertion = true;
    }
  }
  if (removed.length > added.length) {
    classes.add('ASSERTION_WEAKENED');
    const gone = removed.slice(pairs);
    details.push(`${gone.length === 1 ? 'Assertion removed' : `${gone.length} assertions removed`}: ${gone.map((a) => `\`${a.text}\``).join(', ')}.`);
  }
  if (added.length > removed.length) {
    details.push(`${added.length - removed.length === 1 ? 'Assertion added' : `${added.length - removed.length} assertions added`}: ${added.slice(pairs).map((a) => `\`${a.text}\``).join(', ')}.`);
  }

  if (n.hardWaits > o.hardWaits) {
    classes.add('WAIT_ADDED');
    details.push(`${n.hardWaits - o.hardWaits === 1 ? 'A fixed sleep was' : `${n.hardWaits - o.hardWaits} fixed sleeps were`} added (\`waitForTimeout\` / \`setTimeout\`).`);
  }
  if (n.forces > o.forces) {
    classes.add('WAIT_ADDED');
    details.push('`force: true` added: skips the checks that a user could actually click the element.');
  }
  if (n.maxTimeout > o.maxTimeout) {
    classes.add('WAIT_ADDED');
    details.push(`Longer timeout: ${o.maxTimeout ? `${o.maxTimeout} ms` : 'default'} → ${n.maxTimeout} ms.`);
  }
  if (n.slow && !o.slow) {
    classes.add('WAIT_ADDED');
    details.push('`test.slow()` added: the timeout is tripled.');
  }

  const locatorsChanged = locatorInAssertion || minus(o.locators, n.locators, (x) => x).length > 0 || minus(n.locators, o.locators, (x) => x).length > 0;
  const stepsChanged = o.shape !== n.shape;
  if (stepsChanged) {
    classes.add('STEPS_CHANGED');
    details.push('The steps changed (actions or code other than assertions, waits and locators).');
  }
  if (locatorsChanged) {
    const gone = minus(o.locators, n.locators, (x) => x);
    const now = minus(n.locators, o.locators, (x) => x);
    if (gone.length || now.length) details.push(`Locators: ${gone.map((l) => `\`${short(l, 60)}\``).join(', ') || '(none)'} → ${now.map((l) => `\`${short(l, 60)}\``).join(', ') || '(none)'}.`);
    if (!classes.size) classes.add('LOCATOR_ONLY');
  }
  if (!classes.size && added.length > removed.length) classes.add('STEPS_CHANGED');
  return { classes: ORDER.filter((c) => classes.has(c)), details };
}

// ---------------------------------------------------------------------------------------------
// Files

interface ParsedTest {
  key: string;
  title: string[];
  line: number;
  modifier?: string;
  fp: Fingerprint;
}

export function parseTests(source: string, file: string): ParsedTest[] {
  const ast = parseSource(source, file);
  if (!ast) return [];
  const names = testNames(ast);
  const seen = new Map<string, number>();
  return findTests(ast, names).map((t: TestCall) => {
    const title = [...t.describes, t.title];
    const base = title.join(' › ');
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return { key: n > 1 ? `${base} #${n}` : base, title, line: t.node.loc?.start.line ?? 0, modifier: t.modifier, fp: fingerprint(t.body, source, names) };
  });
}

const sameBody = (a: Fingerprint, b: Fingerprint) =>
  a.shape === b.shape && a.assertions.map(sig).join('\n') === b.assertions.map(sig).join('\n') && a.locators.join('\n') === b.locators.join('\n');

/** Every test-level change between two versions of one test file (either side may be missing). */
export function compareFile(file: string, before: string | null, after: string | null): TestChange[] {
  const old = before == null ? [] : parseTests(before, file);
  const now = after == null ? [] : parseTests(after, file);
  const oldBy = new Map(old.map((t) => [t.key, t]));
  const newBy = new Map(now.map((t) => [t.key, t]));
  const changes: TestChange[] = [];

  for (const t of now) {
    const prev = oldBy.get(t.key);
    if (!prev) continue;
    const { classes, details } = compareTests({ fp: prev.fp, modifier: prev.modifier }, { fp: t.fp, modifier: t.modifier });
    if (classes.length) changes.push({ file, line: t.line, title: t.title, classes, details });
  }

  const gone = old.filter((t) => !newBy.has(t.key));
  const added = now.filter((t) => !oldBy.has(t.key));
  for (const g of [...gone]) {
    const twin = added.find((a) => sameBody(a.fp, g.fp) && a.modifier === g.modifier);
    if (!twin) continue;
    gone.splice(gone.indexOf(g), 1);
    added.splice(added.indexOf(twin), 1);
    changes.push({ file, line: twin.line, title: twin.title, classes: ['TEST_RENAMED'], details: [`Renamed from "${g.title.join(' › ')}".`], renamedFrom: g.key });
  }
  for (const g of gone) {
    changes.push({
      file,
      line: g.line,
      title: g.title,
      classes: ['TEST_DISABLED'],
      details: [after == null ? 'The test file was deleted.' : `The test was deleted${g.fp.assertions.length ? ` (it had ${g.fp.assertions.length} assertion${g.fp.assertions.length === 1 ? '' : 's'})` : ''}.`],
    });
  }
  if (added.length && after != null) {
    const findings = analyzeSource(after, file).findings.filter((f) => f.severity !== 'info');
    for (const a of added) {
      const mine = findings.filter((f) => f.test === a.title[a.title.length - 1] && f.line >= a.line);
      const disabled = disabledBy(a.modifier);
      changes.push({
        file,
        line: a.line,
        title: a.title,
        classes: ['NEW_TEST'],
        details: [`${a.fp.assertions.length} assertion${a.fp.assertions.length === 1 ? '' : 's'}${disabled ? `; added as \`${disabled}\`` : ''}.`],
        findings: mine.map((f) => ({ rule: f.rule, line: f.line, message: f.message })),
      });
    }
  }
  return changes.sort((a, b) => a.line - b.line);
}

// ---------------------------------------------------------------------------------------------
// Provenance: who or what made the change

export type Author = 'human' | 'ai-assisted' | 'agent' | 'bot' | 'unknown';
export interface Provenance {
  kind: Author;
  /** e.g. "Claude", "Copilot", "dependabot[bot]" */
  names: string[];
}

const AGENTS: [RegExp, string][] = [
  [/claude|anthropic/i, 'Claude'],
  [/copilot/i, 'Copilot'],
  [/cursor/i, 'Cursor'],
  [/codex|openai|chatgpt/i, 'Codex'],
  [/devin/i, 'Devin'],
  [/aider/i, 'Aider'],
  [/gemini|jules/i, 'Gemini'],
  [/windsurf|codeium/i, 'Windsurf'],
  [/openhands/i, 'OpenHands'],
  [/amazon ?q|codewhisperer/i, 'Amazon Q'],
  [/cline/i, 'Cline'],
];
const agentOf = (s: string) => AGENTS.find(([re]) => re.test(s))?.[1];
const RANK: Author[] = ['unknown', 'human', 'bot', 'ai-assisted', 'agent'];

/** Classifies commits (author + message) touching a file. The most "automated" kind wins. */
export function provenanceOf(commits: { author: string; email: string; message: string }[]): Provenance {
  let kind: Author = 'unknown';
  const names = new Set<string>();
  const bump = (k: Author) => {
    if (RANK.indexOf(k) > RANK.indexOf(kind)) kind = k;
  };
  for (const c of commits) {
    const who = `${c.author} ${c.email}`;
    const agent = agentOf(who);
    const bot = /\[bot\]/i.test(who);
    if (agent) {
      bump('agent');
      names.add(agent);
    } else if (bot) {
      bump('bot');
      names.add(c.author);
    } else bump('human');
    for (const m of c.message.matchAll(/^co-authored-by:\s*(.+)$/gim)) {
      const a = agentOf(m[1]!);
      if (a) {
        bump('ai-assisted');
        names.add(a);
      }
    }
    for (const m of c.message.matchAll(/generated (?:with|by) \[?([\w .-]+)/gi)) {
      const a = agentOf(m[1]!);
      if (a) {
        bump('ai-assisted');
        names.add(a);
      }
    }
  }
  return { kind, names: [...names] };
}

export function provenanceLabel(p: Provenance | undefined): string {
  if (!p || p.kind === 'unknown') return '';
  const who = p.names.length ? ` (${p.names.join(', ')})` : '';
  return p.kind === 'agent' ? `by an agent${who}` : p.kind === 'ai-assisted' ? `AI-assisted${who}` : p.kind === 'bot' ? `by a bot${who}` : 'by a person';
}

// ---------------------------------------------------------------------------------------------
// Git

export interface GovernanceResult {
  base: string;
  mergeBase: string;
  tests: TestChange[];
  snapshots: { file: string; status: 'added' | 'changed' | 'deleted' }[];
  /** Test helpers (page objects, fixtures, config) that changed: listed, not classified in v0. */
  helpers: string[];
  /** Application files changed in the same PR (makes an expected-value change riskier). */
  appFiles: string[];
  provenance: Record<string, Provenance>;
}

export type GovernanceOutcome = { ok: true; result: GovernanceResult } | { ok: false; reason: string };

type Git = (args: string[]) => string;

function gitRunner(cwd: string): Git {
  return (args) => execFileSync('git', args, { cwd, encoding: 'utf8', timeout: 30_000, maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
}

function tryGit(git: Git, args: string[]): string | null {
  try {
    return git(args);
  } catch {
    return null;
  }
}

/** Base ref: --base, else the PR/MR target branch from CI, else origin/main, origin/master, main, master. */
function resolveBase(git: Git, explicit: string | undefined, env: Record<string, string | undefined>): string | null {
  const exists = (ref: string) => tryGit(git, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]) !== null;
  if (explicit) return exists(explicit) ? explicit : null;
  if (env.CI_MERGE_REQUEST_DIFF_BASE_SHA && exists(env.CI_MERGE_REQUEST_DIFF_BASE_SHA)) return env.CI_MERGE_REQUEST_DIFF_BASE_SHA;
  const target = env.GITHUB_BASE_REF || env.CI_MERGE_REQUEST_TARGET_BRANCH_NAME || env.BITBUCKET_PR_DESTINATION_BRANCH;
  const candidates = target ? [`origin/${target}`, target] : ['origin/main', 'origin/master', 'main', 'master'];
  return candidates.find(exists) ?? null;
}

type Status = { status: string; path: string; oldPath?: string };

function changedFiles(git: Git, from: string): Status[] {
  const raw = git(['-c', 'core.quotepath=off', 'diff', '--name-status', '-z', '-M', from, 'HEAD']);
  const parts = raw.split('\0').filter((p) => p.length);
  const out: Status[] = [];
  for (let i = 0; i < parts.length; ) {
    const status = parts[i++]!;
    if (status.startsWith('R') || status.startsWith('C')) {
      const oldPath = parts[i++]!;
      out.push({ status: status[0]!, oldPath, path: parts[i++]! });
    } else out.push({ status: status[0]!, path: parts[i++]! });
  }
  return out;
}

export function runGovernance(opts: { base?: string; cwd?: string; env?: Record<string, string | undefined>; git?: Git }): GovernanceOutcome {
  const env = opts.env ?? process.env;
  const git = opts.git ?? gitRunner(opts.cwd ?? process.cwd());
  if (tryGit(git, ['rev-parse', '--is-inside-work-tree'])?.trim() !== 'true') return { ok: false, reason: 'not a git repository (or git is not installed)' };
  const base = resolveBase(git, opts.base, env);
  if (!base) {
    return {
      ok: false,
      reason: opts.base
        ? `base "${opts.base}" not found; fetch it first (e.g. git fetch origin ${opts.base.replace(/^origin\//, '')})`
        : 'no base branch found; pass --base origin/<branch> (in GitHub Actions use actions/checkout with fetch-depth: 0)',
    };
  }
  const mergeBase = tryGit(git, ['merge-base', base, 'HEAD'])?.trim();
  if (!mergeBase) return { ok: false, reason: `no common history with ${base}: the clone is probably shallow (use fetch-depth: 0 in actions/checkout)` };

  const files = changedFiles(git, mergeBase);
  const show = (rev: string, p: string) => tryGit(git, ['show', `${rev}:${p}`]);
  const tests: TestChange[] = [];
  const snapshots: GovernanceResult['snapshots'] = [];
  const helpers: string[] = [];
  const appFiles: string[] = [];
  const provenance: Record<string, Provenance> = {};

  for (const f of files) {
    if (TEST_FILE.test(f.path) || (f.oldPath && TEST_FILE.test(f.oldPath))) {
      const before = f.status === 'A' ? null : show(mergeBase, f.oldPath ?? f.path);
      const after = f.status === 'D' ? null : show('HEAD', f.path);
      tests.push(...compareFile(f.path, before, after));
      const log = tryGit(git, ['log', '--no-merges', '--format=%an%x1f%ae%x1f%B%x1e', `${mergeBase}..HEAD`, '--', f.path]) ?? '';
      const commits = log
        .split('\x1e')
        .map((c) => c.trim())
        .filter(Boolean)
        .map((c) => {
          const [author = '', email = '', message = ''] = c.split('\x1f');
          return { author, email, message };
        });
      provenance[f.path] = provenanceOf(commits);
    } else if (SNAPSHOT_FILE.test(f.path)) {
      snapshots.push({ file: f.path, status: f.status === 'A' ? 'added' : f.status === 'D' ? 'deleted' : 'changed' });
    } else if (HELPER_FILE.test(f.path)) helpers.push(f.path);
    else if (!NOT_APP.test(f.path)) appFiles.push(f.path);
  }

  if (appFiles.length) {
    const note = `This PR also changes ${appFiles.length} application file${appFiles.length === 1 ? '' : 's'} (e.g. ${appFiles.slice(0, 2).join(', ')}): check that the new expected value is the intended behavior and not the bug the change introduced.`;
    for (const t of tests) if (t.classes.includes('EXPECTATION_CHANGED')) t.details.push(note);
  }
  return { ok: true, result: { base, mergeBase, tests, snapshots, helpers, appFiles, provenance } };
}

// ---------------------------------------------------------------------------------------------
// Output

export const GOV_MARKER = '<!-- turnsignal-governance -->';
const policyOf = (t: TestChange): Policy => CLASSES[t.classes[0]!].policy;

export function counts(r: GovernanceResult): { review: number; warn: number; info: number; ok: number } {
  const c = { review: 0, warn: 0, info: 0, ok: 0 };
  for (const t of r.tests) c[policyOf(t)]++;
  c.warn += r.snapshots.filter((s) => s.status !== 'added').length;
  return c;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function tally(r: GovernanceResult): string {
  const byClass = new Map<ChangeClass, number>();
  for (const t of r.tests) byClass.set(t.classes[0]!, (byClass.get(t.classes[0]!) ?? 0) + 1);
  const snaps = r.snapshots.filter((s) => s.status !== 'added').length;
  if (snaps) byClass.set('SNAPSHOT_UPDATED', (byClass.get('SNAPSHOT_UPDATED') ?? 0) + snaps);
  return ORDER.filter((c) => byClass.has(c))
    .map((c) => `${byClass.get(c)} ${CLASSES[c].label.toLowerCase()}`)
    .join(' · ');
}

function headline(r: GovernanceResult): { icon: string; text: string } {
  const c = counts(r);
  if (!r.tests.length && !r.snapshots.length) return { icon: '✅', text: 'No test changes in this pull request.' };
  if (c.review) return { icon: '⚠️', text: `Test changes: ${plural(c.review, 'test needs', 'tests need')} a human review.` };
  if (c.warn) return { icon: 'ℹ️', text: `Test changes: nothing weakened, ${plural(c.warn, 'change')} worth a look.` };
  return { icon: '✅', text: 'Test changes: nothing weakened or disabled.' };
}

const md = (text: string) => text.replace(/[\\`*_{}[\]<>|#]/g, (ch) => `\\${ch}`).replace(/\r?\n/g, ' ');
/** Keeps `code spans` from the details as code, escapes the rest. */
const mdDetail = (text: string) =>
  text
    .split(/(`[^`]*`)/)
    .map((part, i) => (i % 2 ? `\`${part.slice(1, -1).replace(/`/g, "'")}\`` : md(part)))
    .join('');

export interface RenderOptions {
  /** Add the attribution line (ADR-050). The CLI sets it unless a self-hosted server is configured. */
  attribution?: boolean;
  /** No TurnSignal token in this job: the attribution line also says what a free token adds. */
  tokenless?: boolean;
}

export function renderMarkdown(r: GovernanceResult, opts: RenderOptions = {}): string {
  const h = headline(r);
  const lines = [GOV_MARKER, `### ${h.icon} ${md(h.text)}`];
  const t = tally(r);
  if (t) lines.push(t);
  const item = (c: TestChange) => {
    const who = provenanceLabel(r.provenance[c.file]);
    const labels = c.classes.map((k) => CLASSES[k].label).join(', ');
    const body = [
      `- **${md(c.title.join(' › '))}** (\`${c.file.replace(/`/g, '')}:${c.line}\`) · ${labels}${who ? ` · ${md(who)}` : ''}`,
      ...c.details.map((d) => `  - ${mdDetail(d)}`),
      ...(c.findings ?? []).map((f) => `  - Static check \`${f.rule}\` (line ${f.line}): ${md(f.message)}`),
    ];
    if (policyOf(c) === 'review' || policyOf(c) === 'warn') body.push(`  - Why it matters: ${md(CLASSES[c.classes[0]!].why)}`);
    return body.join('\n');
  };
  const group = (title: string, items: TestChange[], fold = false) => {
    if (!items.length) return;
    const inner = items.slice(0, 25).map(item);
    if (items.length > 25) inner.push(`- …and ${items.length - 25} more (run \`npx turnsignal governance\` locally for all).`);
    if (fold) lines.push('', `<details><summary>${md(title)} (${items.length})</summary>`, '', ...inner, '', '</details>');
    else lines.push('', `**${md(title)} (${items.length})**`, ...inner);
  };
  group('Needs a human review', r.tests.filter((c) => policyOf(c) === 'review'));
  group('Worth a look', r.tests.filter((c) => policyOf(c) === 'warn'));
  const snaps = r.snapshots.filter((s) => s.status !== 'added');
  if (snaps.length) lines.push('', `**Snapshots updated (${snaps.length})**`, ...snaps.slice(0, 25).map((s) => `- \`${s.file.replace(/`/g, '')}\` (${s.status})`), `  - Why it matters: ${md(CLASSES.SNAPSHOT_UPDATED.why)}`);
  group('New tests', r.tests.filter((c) => c.classes[0] === 'NEW_TEST'));
  group('Other changes', r.tests.filter((c) => c.classes[0] === 'STEPS_CHANGED'), true);
  group('Safe: locators and renames only', r.tests.filter((c) => policyOf(c) === 'ok'), true);
  if (r.helpers.length) lines.push('', `Also changed, not classified yet: ${plural(r.helpers.length, 'test helper')} (${r.helpers.slice(0, 3).map((f) => `\`${f.replace(/`/g, '')}\``).join(', ')}${r.helpers.length > 3 ? ', …' : ''}).`);
  lines.push('', `<sub>turnsignal governance v0: test code compared with \`${md(r.base)}\` (merge base ${r.mergeBase.slice(0, 7)}) on the CI machine. Nothing was uploaded.</sub>`);
  if (opts.attribution) {
    const link = '[TurnSignal for Playwright](https://turnsignal.ai/?ref=pr-governance)';
    lines.push(opts.tokenless ? `<sub>Review by ${link}. With a free project token it also shows which failures are new, flaky or missing on this PR.</sub>` : `<sub>Review by ${link}</sub>`);
  }
  return lines.join('\n');
}

export function renderText(r: GovernanceResult): string {
  const h = headline(r);
  const out = [h.text];
  const t = tally(r);
  if (t) out.push(t);
  for (const c of [...r.tests].sort((a, b) => ORDER.indexOf(a.classes[0]!) - ORDER.indexOf(b.classes[0]!))) {
    const who = provenanceLabel(r.provenance[c.file]);
    out.push('', `[${CLASSES[c.classes[0]!].policy}] ${c.title.join(' › ')}  ${c.file}:${c.line}`, `  ${c.classes.map((k) => CLASSES[k].label).join(', ')}${who ? ` · ${who}` : ''}`);
    for (const d of c.details) out.push(`  - ${d.replace(/`/g, '')}`);
    for (const f of c.findings ?? []) out.push(`  - static check ${f.rule} (line ${f.line}): ${f.message}`);
  }
  for (const s of r.snapshots) out.push('', `[${s.status === 'added' ? 'info' : 'warn'}] snapshot ${s.status}: ${s.file}`);
  if (r.helpers.length) out.push('', `Also changed, not classified yet: ${r.helpers.join(', ')}`);
  out.push('', `Compared with ${r.base} (merge base ${r.mergeBase.slice(0, 7)}). Runs locally; nothing is uploaded.`);
  return out.join('\n');
}
