---
"@astrophage-io/pi-marathon": minor
---

Add `@astrophage-io/pi-marathon`: a long-running, context-window-aware pi agent that ports
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
