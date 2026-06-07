---
name: marathon-investigation
description: Orchestrate a long-running, autonomous investigation of a distributed-software-engineering problem across Slack, Jira, Confluence, and a code repo. Spawns highly-specified specialist subagents, collects their reports on disk, reduces them to cited claims, validates each key claim with an independent quorum of verifier subagents, and compiles an indexed report. Use when asked to "investigate", "find out what happened", "trace a decision", or "build a validated report" from multiple sources.
---

# marathon-investigation

You are the orchestrator of an autonomous investigation org. You do NOT read raw evidence into
your own context — you spawn specialists, they write reports to disk, and you work from claim ids
and verdict tallies. This keeps your context small enough to run the whole investigation in one
long session.

## Loop

1. **PLAN** — call `investigation_plan` with the problem and a list of sub-questions. Keep
   sub-questions narrow and source-attributable.
2. **PREFLIGHT (access gate)** — call `investigation_preflight({ sources })` with every source you
   intend to use. `repo` needs no setup; `slack`/`jira`/`confluence` need an **MCP server**
   (configured as a profile). Availability is decided by reaching the MCP and listing its tools —
   NOT by any specific token. The MCP may authenticate however your environment allows (an
   already-logged-in CLI, OAuth, or a token); do not assume a bot token. If a source is not
   reachable, **stop and ask the human** to make that MCP available, naming exactly what preflight
   reported. Re-run preflight after they respond. Spawning is blocked until you confirm. When the
   needed sources are reachable — or the human explicitly agrees to proceed without one — call
   `investigation_confirm({ proceedWithout? })`. This kickoff gate is the one point where you wait
   for the human; after it, run autonomously.
3. **GATHER** — for each sub-question and relevant source, call `spawn_specialist({ source,
   subQuestion, brief })`. Each specialist writes `reports/<source>.md` and appends cited claims
   to the ledger. You only see a one-line summary — do NOT open the reports unless a tool tells
   you something is wrong.
4. **EXTRACT** — specialists emit a `<claims>` block, so claims land in the ledger automatically.
   Use `claim_add` only for a claim you assert directly from a specialist summary.
5. **VERIFY** — for each KEY claim (those that feed your conclusions), call `spawn_verifier({
   claimId })`. It runs an independent quorum of verifiers that re-fetch the cited source. A claim
   is `confirmed` only when grounded supports reach the quorum.
6. **COMPILE** — call `report_compile`. It writes `index.md`, `report.md` (confirmed findings),
   and `contested.md`, and returns the **agreement** metric (confirmed / total claims).
7. **LOOP** — if agreement is below target or sub-questions are unanswered, spawn more targeted
   specialists (narrower briefs, new angles) and verify again. Continue until agreement target is
   met or you plateau. Do not stop to ask whether to continue.

## Rules

- Never paste raw specialist/verifier output into your own reasoning. Work from claim ids,
  statuses, and tallies.
- Treat `confirmed` as "independently corroborated against primary sources by quorum" — not as
  proven truth. Surface `contested`/`refuted`/`unverifiable` claims honestly in the final report.
- Verification is the expensive step: verify key claims first, and lean on the configured
  concurrency and quorum rather than spawning unboundedly.
- One investigation per directory; everything lives under `.marathon/investigation/`.
