/**
 * npm Trusted Publishing configuration, as code. See RELEASING.md
 * §Publishing authentication.
 *
 * `npm trust` is the CLI equivalent of the package settings page on
 * npmjs.com: it runs in a maintainer's own logged-in session (2FA), never
 * with a token, and never in CI. This module plans and applies the trust
 * relationship of every public package of a repository to that repository's
 * `main.yml` workflow, idempotently.
 */
import { execFileSync } from 'node:child_process';

import { isAtLeast } from './versions.mjs';

/** The npm CLI version that introduced `npm trust`. */
export const MIN_NPM_VERSION = '11.15.0';

/** Parses a GitHub remote URL (ssh or https) into `owner/repo`, or `null`. */
export function parseGitHubRepo(url) {
    if (typeof url !== 'string') return null;
    const match = /github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(url.trim());
    return match ? `${match[1]}/${match[2]}` : null;
}

/**
 * Interprets the output of `npm trust list --json`: `true` when at least one
 * trust relationship exists. Throws on output it cannot interpret rather
 * than guessing (guessing "not trusted" would create a duplicate; guessing
 * "trusted" would silently leave a package unconfigured).
 */
export function hasTrustRelationship(json) {
    let parsed;
    try {
        parsed = JSON.parse(json);
    } catch {
        throw new Error(`Unexpected \`npm trust list --json\` output: ${JSON.stringify(json).slice(0, 200)}`);
    }
    if (Array.isArray(parsed)) return parsed.length > 0;
    if (parsed && typeof parsed === 'object') {
        if (typeof parsed.id === 'string') return true;
        return Object.values(parsed).some((value) => Array.isArray(value) && value.length > 0);
    }
    throw new Error(`Unexpected \`npm trust list --json\` shape: ${typeof parsed}`);
}

/**
 * Decides what to do for each package. Pure: `registry` answers the two
 * questions the plan depends on. Statuses:
 * - `private`   skipped, never published
 * - `mismatch`  package.json repository does not point at this repo (OIDC would reject the publish)
 * - `missing`   not on the registry yet: trusted publishing cannot create packages
 * - `trusted`   a trust relationship already exists
 * - `pending`   needs `npm trust github`
 *
 * @param {object} input
 * @param {Array<{name: string, private: boolean, repository: string | null}>} input.packages
 * @param {string} input.repo `owner/repo`
 * @param {{ exists(name: string): boolean, isTrusted(name: string): boolean }} input.registry
 */
export function planTrust({ packages, repo, registry }) {
    return packages.map((pkg) => {
        if (pkg.private) return { name: pkg.name, status: 'private' };
        const declared = parseGitHubRepo(pkg.repository);
        if (declared !== repo) {
            return { name: pkg.name, status: 'mismatch', detail: pkg.repository ?? '(no repository field)' };
        }
        if (!registry.exists(pkg.name)) return { name: pkg.name, status: 'missing' };
        if (registry.isTrusted(pkg.name)) return { name: pkg.name, status: 'trusted' };
        return { name: pkg.name, status: 'pending' };
    });
}

/** Tallies a plan and decides the exit code: anything unresolved (`mismatch`, `missing`, `pending`) fails. */
export function summarise(results) {
    const counts = {};
    for (const { status } of results) counts[status] = (counts[status] ?? 0) + 1;
    const ok = results.every(({ status }) => ['private', 'trusted', 'created', 'planned'].includes(status));
    return { counts, ok };
}

/** The real npm CLI. Captured calls return trimmed stdout; interactive calls inherit the terminal (2FA prompts). */
export const npm = {
    version() {
        return capture(['--version']);
    },
    whoami() {
        return capture(['whoami']);
    },
    exists(name) {
        try {
            capture(['view', name, 'version', '--json']);
            return true;
        } catch (error) {
            if (/E404/.test(String(error.stderr ?? error.message))) return false;
            throw error;
        }
    },
    isTrusted(name) {
        return hasTrustRelationship(capture(['trust', 'list', name, '--json']));
    },
    trust(name, { repo, file }) {
        interactive(['trust', 'github', name, '--repo', repo, '--file', file, '--allow-publish', '--yes']);
    },
    restrictTokens(name) {
        // "Require two-factor authentication and disallow tokens" on npmjs.com.
        interactive(['access', 'set', 'mfa=publish', name]);
    },
};

/** Fails loudly unless the local npm can run `npm trust` and is logged in. */
export function preflight(client = npm) {
    const version = client.version();
    if (!isAtLeast(version, MIN_NPM_VERSION)) {
        throw new Error(
            `npm ${version} is too old for \`npm trust\`: ${MIN_NPM_VERSION}+ required (npm install -g npm@latest).`,
        );
    }
    let user;
    try {
        user = client.whoami();
    } catch {
        throw new Error('Not logged in to npm: run `npm login` (trust commands need your 2FA session, not a token).');
    }
    return { version, user };
}

function capture(args) {
    return execFileSync('npm', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function interactive(args) {
    execFileSync('npm', args, { stdio: 'inherit' });
}
