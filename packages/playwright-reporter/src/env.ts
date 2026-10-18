import { execFileSync } from 'node:child_process';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { DEFAULT_API_URL } from '@reportee/shared';

type Env = Record<string, string | undefined>;

/** Reads TURNSIGNAL_<name>, falling back to the pre-release REPORTEE_<name>. */
export function setting(name: string, env: Env = process.env): string | undefined {
  const raw = env[`TURNSIGNAL_${name}`] || env[`REPORTEE_${name}`];
  // Values pasted or piped on Windows can carry an invisible byte-order mark (U+FEFF) or a trailing
  // newline; in a token that makes every request fail ("Invalid character in header content").
  const value = raw?.replace(/^\uFEFF/, '').trim();
  return value || undefined;
}

export { DEFAULT_API_URL };

/**
 * API URL: an explicit TURNSIGNAL_API_URL (or option) wins; with a token but no URL, the hosted
 * service; without a token, none (results are only saved locally).
 */
export function apiUrlFor(explicit: string | undefined, token: string | undefined): string | undefined {
  return explicit || (token ? DEFAULT_API_URL : undefined);
}

export interface CiInfo {
  provider: string;
  /** Shared by all shards of one CI run, so their results merge into one run. */
  runKey: string;
  buildId?: string;
  buildUrl?: string;
  branch?: string;
  commit?: string;
}

export function detectCi(env: Env = process.env): CiInfo {
  const explicit = setting('RUN_KEY', env);
  const pick = (info: Omit<CiInfo, 'runKey'> & { runKey?: string }): CiInfo => ({
    ...info,
    runKey: explicit ?? info.runKey ?? `local:${os.hostname()}:${randomUUID()}`,
  });

  if (env.GITHUB_ACTIONS === 'true') {
    const url = env.GITHUB_SERVER_URL && env.GITHUB_REPOSITORY && env.GITHUB_RUN_ID
      ? `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`
      : undefined;
    return pick({
      provider: 'github',
      // No attempt number: "Re-run failed jobs" must merge into the same run (ADR-015).
      runKey: env.GITHUB_RUN_ID ? `github:${env.GITHUB_RUN_ID}` : undefined,
      buildId: env.GITHUB_RUN_ID,
      buildUrl: url,
      branch: env.GITHUB_HEAD_REF || env.GITHUB_REF_NAME,
      commit: env.GITHUB_SHA,
    });
  }
  if (env.GITLAB_CI === 'true') {
    return pick({
      provider: 'gitlab',
      runKey: env.CI_PIPELINE_ID ? `gitlab:${env.CI_PIPELINE_ID}` : undefined,
      buildId: env.CI_PIPELINE_ID,
      buildUrl: env.CI_PIPELINE_URL,
      branch: env.CI_MERGE_REQUEST_SOURCE_BRANCH_NAME || env.CI_COMMIT_REF_NAME,
      commit: env.CI_COMMIT_SHA,
    });
  }
  if (env.CIRCLECI === 'true') {
    return pick({
      provider: 'circleci',
      runKey: env.CIRCLE_WORKFLOW_ID ? `circleci:${env.CIRCLE_WORKFLOW_ID}` : undefined,
      buildId: env.CIRCLE_WORKFLOW_ID,
      buildUrl: env.CIRCLE_BUILD_URL,
      branch: env.CIRCLE_BRANCH,
      commit: env.CIRCLE_SHA1,
    });
  }
  if (env.BUILDKITE === 'true') {
    return pick({
      provider: 'buildkite',
      runKey: env.BUILDKITE_BUILD_ID ? `buildkite:${env.BUILDKITE_BUILD_ID}` : undefined,
      buildId: env.BUILDKITE_BUILD_ID,
      buildUrl: env.BUILDKITE_BUILD_URL,
      branch: env.BUILDKITE_BRANCH,
      commit: env.BUILDKITE_COMMIT,
    });
  }
  if (env.TF_BUILD === 'True') {
    return pick({
      provider: 'azure',
      runKey: env.BUILD_BUILDID ? `azure:${env.BUILD_BUILDID}` : undefined,
      buildId: env.BUILD_BUILDID,
      branch: env.BUILD_SOURCEBRANCHNAME,
      commit: env.BUILD_SOURCEVERSION,
    });
  }
  if (env.JENKINS_URL) {
    return pick({
      provider: 'jenkins',
      runKey: env.BUILD_TAG ? `jenkins:${env.BUILD_TAG}` : undefined,
      buildId: env.BUILD_NUMBER,
      buildUrl: env.BUILD_URL,
      branch: env.BRANCH_NAME || env.GIT_BRANCH,
      commit: env.GIT_COMMIT,
    });
  }
  if (env.BITBUCKET_PIPELINE_UUID || env.BITBUCKET_BUILD_NUMBER) {
    // The pipeline UUID is shared by its parallel steps and unique across repositories.
    const id = env.BITBUCKET_PIPELINE_UUID || env.BITBUCKET_BUILD_NUMBER;
    return pick({
      provider: 'bitbucket',
      runKey: `bitbucket:${id}`,
      buildId: env.BITBUCKET_BUILD_NUMBER,
      buildUrl: env.BITBUCKET_REPO_FULL_NAME && env.BITBUCKET_BUILD_NUMBER
        ? `https://bitbucket.org/${env.BITBUCKET_REPO_FULL_NAME}/pipelines/results/${env.BITBUCKET_BUILD_NUMBER}`
        : undefined,
      branch: env.BITBUCKET_BRANCH,
      commit: env.BITBUCKET_COMMIT,
    });
  }
  return pick({ provider: env.CI ? 'unknown-ci' : 'local' });
}

function git(args: string[], cwd: string): string | undefined {
  try {
    return execFileSync('git', args, { cwd, timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim() || undefined;
  } catch {
    return undefined;
  }
}

/** Repository root, for repo-relative (monorepo-safe) test paths. */
export function gitTopLevel(cwd: string): string | undefined {
  return git(['rev-parse', '--show-toplevel'], cwd);
}

/**
 * The job's test selection from the Playwright CLI (`--project`, `--grep`, `--grep-invert`).
 * Identical for every shard of one CI job; different for matrix siblings such as
 * `--project=chromium` vs `--project=firefox` (ADR-018).
 */
export function selectionArgs(argv: readonly string[] = process.argv): { projects: string[]; filters: string[] } {
  const projects: string[] = [];
  const filters: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const m = a.match(/^(--project|--grep|-g|--grep-invert|-gv)(?:=(.*))?$/);
    if (!m) continue;
    const value = m[2] ?? argv[++i];
    if (value === undefined) continue;
    if (m[1] === '--project') projects.push(...value.split(',').map((p) => p.trim()).filter(Boolean));
    else filters.push(`${m[1]}=${value}`);
  }
  return { projects: [...new Set(projects)].sort(), filters: filters.sort() };
}

export interface GitInfo {
  branch?: string;
  commit?: string;
  message?: string;
  author?: string;
}

export function detectGit(cwd: string, ci: CiInfo): GitInfo {
  const commit = ci.commit ?? git(['rev-parse', 'HEAD'], cwd);
  const branch = ci.branch ?? git(['rev-parse', '--abbrev-ref', 'HEAD'], cwd);
  return {
    commit,
    branch: branch === 'HEAD' ? undefined : branch,
    message: commit ? git(['log', '-1', '--format=%s', commit], cwd) : undefined,
    author: commit ? git(['log', '-1', '--format=%an', commit], cwd) : undefined,
  };
}
