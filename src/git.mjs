import { execFileSync } from 'node:child_process';
import { relative } from 'node:path';

/** Runs a git command in `cwd` and returns trimmed stdout. */
export function git(cwd, ...args) {
    return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

/** The branch the release runs on: CI ref first, local branch as fallback. */
export function currentBranch(cwd, env = process.env) {
    if (env.GITHUB_REF_NAME) return env.GITHUB_REF_NAME;
    return git(cwd, 'branch', '--show-current');
}

/** Names of all branches on `origin`. */
export function remoteBranches(cwd) {
    const output = git(cwd, 'ls-remote', '--heads', 'origin');
    const names = new Set();
    for (const line of output.split('\n')) {
        const match = /refs\/heads\/(.+)$/.exec(line);
        if (match) names.add(match[1]);
    }
    return names;
}

/**
 * The version a package had at HEAD, before `changeset version` mutated the
 * working tree. Returns `null` for files that did not exist at HEAD.
 */
export function versionAtHead(cwd, packageDir) {
    const path = `${relative(cwd, packageDir) || '.'}/package.json`.replace(/^\.\//, '');
    try {
        const content = execFileSync('git', ['show', `HEAD:${path}`], { cwd, encoding: 'utf8' });
        return JSON.parse(content).version ?? null;
    } catch {
        return null;
    }
}
