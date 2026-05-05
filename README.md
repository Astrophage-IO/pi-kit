# pi-kit

A Bun workspace for highly customized pi extensions and multi-agent workflows.

## Packages

- [`packages/pi-bus`](./packages/pi-bus) — push-based bidirectional event bus for coordinating isolated pi agents.

## Workspace commands

```bash
bun test
bun run test:pi
bun run pi-bus:start -- --port 7373 --verbose
```

## Repository conventions

- Source code is TypeScript-first. Do not add handwritten `.js`/`.mjs` source files.
- Each extension module should be independently installable as a pi package.
- Commit messages for AI-assisted changes must include the Codex attribution trailer:

```text
Co-authored-by: Codex <codex@openai.com>
```
