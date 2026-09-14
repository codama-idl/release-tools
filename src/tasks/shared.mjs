import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

import { githubRequest } from '../github.mjs';
import { getMajor } from '../versions.mjs';
import { discoverPackages } from '../workspace.mjs';

/** Reads a required environment variable or throws. */
export function requireEnv(name, env = process.env) {
    const value = env[name];
    if (!value) throw new Error(`Missing required environment variable ${name}.`);
    return value;
}

/** Runs a command, streaming output, throwing on failure. */
export function run(cwd, command, ...args) {
    execFileSync(command, args, { cwd, stdio: 'inherit' });
}

/**
 * Configures the git identity of the release app so pushed commits are
 * attributed to it (the `<id>+<slug>[bot]@users.noreply.github.com` form).
 */
export async function setupGitIdentity(cwd, token, appSlug) {
    const bot = `${appSlug}[bot]`;
    const user = await githubRequest(token, 'GET', `/users/${encodeURIComponent(bot)}`);
    run(cwd, 'git', 'config', 'user.name', bot);
    run(cwd, 'git', 'config', 'user.email', `${user.id}+${bot}@users.noreply.github.com`);
}

/**
 * The era of the repository: the shared major of all public packages.
 * Throws if the majors diverge (the same-major invariant must already hold).
 */
export function currentEra(cwd) {
    const publicPackages = discoverPackages(cwd).filter((pkg) => !pkg.private);
    if (publicPackages.length === 0) throw new Error('No public packages found.');
    const majors = new Set(publicPackages.map((pkg) => getMajor(pkg.version)));
    if (majors.has(null)) throw new Error('Unparsable package version in the workspace.');
    if (majors.size > 1) {
        throw new Error(`Public package majors diverge (${[...majors].join(', ')}); fix before proceeding.`);
    }
    return { major: [...majors][0], publicPackages };
}

/** Replaces an exact substring in a file, throwing when it is not found. */
export function replaceInFile(path, search, replacement) {
    const content = readFileSync(path, 'utf8');
    if (!content.includes(search)) {
        throw new Error(`Expected to find ${JSON.stringify(search)} in ${path}.`);
    }
    writeFileSync(path, content.replace(search, replacement));
}

/**
 * Bumps the release line (`N.x`) declared in a main.yml: the `release-version:`
 * input of the shared release workflow, or the legacy `RELEASE_VERSION:` env
 * of repositories that still inline their release job. Pure; throws when the
 * current line is not declared in either form.
 */
export function bumpReleaseLine(content, fromMajor, toMajor, path = 'main.yml') {
    const key = ['release-version', 'RELEASE_VERSION'].find((candidate) =>
        content.includes(`${candidate}: ${fromMajor}.x`),
    );
    if (!key) {
        throw new Error(
            `Expected to find "release-version: ${fromMajor}.x" (or the legacy "RELEASE_VERSION: ${fromMajor}.x") in ${path}.`,
        );
    }
    return content.replace(`${key}: ${fromMajor}.x`, `${key}: ${toMajor}.x`);
}

/** Flips the repository's default branch. */
export async function setDefaultBranch(adminToken, repo, branch) {
    await githubRequest(adminToken, 'PATCH', `/repos/${repo}`, { default_branch: branch });
}
