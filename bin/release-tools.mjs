#!/usr/bin/env node
import { currentBranch, remoteBranches, versionAtHead } from '../src/git.mjs';
import { analyseVersionChanges } from '../src/guard.mjs';
import { discoverPackages } from '../src/workspace.mjs';

const command = process.argv[2];

switch (command) {
    case 'postversion': {
        postversion(process.cwd());
        break;
    }
    case 'help':
    case '--help':
    case undefined: {
        console.log(`Usage: release-tools <command>

Commands:
  postversion   Run after \`changeset version\` (via the changesets action's
                version-script) to enforce the RELEASING.md invariants:
                majors only cross on main with the N.x maintenance branch
                already cut, and public workspace majors stay equal.
                Exits non-zero on any violation.

See https://github.com/codama-idl/spec/blob/HEAD/RELEASING.md for the process.`);
        break;
    }
    default: {
        console.error(`release-tools: unknown command "${command}". Run \`release-tools help\`.`);
        process.exit(2);
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
        console.error('https://github.com/codama-idl/spec/blob/HEAD/RELEASING.md');
        process.exit(1);
    }
    console.log(`✅ release-tools postversion: ${packages.length} package(s) checked on "${branch}", no violations.`);
}
