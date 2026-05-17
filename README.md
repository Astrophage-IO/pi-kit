# pi-kit

A Bun workspace for highly customized pi extensions and multi-agent workflows.

The first package, `@astrophage-io/pi-bus`, is a protobuf-framed push event bus for coordinating isolated pi agents.

## Packages

- [`packages/pi-bus`](./packages/pi-bus) — push-based bidirectional event bus for coordinating isolated pi agents.
- [`packages/pi-superpowers`](./packages/pi-superpowers) — parent-session tools that spawn MCP-backed specialist Pi agents for Slack, Jira, and Confluence research.
- [`packages/pi-profile`](./packages/pi-profile) — portable pi setup via a single gist: declare extensions, settings, files, and required env vars; `pi-profile sync` brings any machine up to date.

Published to GitHub Packages under `@astrophage-io/*`. See [Install from GitHub Packages](#install-from-github-packages) for the one-time `.npmrc` setup consumers need.

## Workspace commands

```bash
bun run proto:lint
bun run proto:generate
bun run typecheck
bun test
bun run test:pi
bun run pi-bus:start -- --port 7373 --verbose
pi install /absolute/path/to/pi-kit/packages/pi-superpowers
pi install /absolute/path/to/pi-kit/packages/pi-profile
```

## Repository conventions

- Source code is TypeScript-first. Do not add handwritten `.js`/`.mjs` source files.
- Each extension module should be independently installable as a pi package.
- Commit messages for AI-assisted changes must include a `Co-authored-by:` trailer naming the agent that did the work. Do not default to Codex for non-Codex agents:

```text
Co-authored-by: Codex <codex@openai.com>
Co-authored-by: Cursor Agent <cursoragent@cursor.com>
Co-authored-by: Claude <noreply@anthropic.com>
```

  Include one trailer per collaborating agent. See [`AGENTS.md`](./AGENTS.md) for details.

## Install from GitHub Packages

The kit publishes to GitHub Packages, so any machine that wants to install from the registry needs to point the `@astrophage-io` scope there and authenticate with a GitHub token that has the `read:packages` scope:

```bash
cat >> ~/.npmrc <<'EOF'
@astrophage-io:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=<GITHUB_TOKEN_WITH_READ_PACKAGES>
EOF

pi install @astrophage-io/pi-bus
pi install @astrophage-io/pi-superpowers
pi install @astrophage-io/pi-profile
```

GitHub Packages requires authentication for installs even when the underlying repo is public; this is a GitHub policy, not something this kit can change.

## Releasing

Releases are driven by [changesets](https://github.com/changesets/changesets) and a GitHub Action:

```bash
bunx changeset           # in your PR: declare which packages, what bump, summary
```

On merge to `main`, [`.github/workflows/release.yml`](./.github/workflows/release.yml) either opens/updates a "Version Packages" PR (if there are pending changesets) or, once that PR is merged, runs `changeset publish` to push the bumped packages to GitHub Packages, tag them, and create GitHub Releases. The workflow uses the built-in `GITHUB_TOKEN`; no `NPM_TOKEN` secret is required.
