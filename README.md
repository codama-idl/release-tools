# release-tools

Shared release automation for the [Codama](https://github.com/codama-idl) ecosystem. It implements the mechanical parts of the release process defined in the spec repository's [RELEASING.md](https://github.com/codama-idl/spec/blob/HEAD/RELEASING.md) — read that first; this repo is just the tooling.

This repository is intentionally boring: plain ES modules, zero dependencies, no build step. It is consumed as a git dependency and via reusable workflows, never published to npm.

## What's inside

| Piece | Purpose |
| ----- | ------- |
| `bin/release-tools.mjs` | `release-tools postversion`: the guard hooked into each repo's changesets `version-script`. Blocks release PRs that cross a major illegally (off `main`, without the `N.x` maintenance branch cut, or breaking the monorepo same-major invariant). `release-tools trust-publishers`: configures npm Trusted Publishing for every public package of a repository, from a maintainer's machine. |
| `.github/workflows/release.yml` | Reusable workflow: the release job of every repository. Opens or refreshes the changesets release PR and publishes to npm via Trusted Publishing (OIDC) when it merges. No npm token exists anywhere in the organisation. |
| `.github/workflows/cut.yml` | Reusable workflow: starts the next major. Creates `N.x`, enters pre-release mode on `main`, seeds the major changeset, flips the default branch, optionally opens the tracking issue and the announcement thread. |
| `.github/workflows/promote.yml` | Reusable workflow: graduates the release candidate. Points `N.x` at `release-N.x`, exits pre-release mode on `main`, flips the default branch back. |
| `ruleset.json` + `repo-settings.json` + `.github/workflows/sync-policies.yml` | Repository policy as code: the canonical branch protection for `main` and `[0-9]*.x` branches, plus the repository settings (squash-only merges with trailer-preserving default messages, auto-merge, branch deletion), applied to every repository in the organisation via a dispatchable sync. |

## Adopting in a repository

1. Add the guard as a dev dependency and chain it after `changeset version`; build inside the publish script (the release workflow only builds when it publishes):

    ```jsonc
    // package.json
    {
        "devDependencies": {
            "@codama/release-tools": "github:codama-idl/release-tools#v1.3.0"
        },
        "scripts": {
            "release:version": "changeset version && release-tools postversion",
            "release:publish": "pnpm build && changeset publish"
        }
    }
    ```

2. Make the release job of `main.yml` a call to the shared workflow. `release-version` is the branch's release line (the cut bumps it). Script names, the release PR title (`[N.x] Release package`) and GitHub release creation are conventions baked into the workflow, not inputs; an already-open release PR is simply retitled, since the changesets action matches it by head branch:

    ```yaml
    # .github/workflows/main.yml
    jobs:
      release:
        needs: [test]
        if: github.event_name == 'push'
        permissions:
          contents: write
          pull-requests: write
          id-token: write # Trusted Publishing: required on the caller too
        uses: codama-idl/release-tools/.github/workflows/release.yml@v1
        with:
          release-version: 1.x
        secrets: inherit
    ```

3. Trust the workflow on npm, once per package, from your own machine (npm 11.15+, `npm login`, 2FA; never a token):

    ```sh
    pnpm exec release-tools trust-publishers                    # plans and applies; idempotent
    pnpm exec release-tools trust-publishers --restrict-tokens  # afterwards: "require 2FA and disallow tokens"
    ```

    Trusted publishing cannot create packages: a brand-new package needs one manual `npm publish` from its directory first, after which the task picks it up. npm validates the OIDC token against the *calling* workflow's filename, hence `main.yml`; the task also checks that each `package.json` `repository` points at the repository, which npm requires.

4. Add the two dispatch wrappers:

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

The workflows expect the repository to follow the conventions of RELEASING.md: the `release-version: N.x` input in `.github/workflows/main.yml`, a package.json script containing `changeset publish`, and the `RELEASE_APP_CLIENT_ID` / `RELEASE_APP_PRIVATE_KEY` organisation secrets.

## Updating the repository policies

Edit `ruleset.json` and/or `repo-settings.json`, merge the PR, then dispatch the **Sync policies** workflow (optionally with a comma-separated repository filter). It applies the settings to every repository and creates the ruleset where missing or updates it where present, matched by name.

## Versioning

Git tags only: exact tags (`v1.0.0`) plus a moving major tag (`v1`) for `uses:` references, following the GitHub Actions convention. Consumers pin the exact tag in package.json (the lockfile pins the resolved commit) and the moving major in workflow `uses:` lines.
