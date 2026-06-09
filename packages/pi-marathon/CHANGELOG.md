# @astrophage-io/pi-marathon

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

- 9b917c3: Add `@astrophage-io/pi-marathon`: a long-running, context-window-aware pi agent that ports
  Karpathy's autoresearch loop into a single persistent session. It self-manages context by
  redirecting experiment output to log files (`marathon_run`), recording progress to disk
  (`marathon_record` + `.marathon/`), re-grounding after pi compaction (`session_compact`), and
  re-triggering itself after each turn so it iterates on a metric without a human. Ships the
  `marathon` skill, `marathon_*` tools, `/marathon-*` slash commands, and a `pi-marathon`
  status/pause/resume/stop CLI.

  Also includes an investigation/verification-swarm layer: a second extension
  (`marathon-investigation`) that spawns highly-specified specialist subagents (Slack, Jira,
  Confluence, code repo) whose reports are written to disk, reduces them to cited claims, and
  validates each key claim with an independent grounded quorum of verifier subagents
  (`spawn_specialist`, `spawn_verifier`, `report_compile`, …). Ships the `marathon-investigation`,
  `evidence-{slack,jira,confluence,repo}`, and `claim-verifier` subskills.

  The investigation layer gates the long autonomous run behind an access preflight:
  `investigation_preflight` judges each source by **reaching its MCP server and listing tools** (a
  live connect), treating referenced-but-unset env vars as an advisory hint only — so MCP servers
  that authenticate via a logged-in CLI or OAuth (rather than a bot token) are handled correctly. The
  orchestrator asks the human to make any unreachable MCP available, and `investigation_confirm` opens
  the spawn gate only once access is confirmed (or a source is explicitly dropped).
