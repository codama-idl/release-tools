# release-tools

Shared release automation for the [Codama](https://github.com/codama-idl) ecosystem. It implements the mechanical parts of the release process defined in the spec repository's [RELEASING.md](https://github.com/codama-idl/spec/blob/HEAD/RELEASING.md) — read that first; this repo is just the tooling.

This repository is intentionally boring: plain ES modules, zero dependencies, no build step. It is consumed as a git dependency and via reusable workflows, never published to npm.

## What's inside

| Piece | Purpose |
| ----- | ------- |
| `bin/release-tools.mjs` | The `release-tools postversion` guard, hooked into each repo's changesets `version-script`. Blocks release PRs that cross a major illegally (off `main`, without the `N.x` maintenance branch cut, or breaking the monorepo same-major invariant). |
| `.github/workflows/cut.yml` | Reusable workflow: starts the next major. Creates `N.x`, enters pre-release mode on `main`, seeds the major changeset, flips the default branch, optionally opens the tracking issue. |
| `.github/workflows/promote.yml` | Reusable workflow: graduates the release candidate. Points `N.x` at `release-N.x`, exits pre-release mode on `main`, flips the default branch back. |
| `ruleset.json` + `.github/workflows/sync-rulesets.yml` | Branch protection as code: the canonical policy for `main` and `[0-9]*.x` branches, applied to every repository in the organisation via a dispatchable sync. |

## Adopting in a repository

1. Add the guard as a dev dependency and chain it after `changeset version`:

    ```jsonc
    // package.json
    {
        "devDependencies": {
            "@codama/release-tools": "github:codama-idl/release-tools#v1.0.0"
        },
        "scripts": {
            "release:version": "changeset version && release-tools postversion"
        }
    }
    ```

    And point the changesets action at it: `version-script: pnpm release:version`.

2. Add the two dispatch wrappers:

    ```yaml
    # .github/workflows/cut.yml
    name: Cut
    on:
      workflow_dispatch:
        inputs:
          tracking-issue:
            description: 'Open a transition tracking issue'
            type: boolean
            default: false
    permissions:
      contents: read
      issues: write
    jobs:
      cut:
        uses: codama-idl/release-tools/.github/workflows/cut.yml@v1
        with:
          tracking-issue: ${{ inputs.tracking-issue }}
        secrets: inherit
    ```

    ```yaml
    # .github/workflows/promote.yml
    name: Promote
    on: workflow_dispatch
    permissions:
      contents: read
    jobs:
      promote:
        uses: codama-idl/release-tools/.github/workflows/promote.yml@v1
        secrets: inherit
    ```

The workflows expect the repository to follow the conventions of RELEASING.md: a `RELEASE_VERSION: N.x` env in `.github/workflows/main.yml`, a package.json script containing `changeset publish`, and the `RELEASE_APP_CLIENT_ID` / `RELEASE_APP_PRIVATE_KEY` organisation secrets.

## Updating the branch-protection policy

Edit `ruleset.json`, merge the PR, then dispatch the **Sync rulesets** workflow (optionally with a comma-separated repository filter). It creates the ruleset where missing and updates it where present, matched by name.

## Versioning

Git tags only: exact tags (`v1.0.0`) plus a moving major tag (`v1`) for `uses:` references, following the GitHub Actions convention. Consumers pin the exact tag in package.json (the lockfile pins the resolved commit) and the moving major in workflow `uses:` lines.
