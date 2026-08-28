# Contributing

Thanks for your interest in contributing to Codama's release tooling.

## Ground rules

- **Zero dependencies, no build step.** Plain ES modules on Node 20+, `node:test` for tests. This keeps git-dependency installs instant and the supply chain empty.
- This repository is **tooling, not a versioned release line**: it keeps a permanent `main` branch and is versioned with git tags only (`v1.0.0` exact tags, `v1` moving major tag). It is never published to npm.
- The behaviour it implements is specified in the spec repository's [RELEASING.md](https://github.com/codama-idl/spec/blob/HEAD/RELEASING.md). Process changes land there first; tooling follows the doc, never the other way around.

## Development

```sh
npm test        # node --test
```

Keep the pure logic (`src/guard.mjs`, `src/workspace.mjs`, `src/versions.mjs`) covered by unit tests. The workflow task scripts (`src/tasks/*.mjs`) are thin orchestration over that logic plus git/GitHub calls; test changes to them with a dry run on a sandbox repository before re-tagging.

## Releasing a change

1. Merge the PR into `main`.
2. Tag: `git tag -a v1.x.y -m "v1.x.y" && git tag -f v1 v1.x.y && git push origin v1.x.y && git push -f origin v1`.
3. Consumers on `uses: …@v1` pick the workflow change up immediately; package.json git dependencies bump their exact tag when they want the new guard.
