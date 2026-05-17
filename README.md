# pi-kit

A Bun workspace for highly customized pi extensions and multi-agent workflows.

The first package, `@astrophage-io/pi-bus`, is a protobuf-framed push event bus for coordinating isolated pi agents.

## Packages

- [`packages/pi-bus`](./packages/pi-bus) — push-based bidirectional event bus for coordinating isolated pi agents.
- [`packages/pi-superpowers`](./packages/pi-superpowers) — parent-session tools that spawn MCP-backed specialist Pi agents for Slack, Jira, and Confluence research.

## Workspace commands

```bash
bun run proto:lint
bun run proto:generate
bun run typecheck
bun test
bun run test:pi
bun run pi-bus:start -- --port 7373 --verbose
pi install /absolute/path/to/pi-kit/packages/pi-superpowers
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
