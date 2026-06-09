# @astrophage-io/pi-bus

## 0.2.1

### Patch Changes

- f1f9056: Ship extensions as self-contained bundles so they load regardless of install method.

  Each extension is now bundled into `dist/` with its real npm dependencies inlined
  (`@bufbuild/protobuf`, `@modelcontextprotocol/sdk`), while pi-provided modules
  (pi-coding-agent, pi-tui, typebox) stay external. `pi.extensions` points at the built
  bundle, so an installed extension no longer fails with `Cannot find module` when the
  host doesn't install or co-locate dependencies (e.g. `pi install <local path>`, a bare
  clone, or partial workspace hoisting).

  Also marks the legacy `@mariozechner/*` and `typebox` peer dependencies optional so
  package managers stop pulling stale host packages on install.

## 0.2.0

### Minor Changes

- 77f2ea1: Initial release of pi-kit to GitHub Packages.

  Three independently versioned packages, all bumped to 0.2.0 in this first
  publish:

  - `@astrophage-io/pi-bus` — protobuf-framed push event bus, broker + client +
    CLI + pi extension.
  - `@astrophage-io/pi-superpowers` — parent-session tools that spawn MCP-backed
    specialist Pi agents (Slack/Jira/Confluence and any extra profile defined
    in `superpowers.json`). Optional `--superpower-bus` flag wires `pi-bus`
    into child specialists so they can report back over the same broker.
  - `@astrophage-io/pi-profile` — portable pi setup via a single gist:
    declarative manifest of extensions, settings, files, and env-var
    requirements with ownership-aware apply.
