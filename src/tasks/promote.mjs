/**
 * The promote: graduates the current release candidate to the stable major.
 * See RELEASING.md §3.
 *
 * - On `N.x` (first, so it stops claiming `latest`): appends
 *   ` --tag release-N.x` to the publish script.
 * - On `main`: exits pre-release mode; the next release PR publishes the
 *   stable major, which takes `latest` at publish time.
 * - Flips the default branch back to `main`.
 *
 * Environment: CONTENTS_TOKEN, ADMIN_TOKEN, APP_SLUG, GITHUB_REPOSITORY.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { appendJobSummary } from '../github.mjs';
import { currentBranch, remoteBranches } from '../git.mjs';
import { currentEra, replaceInFile, requireEnv, run, setDefaultBranch, setupGitIdentity } from './shared.mjs';

const cwd = process.cwd();
const repo = requireEnv('GITHUB_REPOSITORY');
const contentsToken = requireEnv('CONTENTS_TOKEN');
const adminToken = requireEnv('ADMIN_TOKEN');
const appSlug = requireEnv('APP_SLUG');

const branch = currentBranch(cwd);
if (branch !== 'main') throw new Error(`The promote must run from main, not "${branch}".`);

const preJsonPath = join(cwd, '.changeset/pre.json');
if (!existsSync(preJsonPath) || JSON.parse(readFileSync(preJsonPath, 'utf8')).mode !== 'pre') {
    throw new Error('main is not in pre-release mode: nothing to promote (or it was already promoted).');
}

const { major } = currentEra(cwd);
const outgoingMajor = major - 1;
const maintenanceBranch = `${outgoingMajor}.x`;
if (!remoteBranches(cwd).has(maintenanceBranch)) {
    throw new Error(`Branch ${maintenanceBranch} does not exist: run the cut workflow first.`);
}

await setupGitIdentity(cwd, contentsToken, appSlug);

// 1. The outgoing major stops claiming `latest` BEFORE anything else happens.
run(cwd, 'git', 'fetch', 'origin', maintenanceBranch);
run(cwd, 'git', 'checkout', '-B', maintenanceBranch, `origin/${maintenanceBranch}`);
const releaseTag = `release-${maintenanceBranch}`;
const packageJsonPath = join(cwd, 'package.json');
const scripts = JSON.parse(readFileSync(packageJsonPath, 'utf8')).scripts ?? {};
const publishEntry = Object.entries(scripts).find(([, value]) => value.includes('changeset publish'));
if (!publishEntry) throw new Error('No package.json script containing "changeset publish" found on the maintenance branch.');
const [publishKey, publishScript] = publishEntry;
if (publishScript.includes('--tag')) {
    throw new Error(`The "${publishKey}" script already carries a --tag flag: ${publishScript}`);
}
replaceInFile(
    packageJsonPath,
    `"${publishKey}": ${JSON.stringify(publishScript)}`,
    `"${publishKey}": ${JSON.stringify(`${publishScript} --tag ${releaseTag}`)}`,
);
run(cwd, 'git', 'commit', '-am', `Publish under ${releaseTag} from now on`);
run(cwd, 'git', 'push', 'origin', maintenanceBranch);

// 2. Graduate main.
run(cwd, 'git', 'checkout', 'main');
run(cwd, 'pnpm', 'exec', 'changeset', 'pre', 'exit');
run(cwd, 'git', 'commit', '-am', `Exit pre-release mode for the v${major} stable release`);
run(cwd, 'git', 'push', 'origin', 'main');

// 3. main takes the default-branch role back.
await setDefaultBranch(adminToken, repo, 'main');

appendJobSummary(`## 🚀 Promote complete

- \`${maintenanceBranch}\` now publishes under \`${releaseTag}\` and can never move \`latest\` again.
- \`main\` exited pre-release mode and is the default branch again.

Remaining (human) steps:

1. Review and merge the release PR on \`main\`: the stable v${major} publishes and **takes \`latest\` at publish time**.
2. Audit for unported commits: \`git log --oneline main..${maintenanceBranch}\` (each is forward-ported or recorded as dropped in the tracking issue).
3. Post the closing announcement and close the tracking issue.

See [RELEASING.md](https://github.com/codama-idl/spec/blob/HEAD/RELEASING.md).`);
