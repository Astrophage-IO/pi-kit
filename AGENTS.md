# pi-kit agent instructions

- This repository is a Bun workspace. Keep package source in `packages/*`.
- Use TypeScript for all handwritten source, tests, bins, and pi extensions. Do not add handwritten `.js` or `.mjs` files.
- Keep each package independently installable as a pi package when possible.
- For commits containing AI-assisted work, attribute the agent that actually did the work via a `Co-authored-by:` trailer. Do not default to Codex regardless of agent — that misattributes work and sends the wrong signal in `git log`. Use the canonical identity for the agent you are:

```text
Co-authored-by: Codex <codex@openai.com>
Co-authored-by: Cursor Agent <cursoragent@cursor.com>
Co-authored-by: Claude <noreply@anthropic.com>
```

  If several agents collaborated on a single commit, include one `Co-authored-by:` trailer per agent. If you don't have a canonical identity for your agent, ask the user before inventing one.

- Git author for this repo should be `manashmandal <manashmndl@gmail.com>`.

## Before opening a PR

CI runs these in order; run them locally before pushing:

```bash
bun install --frozen-lockfile
bun run proto:lint
bun run proto:generate
git diff --exit-code -- packages/pi-bus/src/gen proto    # generated protobuf bindings must be committed
bun run typecheck
bun test
```

Anything that changes `proto/**` must be followed by `bun run proto:generate` and the regenerated files in `packages/pi-bus/src/gen` must be committed in the same change.

## Tests

- Unit tests live in `packages/*/test/*.test.ts` and run under `bun test`.
- The push-coordination smoke at `packages/pi-bus/test/pi-rpc-smoke.ts` requires `pi` on PATH and is not part of CI; run it locally with `bun run test:pi` when changing the pi-bus extension or protocol.
