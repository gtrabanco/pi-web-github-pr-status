# Release policy — strict semver

This package follows [Semantic Versioning](https://semver.org/) strictly once it reaches `1.0.0`. While in `0.x`, the public API (plugin id, settings schema, label/panel behavior) is still allowed to evolve; breaking changes during `0.x` bump the **minor** so users can pin safely.

## Version meaning

| Bump | When |
| --- | --- |
| **MAJOR** | Breaking change: removal or semantic change of existing settings keys, label/panel contract changes users depend on, minimum PI WEB plugin API version raised, plugin id changed. |
| **MINOR** | Backwards-compatible features: new settings, new labels/actions, new panel sections, new supported gh fields. Also: breaking changes while the package is still `0.x`. |
| **PATCH** | Backwards-compatible fixes: bug fixes, shell script robustness, docs, dependency maintenance, packaging. |

Pre-release and build metadata (`-beta.1`, `+build`) are **not used** in this project.

## Registering the next release

The kind of the next release is **registered in advance** in `package.json`:

```json
{
  "nextRelease": "minor"
}
```

Register it with `bun run release:patch`, `bun run release:minor` or `bun run release:major`. `nextRelease` is always one of `patch`, `minor`, `major`; anything else fails the release.

## Publishing

```bash
bun run publish
```

From a **clean `main`** worktree, the script:

1. verifies the worktree is clean and the branch is `main`;
2. looks up the current version on npm — the first release publishes the current version as-is;
3. otherwise bumps the version by the registered `nextRelease` and resets the marker to `patch`;
4. runs the full local gate (`bun run check`: typecheck with TypeScript 7, tests, build, package-contract validation);
5. updates `CHANGELOG.md`, commits `chore(release): vX.Y.Z` and tags `vX.Y.Z`;
6. publishes with `bun publish` (access public via `publishConfig`);
7. pushes the release tag (best effort).

There is no hosted CI: everything that can be checked locally is checked locally by `bun run check`, and deployment to npm is manual from the maintainer's machine.
