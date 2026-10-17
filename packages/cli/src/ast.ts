import { parse } from '@babel/parser';

/** Syntax-tree helpers shared by `analyze` (ADR-037) and `governance` (ADR-039). */

export type Node = { type: string; loc?: { start: { line: number; column: number } }; [k: string]: unknown };
export const isNode = (v: unknown): v is Node => typeof v === 'object' && v !== null && typeof (v as Node).type === 'string';

/** Parses a test file with error recovery; null when it can't be parsed at all. */
export function parseSource(source: string, file: string): Node | null {
  try {
    return parse(source, {
      sourceType: 'unambiguous',
      errorRecovery: true,
      plugins: [...(/\.[cm]?tsx?$/.test(file) ? (['typescript'] as const) : []), ...(/x$/.test(file) || !/\.[cm]?ts$/.test(file) ? (['jsx'] as const) : [])],
    }) as unknown as Node;
  } catch {
    return null;
  }
}

/** Playwright's async (web-first) matchers: they return promises and must be awaited. */
export const ASYNC_MATCHERS = new Set([
  'toBeAttached', 'toBeChecked', 'toBeDisabled', 'toBeEditable', 'toBeEmpty', 'toBeEnabled', 'toBeFocused', 'toBeHidden',
  'toBeInViewport', 'toBeVisible', 'toContainText', 'toContainClass', 'toHaveAccessibleDescription', 'toHaveAccessibleErrorMessage',
  'toHaveAccessibleName', 'toHaveAttribute', 'toHaveClass', 'toHaveCount', 'toHaveCSS', 'toHaveId', 'toHaveJSProperty', 'toHaveRole',
  'toHaveScreenshot', 'toHaveText', 'toHaveTitle', 'toHaveURL', 'toHaveValue', 'toHaveValues', 'toBeOK', 'toMatchAriaSnapshot', 'toPass',
]);
export const ACTIONS = new Set(['click', 'dblclick', 'fill', 'check', 'uncheck', 'tap', 'hover', 'selectOption', 'setChecked', 'dragTo', 'press', 'type']);

export function children(n: Node): Node[] {
  const out: Node[] = [];
  for (const [k, v] of Object.entries(n)) {
    if (k === 'loc' || k === 'start' || k === 'end' || k === 'extra' || k === 'leadingComments' || k === 'trailingComments' || k === 'innerComments') continue;
    if (Array.isArray(v)) {
      for (const x of v) if (isNode(x)) out.push(x);
    } else if (isNode(v)) {
      out.push(v);
    }
  }
  return out;
}

/** Depth-first walk with the parent chain. Return false from `visit` to skip a subtree. */
export function walk(n: Node, visit: (n: Node, parents: Node[]) => boolean | void, parents: Node[] = []): void {
  if (visit(n, parents) === false) return;
  parents.push(n);
  for (const c of children(n)) walk(c, visit, parents);
  parents.pop();
}

export const calleeName = (c: Node): string | undefined =>
  c.type === 'Identifier' ? (c.name as string) : c.type === 'MemberExpression' && (c.property as Node).type === 'Identifier' ? ((c.property as Node).name as string) : undefined;

/** `expect(...)`, `expect.soft(...)`, `expect.poll(...)` at the root of a member chain. */
export function expectRoot(n: Node): Node | undefined {
  let cur: Node | undefined = n;
  while (cur) {
    if (cur.type === 'CallExpression') {
      const callee = cur.callee as Node;
      if (callee.type === 'Identifier' && callee.name === 'expect') return cur;
      if (callee.type === 'MemberExpression' && (callee.object as Node).type === 'Identifier' && (callee.object as Node).name === 'expect') return cur;
      cur = callee;
    } else if (cur.type === 'MemberExpression') cur = cur.object as Node;
    else if (cur.type === 'TSNonNullExpression' || cur.type === 'ParenthesizedExpression') cur = cur.expression as Node;
    else return undefined;
  }
  return undefined;
}

export interface TestCall {
  node: Node;
  title: string;
  body: Node | undefined;
  modifier?: string;
  /** Titles of the enclosing `describe` blocks, outermost first. */
  describes: string[];
}

/** Names that behave like Playwright's `test`: test, it, and anything made with `.extend(...)`. */
export function testNames(ast: Node): Set<string> {
  const names = new Set(['test', 'it']);
  walk(ast, (n) => {
    if (n.type === 'VariableDeclarator' && (n.id as Node).type === 'Identifier' && isNode(n.init) && n.init.type === 'CallExpression') {
      const callee = n.init.callee as Node;
      if (callee.type === 'MemberExpression' && calleeName(callee) === 'extend') names.add((n.id as Node).name as string);
    }
  });
  return names;
}

const literalTitle = (first: Node | undefined): string | undefined =>
  !first
    ? undefined
    : first.type === 'StringLiteral'
      ? (first.value as string)
      : first.type === 'TemplateLiteral'
        ? (first.quasis as Node[]).map((q) => (q.value as { cooked: string }).cooked).join('…')
        : undefined;

/** `describe(...)`, `test.describe(...)`, `test.describe.serial(...)` etc. → its title. */
function describeTitle(n: Node, names: Set<string>): string | undefined {
  if (n.type !== 'CallExpression') return undefined;
  let c = n.callee as Node;
  while (c.type === 'MemberExpression' && calleeName(c) !== 'describe') c = c.object as Node;
  const isDescribe =
    (c.type === 'Identifier' && c.name === 'describe') ||
    (c.type === 'MemberExpression' && calleeName(c) === 'describe' && (c.object as Node).type === 'Identifier' && names.has((c.object as Node).name as string));
  return isDescribe ? literalTitle((n.arguments as Node[])[0]) : undefined;
}

export function findTests(ast: Node, names: Set<string>): TestCall[] {
  const tests: TestCall[] = [];
  walk(ast, (n, parents) => {
    if (n.type !== 'CallExpression') return;
    const callee = n.callee as Node;
    let modifier: string | undefined;
    let base: Node = callee;
    if (callee.type === 'MemberExpression') {
      modifier = calleeName(callee);
      base = callee.object as Node;
      if (!['only', 'skip', 'fixme', 'fail', 'slow'].includes(modifier ?? '')) return;
    }
    if (base.type !== 'Identifier' || !names.has(base.name as string)) return;
    const args = n.arguments as Node[];
    const title = literalTitle(args[0]);
    if (title === undefined) return; // test.skip(condition) etc.
    const fn = [...args].reverse().find((a) => a.type === 'ArrowFunctionExpression' || a.type === 'FunctionExpression');
    const describes = parents.map((p) => describeTitle(p, names)).filter((t): t is string => t !== undefined);
    tests.push({ node: n, title, body: fn?.body as Node | undefined, modifier, describes });
  });
  return tests;
}
