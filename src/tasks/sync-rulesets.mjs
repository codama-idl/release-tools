/**
 * Applies the canonical branch-protection policy (ruleset.json) to every
 * repository in the organisation: POST where the ruleset does not exist yet,
 * PUT where it does (matched by name).
 *
 * Environment: ADMIN_TOKEN (org-wide, administration write), ORG,
 * REPOS (optional comma-separated filter), RULESET_PATH (optional).
 */
import { readFileSync } from 'node:fs';

import { appendJobSummary, githubRequest } from '../github.mjs';
import { requireEnv } from './shared.mjs';

const adminToken = requireEnv('ADMIN_TOKEN');
const org = requireEnv('ORG');
const rulesetPath = process.env.RULESET_PATH || 'ruleset.json';

const payload = JSON.parse(readFileSync(rulesetPath, 'utf8'));

// Resolve `app:<slug>` bypass-actor placeholders to numeric app ids.
for (const actor of payload.bypass_actors ?? []) {
    if (typeof actor.actor_id === 'string' && actor.actor_id.startsWith('app:')) {
        const app = await githubRequest(adminToken, 'GET', `/apps/${actor.actor_id.slice(4)}`);
        actor.actor_id = app.id;
    }
}

const repos = process.env.REPOS
    ? process.env.REPOS.split(',').map((name) => name.trim())
    : await listOrgRepos(org);

const results = [];
for (const repoName of repos) {
    const existing = await githubRequest(adminToken, 'GET', `/repos/${org}/${repoName}/rulesets`);
    const match = existing.find((ruleset) => ruleset.name === payload.name);
    if (match) {
        await githubRequest(adminToken, 'PUT', `/repos/${org}/${repoName}/rulesets/${match.id}`, payload);
        results.push([repoName, 'updated']);
    } else {
        await githubRequest(adminToken, 'POST', `/repos/${org}/${repoName}/rulesets`, payload);
        results.push([repoName, 'created']);
    }
}

const table = results.map(([name, action]) => `| ${name} | ${action} |`).join('\n');
appendJobSummary(`## 🛡️ Ruleset "${payload.name}" synced\n\n| Repository | Action |\n| --- | --- |\n${table}`);

async function listOrgRepos(orgName) {
    const names = [];
    for (let page = 1; ; page += 1) {
        const batch = await githubRequest(adminToken, 'GET', `/orgs/${orgName}/repos?per_page=100&page=${page}`);
        for (const repository of batch) {
            if (!repository.archived && !repository.fork) names.push(repository.name);
        }
        if (batch.length < 100) break;
    }
    return names.sort();
}
