/**
 * The cut: starts work on the next major. See RELEASING.md §1.
 *
 * - Creates the `N.x` maintenance branch (birth commit: `baseBranch` only).
 * - On `main`: bumps the release line in main.yml, enters pre-release mode (`rc`),
 *   seeds the major changeset covering all public packages.
 * - Flips the default branch to `N.x`.
 * - Optionally opens the transition tracking issue and the announcement
 *   thread (driving repos only), cross-linked both ways.
 *
 * Environment: CONTENTS_TOKEN, ADMIN_TOKEN, APP_SLUG, GITHUB_REPOSITORY,
 * OPEN_TRACKING_ISSUE ('true'/'false'), ANNOUNCE ('true'/'false'),
 * SEED_SUMMARY (optional), TRACKING_TOKEN (tracking issue; `issues: write`),
 * DISCUSSIONS_TOKEN (announcement thread; app token with Discussions write —
 * the thread lives in the announcement hub, which is usually another repo),
 * ANNOUNCE_HUB (optional; defaults to the ecosystem hub, codama-idl/spec).
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { appendJobSummary, githubGraphQL, githubRequest } from '../github.mjs';
import { git, remoteBranches } from '../git.mjs';
import { bumpReleaseLine, currentEra, replaceInFile, requireEnv, run, setDefaultBranch, setupGitIdentity } from './shared.mjs';

const RELEASING = 'https://github.com/codama-idl/spec/blob/HEAD/RELEASING.md';

const cwd = process.cwd();
const repo = requireEnv('GITHUB_REPOSITORY');
const contentsToken = requireEnv('CONTENTS_TOKEN');
const adminToken = requireEnv('ADMIN_TOKEN');
const appSlug = requireEnv('APP_SLUG');
const openTrackingIssue = process.env.OPEN_TRACKING_ISSUE === 'true';
const announce = process.env.ANNOUNCE === 'true';
const hub = process.env.ANNOUNCE_HUB || 'codama-idl/spec';
const isHub = repo === hub;

// The actual checked-out branch, NOT the dispatch ref: workflow_dispatch
// runs on the default branch, which during a transition is the maintenance
// branch — the workflow's checkout pins `main` regardless.
const branch = git(cwd, 'branch', '--show-current');
if (branch !== 'main') throw new Error(`The cut must run from main, not "${branch}".`);

const { major, publicPackages } = currentEra(cwd);
const nextMajor = major + 1;
const maintenanceBranch = `${major}.x`;
const maintenanceExists = remoteBranches(cwd).has(maintenanceBranch);
const preJsonPath = join(cwd, '.changeset/pre.json');
const preModeActive = existsSync(preJsonPath) && JSON.parse(readFileSync(preJsonPath, 'utf8')).mode === 'pre';
if (maintenanceExists && preModeActive) {
    throw new Error(`Branch ${maintenanceBranch} exists and main is in pre-release mode: this major is already cut.`);
}

await setupGitIdentity(cwd, contentsToken, appSlug);

// 1. The maintenance branch, with its single birth adjustment.
if (maintenanceExists) {
    console.warn(`⚠️ Branch ${maintenanceBranch} already exists: resuming a partially completed cut.`);
} else {
    run(cwd, 'git', 'checkout', '-b', maintenanceBranch);
    replaceInFile(join(cwd, '.changeset/config.json'), '"baseBranch": "main"', `"baseBranch": "${maintenanceBranch}"`);
    run(cwd, 'git', 'commit', '-am', `Cut the ${maintenanceBranch} maintenance branch`);
    run(cwd, 'git', 'push', 'origin', maintenanceBranch);
    run(cwd, 'git', 'checkout', 'main');
}

// 2. Start the next major on main.
bumpReleaseVersion(join(cwd, '.github/workflows/main.yml'), major, nextMajor);
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

// 4. Tracking issue and announcement thread (driving repos only), cross-linked.
let issue = null;
let discussionUrl = null;
if (openTrackingIssue) {
    issue = await githubRequest(requireEnv('TRACKING_TOKEN'), 'POST', `/repos/${repo}/issues`, {
        title: `v${nextMajor} transition tracking`,
        body: trackingIssueBody(),
    });
}
if (announce) {
    discussionUrl = await createAnnouncementThread();
    if (issue) {
        await githubRequest(requireEnv('TRACKING_TOKEN'), 'PATCH', `/repos/${repo}/issues/${issue.number}`, {
            body: trackingIssueBody(discussionUrl),
        });
    }
}

const extraLines = [
    issue ? `\n- Tracking issue: ${issue.html_url}` : '',
    discussionUrl ? `\n- Announcement thread: ${discussionUrl} (pin it — the API cannot)` : '',
].join('');
appendJobSummary(`## ✂️ Cut complete

- \`${maintenanceBranch}\` created (now the default branch, keeps publishing \`latest\`).
- \`main\` hosts v${nextMajor}: pre-release mode \`rc\`, seeded major changeset for ${publicPackages.length} package(s).${extraLines}

Next: land v${nextMajor} changes on \`main\`; each merged release PR ships a new \`rc\`. See [RELEASING.md](${RELEASING}).`);

/** Bumps the release line declared in the caller's main.yml. */
function bumpReleaseVersion(path, from, to) {
    writeFileSync(path, bumpReleaseLine(readFileSync(path, 'utf8'), from, to, path));
}

