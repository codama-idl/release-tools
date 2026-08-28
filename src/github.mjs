import { appendFileSync } from 'node:fs';

/** Minimal GitHub REST client on global fetch. Used by the workflow task scripts. */
export async function githubRequest(token, method, path, body) {
    const response = await fetch(`https://api.github.com${path}`, {
        method,
        headers: {
            accept: 'application/vnd.github+json',
            authorization: `Bearer ${token}`,
            'x-github-api-version': '2022-11-28',
            ...(body ? { 'content-type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
    });
    const text = await response.text();
    const parsed = text ? JSON.parse(text) : null;
    if (!response.ok) {
        const message = parsed?.message ?? text;
        throw new Error(`GitHub API ${method} ${path} failed (${response.status}): ${message}`);
    }
    return parsed;
}

/** Appends markdown to the GitHub Actions job summary, or logs it locally. */
export function appendJobSummary(markdown, env = process.env) {
    if (env.GITHUB_STEP_SUMMARY) {
        appendFileSync(env.GITHUB_STEP_SUMMARY, `${markdown}\n`);
    } else {
        console.log(markdown);
    }
}
