#!/usr/bin/env node
import { relative } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import { currentBranch, git, remoteBranches, versionAtHead } from '../src/git.mjs';
import { analyseVersionChanges } from '../src/guard.mjs';
import { describeConfig, npm, parseGitHubRepo, planTrust, preflight, summarise } from '../src/trust.mjs';
import { discoverPackages } from '../src/workspace.mjs';

const RELEASING = 'https://github.com/codama-idl/spec/blob/HEAD/RELEASING.md';
const [command, ...args] = process.argv.slice(2);

try {
    await main();
} catch (error) {
    console.error(`❌ release-tools: ${error.message}`);
    process.exit(1);
}

async function main() {
    switch (command) {
        case 'postversion': {
            postversion(process.cwd());
            break;
        }
        case 'trust-publishers': {
            await trustPublishers(process.cwd(), parseFlags(args));
            break;
        }
        case 'help':
        case '--help':
        case undefined: {
            console.log(`Usage: release-tools <command>

Commands:
  postversion        Run after \`changeset version\` (via the changesets action's
                     version-script) to enforce the RELEASING.md invariants:
                     majors only cross on main with the N.x maintenance branch
                     already cut, and public workspace majors stay equal.
                     Exits non-zero on any violation.

  trust-publishers   Configure npm Trusted Publishing for every public package
                     of this repository, pointing at its main.yml workflow.
                     Runs locally in your own npm session (2FA), idempotently.
                     Options:
                       --file <name>      workflow filename (default: main.yml)
                       --dry-run          plan only, change nothing
                       --restrict-tokens  also set "require 2FA and disallow
                                          tokens" on every trusted package
                     Exits non-zero while any package is unpublished,
                     misconfigured on npm, or has a package.json repository
                     that does not point at this repository.

See ${RELEASING} for the process.`);
            break;
        }
        default: {
            console.error(`release-tools: unknown command "${command}". Run \`release-tools help\`.`);
            process.exit(2);
        }
    }
}

function postversion(cwd) {
    const packages = discoverPackages(cwd).map((pkg) => ({
        name: pkg.name,
        private: pkg.private,
        oldVersion: versionAtHead(cwd, pkg.dir),
        newVersion: pkg.version,
    }));
    const branch = currentBranch(cwd);
    const { violations, notes } = analyseVersionChanges({
        branch,
        remoteBranches: remoteBranches(cwd),
        packages,
    });

    for (const note of notes) console.log(`ℹ️  ${note}`);
    if (violations.length > 0) {
        for (const violation of violations) console.error(`❌ ${violation}`);
        console.error('\nrelease-tools postversion: release blocked. See RELEASING.md:');
        console.error(RELEASING);
        process.exit(1);
    }
    console.log(`✅ release-tools postversion: ${packages.length} package(s) checked on "${branch}", no violations.`);
}

async function trustPublishers(cwd, { file = 'main.yml', dryRun = false, restrictTokens = false }) {
    const { version, user } = preflight();
    const repo = parseGitHubRepo(git(cwd, 'remote', 'get-url', 'origin'));
    if (!repo) throw new Error('The origin remote is not a GitHub repository.');
    console.log(
        `🔎 npm ${version}, logged in as ${user}, repository ${repo}, workflow ${file}${dryRun ? ' (dry run)' : ''}`,
    );

    const packages = discoverPackages(cwd);
    if (packages.length === 0) throw new Error(`No packages found in ${cwd}.`);
    const results = planTrust({ packages, repo, file, registry: npm });
    const dirOf = Object.fromEntries(packages.map((pkg) => [pkg.name, relative(cwd, pkg.dir) || '.']));
    const width = Math.max(...results.map(({ name }) => name.length));
    let calls = 0;
    const throttle = async () => {
        if (calls++ > 0) await sleep(2000); // npm's rate-limit guidance for bulk trust calls.
    };

    for (const result of results) {
        const label = result.name.padEnd(width);
        switch (result.status) {
            case 'private':
                console.log(`⏭  ${label}  private, never published`);
                break;
            case 'trusted':
                console.log(`⏭  ${label}  already trusted`);
                for (const config of result.detail) {
                    console.log(`⚠️  ${' '.repeat(width)}  extra configuration: ${describeConfig(config)}`);
                }
                break;
            case 'misconfigured':
                console.log(`❌ ${label}  trusted, but not for ${repo} ${file} with npm publish allowed:`);
                for (const config of result.detail) {
                    const remedy = config.id
                        ? `revoke with: npm trust revoke --id ${config.id} ${result.name}`
                        : `revoke it on npmjs.com (no id reported)`;
                    console.log(`   ${' '.repeat(width)}  ${describeConfig(config)} — ${remedy}`);
                }
                break;
            case 'mismatch':
                console.log(
                    `❌ ${label}  package.json repository is ${result.detail}, expected ${repo} (OIDC would reject the publish)`,
                );
                break;
            case 'missing':
                console.log(
                    `❌ ${label}  not on the registry yet: publish it once manually (cd ${dirOf[result.name]} && npm publish), then rerun`,
                );
                break;
            case 'pending':
                if (dryRun) {
                    result.status = 'planned';
                    console.log(`🔜 ${label}  would trust ${repo} ${file} (npm publish allowed)`);
                    break;
                }
                await throttle();
                npm.trust(result.name, { repo, file });
                result.status = 'created';
                console.log(`✅ ${label}  trusted ${repo} ${file} (npm publish allowed)`);
                break;
        }
    }

    if (restrictTokens && !dryRun) {
        for (const result of results.filter(({ status }) => ['trusted', 'created'].includes(status))) {
            await throttle();
            npm.restrictTokens(result.name);
            console.log(`🔒 ${result.name.padEnd(width)}  2FA required, tokens disallowed`);
        }
    }

    const { counts, ok } = summarise(results);
    const tally = Object.entries(counts)
        .map(([status, count]) => `${count} ${status}`)
        .join(', ');
    if (!ok) {
        console.error(`\n❌ release-tools trust-publishers: ${tally}. Resolve the items above and rerun.`);
        process.exit(1);
    }
    console.log(`\n✅ release-tools trust-publishers: ${tally}.`);
}

function parseFlags(argv) {
    const flags = {};
    for (let i = 0; i < argv.length; i++) {
        switch (argv[i]) {
            case '--file':
                flags.file = argv[++i];
                if (!flags.file) throw new Error('--file requires a value.');
                break;
            case '--dry-run':
                flags.dryRun = true;
                break;
            case '--restrict-tokens':
                flags.restrictTokens = true;
                break;
            default:
                throw new Error(`Unknown option "${argv[i]}". Run \`release-tools help\`.`);
        }
    }
    return flags;
}
