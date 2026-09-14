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

/** The `npm trust` permission that allows a plain `npm publish` (as opposed to `npm stage publish`). */
const PUBLISH_PERMISSION = 'createPackage';

/**
 * Parses a GitHub repository reference into `owner/repo`, or `null`: ssh and
 * https remote URLs, plus the package.json shorthands npm itself normalises
 * (`github:owner/repo`, bare `owner/repo`).
 */
export function parseGitHubRepo(reference) {
    if (typeof reference !== 'string') return null;
    const value = reference.trim();
    const shorthand = /^(?:github:)?([\w.-]+)\/([\w.-]+?)(?:\.git)?$/.exec(value);
    if (shorthand) return `${shorthand[1]}/${shorthand[2]}`;
    const url = /github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(value);
    return url ? `${url[1]}/${url[2]}` : null;
}

/**
 * Parses the output of `npm trust list --json`: nothing when the package has
 * no trust configuration, otherwise one pretty-printed JSON object per
 * configuration, concatenated (not an array). Throws on anything else
 * rather than guessing: guessing "none" would create a duplicate, guessing
 * "configured" would silently leave a package unpublishable.
 *
 * @returns {Array<{id?: string, type?: string, file?: string, repository?: string, environment?: string, permissions?: string[]}>}
 */
export function parseTrustList(stdout) {
    const text = stdout.trim();
    if (text === '') return [];
    const configs = [];
    for (const chunk of splitJsonObjects(text)) {
        let parsed;
        try {
            parsed = JSON.parse(chunk);
        } catch {
            throw new Error(`Unexpected \`npm trust list --json\` output: ${JSON.stringify(chunk).slice(0, 200)}`);
        }
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            throw new Error(`Unexpected \`npm trust list --json\` shape: ${JSON.stringify(chunk).slice(0, 200)}`);
        }
        configs.push(parsed);
    }
    return configs;
}

/**
 * Splits concatenated top-level JSON objects, respecting strings. When the
 * text is anything other than whitespace-separated objects, the whole text
 * is returned as a single chunk so `JSON.parse` fails loudly on it.
 */
function splitJsonObjects(text) {
    const chunks = [];
    let depth = 0;
    let start = -1;
    let inString = false;
    for (let i = 0; i < text.length; i++) {
        const char = text[i];
        if (inString) {
            if (char === '\\') i++;
            else if (char === '"') inString = false;
        } else if (char === '"') {
            inString = true;
        } else if (char === '{') {
            if (depth === 0) start = i;
            depth++;
        } else if (char === '}') {
            depth--;
            if (depth === 0 && start !== -1) {
                chunks.push(text.slice(start, i + 1));
                start = -1;
            }
        }
    }
    const wellFormed = depth === 0 && !inString && chunks.join('') === text.replace(/(?<=^|})\s+(?=\{|$)/g, '');
    return wellFormed ? chunks : [text];
}

/**
 * Whether an existing configuration is exactly the one this repository needs:
 * GitHub Actions, this repository, this workflow file, no environment, and
 * a plain `npm publish` allowed. Configurations predating permissions
 * (before May 2026) implicitly allow publishing.
 */
export function matchesExpected(config, { repo, file }) {
    return (
        (config.type ?? 'github') === 'github' &&
        typeof config.repository === 'string' &&
        config.repository.toLowerCase() === repo.toLowerCase() &&
        config.file === file &&
        !config.environment &&
        (!Array.isArray(config.permissions) || config.permissions.includes(PUBLISH_PERMISSION))
    );
}

/**
 * Decides what to do for each package. Pure: `registry` answers the two
 * questions the plan depends on. Statuses:
 * - `private`        skipped, never published
 * - `mismatch`       package.json repository does not point at this repo (OIDC would reject the publish)
 * - `missing`        not on the registry yet: trusted publishing cannot create packages
 * - `trusted`        the expected trust configuration exists (`detail` lists any extra configurations)
 * - `misconfigured`  trust configuration(s) exist but none is the expected one (`detail` lists them)
 * - `pending`        no trust configuration yet: needs `npm trust github`
 *
 * @param {object} input
 * @param {Array<{name: string, private: boolean, repository: string | null}>} input.packages
 * @param {string} input.repo `owner/repo`
 * @param {string} input.file workflow filename, e.g. `main.yml`
 * @param {{ exists(name: string): boolean, trustConfigurations(name: string): object[] }} input.registry
 */
export function planTrust({ packages, repo, file, registry }) {
    return packages.map((pkg) => {
        if (pkg.private) return { name: pkg.name, status: 'private' };
        const declared = parseGitHubRepo(pkg.repository);
        if (declared?.toLowerCase() !== repo.toLowerCase()) {
            return { name: pkg.name, status: 'mismatch', detail: pkg.repository ?? '(no repository field)' };
        }
        if (!registry.exists(pkg.name)) return { name: pkg.name, status: 'missing' };
        const configs = registry.trustConfigurations(pkg.name);
        if (configs.length === 0) return { name: pkg.name, status: 'pending' };
        const others = configs.filter((config) => !matchesExpected(config, { repo, file }));
        if (others.length === configs.length) return { name: pkg.name, status: 'misconfigured', detail: others };
        return { name: pkg.name, status: 'trusted', detail: others };
    });
}

/** One-line description of a trust configuration, for humans. */
export function describeConfig(config) {
    const parts = [
        config.type ?? 'unknown provider',
        config.repository ?? '?',
        config.file ?? '?',
        config.environment ? `env ${config.environment}` : null,
        Array.isArray(config.permissions) ? config.permissions.join('+') : 'legacy permissions',
    ].filter(Boolean);
    return `${parts.join(' ')} (id ${config.id ?? '?'})`;
}

/** Tallies a plan and decides the exit code: anything unresolved (`mismatch`, `missing`, `misconfigured`, `pending`) fails. */
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
    trustConfigurations(name) {
        return parseTrustList(capture(['trust', 'list', name, '--json']));
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