async function createAnnouncementThread() {
    const token = requireEnv('DISCUSSIONS_TOKEN');
    const [owner, name] = hub.split('/');
    const data = await githubGraphQL(
        token,
        `query ($owner: String!, $name: String!) {
            repository(owner: $owner, name: $name) {
                id
                discussionCategories(first: 25) { nodes { id, slug } }
            }
        }`,
        { owner, name },
    );
    const category = data.repository.discussionCategories.nodes.find((node) => node.slug === 'announcements');
    if (!category) {
        throw new Error(`No "Announcements" discussion category on ${hub}: enable Discussions there first.`);
    }
    const created = await githubGraphQL(
        token,
        `mutation ($repositoryId: ID!, $categoryId: ID!, $title: String!, $body: String!) {
            createDiscussion(
                input: { repositoryId: $repositoryId, categoryId: $categoryId, title: $title, body: $body }
            ) {
                discussion { url }
            }
        }`,
        {
            repositoryId: data.repository.id,
            categoryId: category.id,
            title: isHub
                ? `Codama v${nextMajor} is in development — follow this thread`
                : `\`${repo.split('/')[1]}\` v${nextMajor} is in development — follow this thread`,
            body: announcementBody(),
        },
    );
    return created.createDiscussion.discussion.url;
}

function announcementBody() {
    const npmExample =
        publicPackages.length === 1 ? ` (\`npm install ${publicPackages[0].name}@rc\` to try them)` : '';
    const issueLine = issue ? `- 📋 Tracking issue: ${issue.html_url}\n` : '';
    const opening = isHub
        ? `The **v${nextMajor}** major transition has started 🚀

This thread is the single announcement channel for the whole wave: subscribe to follow it from first release candidate to stable release.

## What this means right now

- \`main\` now hosts the v${nextMajor} work in progress; the stable v${major} line continues on \`${maintenanceBranch}\` and remains what \`npm install\` gives you — **nothing changes for users today**.`
        : `The **v${nextMajor}** major transition of [\`${repo}\`](https://github.com/${repo}) has started 🚀

This thread is the single announcement channel for this transition: subscribe to follow it from first release candidate to stable release.

## What this means right now

- \`main\` of that repository now hosts the v${nextMajor} work in progress; the stable v${major} line continues on its \`${maintenanceBranch}\` branch and remains what \`npm install\` gives you — **nothing changes for users today**.`;
    return `${opening}
- Release candidates will publish under the \`rc\` dist-tag as work lands${npmExample}.

## What happens next

1. **Candidate declaration** — once v${nextMajor} is feature-complete, we will declare a specific release-candidate set *on this thread* (the post will be updated and a comment posted), together with the earliest promote date. From that moment the branch is frozen except for fixes.
2. **Validation window** (~six weeks) — integrators (explorers, wallets, indexers, program repos) validate against the candidate and report findings **as comments here**.
3. **Promote** — the stable v${nextMajor} publishes and takes the \`latest\` dist-tag.

## Links

${issueLine}- 📖 The release process: [RELEASING.md](${RELEASING})

<!-- Declaration template — at declaration time, prepend the block below to this post (filled in) and post it as a comment too, so subscribers are notified. Update the tracking issue's dates table as well.

> [!IMPORTANT]
> ## 📣 Candidate declared — YYYY-MM-DD
>
> The following release-candidate set is the **candidate for v${nextMajor}**. Earliest promote date: **YYYY-MM-DD**. From now until promote, these lines are frozen except for fixes; a breaking fix re-declares the candidate here.
>
> | Package | Candidate |
> | --- | --- |
> | ... | ... |
>
> **Integrators**: please validate against these versions and report results in the comments below — your confirmations gate the promote.

-->`;
}

function trackingIssueBody(threadUrl) {
    const declaration = threadUrl
        ? `Declared on the [announcement thread](${threadUrl}) (body edit + comment). _Not declared yet._`
        : `_Not declared yet. Open the announcement thread per [RELEASING.md](${RELEASING}#2-candidacy) and declare there._`;
    const announceItem = threadUrl
        ? `- [x] Announcement thread opened: ${threadUrl} (pin it manually)`
        : `- [ ] Open the announcement thread in [the hub's Discussions](https://github.com/${hub}/discussions)`;
    return `Tracking issue for the **v${nextMajor}** major transition, following [RELEASING.md](${RELEASING}).

**Status: 🔵 Candidacy — release candidates shipping, no candidate declared yet.**

| Event | Date |
| --- | --- |
| Cut | ${new Date().toISOString().slice(0, 10)} |
| First rc | – |
| Candidate declared | – |
| Promote | – |

## Candidate declaration

${declaration}

<details>
<summary><strong>Phase checklists</strong></summary>

### Cut ([docs](${RELEASING}#1-cut))
- [x] \`${maintenanceBranch}\` cut; \`main\` in pre-release mode with the seeded major changeset
- [x] Tracking issue opened

### Candidacy ([docs](${RELEASING}#2-candidacy))
${announceItem}
- [ ] Declare the candidate set + earliest promote date on the thread
- [ ] Freeze: fixes only until promote

### Promote ([docs](${RELEASING}#3-promote))
- [ ] Dispatch \`promote\`
- [ ] Merge the release PR — the stable major publishes and takes \`latest\`
- [ ] Audit \`git log --oneline main..${maintenanceBranch}\` (superset guarantee)
- [ ] Closing announcement; close this issue

</details>

<details>
<summary><strong>Ecosystem adoption checklist</strong></summary>

_Integrators and their validation status against the candidate. Gates the promote._

</details>`;
}
