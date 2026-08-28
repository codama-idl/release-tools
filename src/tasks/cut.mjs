/**
 * The cut: starts work on the next major. See RELEASING.md §1.
 *
 * - Creates the `N.x` maintenance branch (birth commit: `baseBranch` only).
 * - On `main`: bumps the release-version env, enters pre-release mode (`rc`),
 *   seeds the major changeset covering all public packages.
 * - Flips the default branch to `N.x`.
 * - Optionally opens the transition tracking issue (driving repos only).
 *
 * Environment: CONTENTS_TOKEN, ADMIN_TOKEN, APP_SLUG, GITHUB_REPOSITORY,
 * OPEN_TRACKING_ISSUE ('true'/'false'), SEED_SUMMARY (optional),
 * TRACKING_TOKEN (required when OPEN_TRACKING_ISSUE is 'true').
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { appendJobSummary, githubRequest } from '../github.mjs';
import { currentBranch, remoteBranches } from '../git.mjs';
import { currentEra, replaceInFile, requireEnv, run, setDefaultBranch, setupGitIdentity } from './shared.mjs';

const cwd = process.cwd();
const repo = requireEnv('GITHUB_REPOSITORY');
const contentsToken = requireEnv('CONTENTS_TOKEN');
const adminToken = requireEnv('ADMIN_TOKEN');
const appSlug = requireEnv('APP_SLUG');

const branch = currentBranch(cwd);
if (branch !== 'main') throw new Error(`The cut must run from main, not "${branch}".`);

const { major, publicPackages } = currentEra(cwd);
const nextMajor = major + 1;
const maintenanceBranch = `${major}.x`;
if (remoteBranches(cwd).has(maintenanceBranch)) {
    throw new Error(`Branch ${maintenanceBranch} already exists: this major has already been cut.`);
}

await setupGitIdentity(cwd, contentsToken, appSlug);

// 1. The maintenance branch, with its single birth adjustment.
run(cwd, 'git', 'checkout', '-b', maintenanceBranch);
replaceInFile(join(cwd, '.changeset/config.json'), '"baseBranch": "main"', `"baseBranch": "${maintenanceBranch}"`);
run(cwd, 'git', 'commit', '-am', `Cut the ${maintenanceBranch} maintenance branch`);
run(cwd, 'git', 'push', 'origin', maintenanceBranch);

// 2. Start the next major on main.
run(cwd, 'git', 'checkout', 'main');
replaceInFile(join(cwd, '.github/workflows/main.yml'), `RELEASE_VERSION: ${major}.x`, `RELEASE_VERSION: ${nextMajor}.x`);
run(cwd, 'pnpm', 'exec', 'changeset', 'pre', 'enter', 'rc');
const seedSummary =
    process.env.SEED_SUMMARY ||
    `Start major ${nextMajor}. Release candidates publish under the \`rc\` dist-tag while this major is in development.`;
const frontmatter = publicPackages.map((pkg) => `'${pkg.name}': major`).join('\n');
writeFileSync(join(cwd, `.changeset/cut-major-${nextMajor}.md`), `---\n${frontmatter}\n---\n\n${seedSummary}\n`);
run(cwd, 'git', 'add', '.changeset');
run(cwd, 'git', 'commit', '-am', `Start major ${nextMajor} on main`);
run(cwd, 'git', 'push', 'origin', 'main');

// 3. The maintenance branch owns latest and the default-branch role for the transition.
await setDefaultBranch(adminToken, repo, maintenanceBranch);

// 4. Tracking issue, for the repo driving the transition.
let issueLine = '';
if (process.env.OPEN_TRACKING_ISSUE === 'true') {
    const issue = await githubRequest(requireEnv('TRACKING_TOKEN'), 'POST', `/repos/${repo}/issues`, {
        title: `v${nextMajor} transition tracking`,
        body: trackingIssueBody(nextMajor, maintenanceBranch),
    });
    issueLine = `\n- Tracking issue: ${issue.html_url}`;
}

appendJobSummary(`## ✂️ Cut complete

- \`${maintenanceBranch}\` created (now the default branch, keeps publishing \`latest\`).
- \`main\` hosts v${nextMajor}: pre-release mode \`rc\`, seeded major changeset for ${publicPackages.length} package(s).${issueLine}

Next: land v${nextMajor} changes on \`main\`; each merged release PR ships a new \`rc\`. See [RELEASING.md](https://github.com/codama-idl/spec/blob/HEAD/RELEASING.md).`);

function trackingIssueBody(next, maintenance) {
    const releasing = 'https://github.com/codama-idl/spec/blob/HEAD/RELEASING.md';
    return `Tracking issue for the **v${next}** major transition, following [RELEASING.md](${releasing}).

**Status: 🔵 Candidacy — release candidates shipping, no candidate declared yet.**

| Event | Date |
| --- | --- |
| Cut | ${new Date().toISOString().slice(0, 10)} |
| First rc | – |
| Candidate declared | – |
| Promote | – |

## Candidate declaration

_None yet. When declared, this section will name the candidate set and the earliest promote date, and link the Discussions announcement._

<details>
<summary><strong>Phase checklists</strong></summary>

### Cut ([docs](${releasing}#1-cut))
- [x] \`${maintenance}\` cut; \`main\` in pre-release mode with the seeded major changeset
- [x] Tracking issue opened

### Candidacy ([docs](${releasing}#2-candidacy))
- [ ] Declare the candidate set + earliest promote date (comment below)
- [ ] Announce in [Discussions](https://github.com/codama-idl/spec/discussions)
- [ ] Freeze: fixes only until promote

### Promote ([docs](${releasing}#3-promote))
- [ ] Dispatch \`promote\`
- [ ] Merge the release PR — the stable major publishes and takes \`latest\`
- [ ] Audit \`git log --oneline main..${maintenance}\` (superset guarantee)
- [ ] Closing announcement; close this issue

</details>

<details>
<summary><strong>Ecosystem adoption checklist</strong></summary>

_Integrators and their validation status against the candidate. Gates the promote._

</details>`;
}
