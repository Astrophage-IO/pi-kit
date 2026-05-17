---
"@astrophage-io/pi-bus": minor
"@astrophage-io/pi-superpowers": minor
"@astrophage-io/pi-profile": minor
---

Initial release of pi-kit to GitHub Packages.

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
