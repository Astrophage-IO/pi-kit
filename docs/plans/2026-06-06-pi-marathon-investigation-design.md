# pi-marathon investigation + verification-swarm design

Date: 2026-06-06
Status: scaffolded — `extensions/marathon-investigation.ts`, `src/{claims,investigation}.ts`, six subskills, unit tests + smoke all green

A second extension and a bundle of subskills for `@astrophage-io/pi-marathon` that turn the
long-running loop into an autonomous **investigation org**: given a problem, it decomposes the
question, spawns highly-specified specialist subagents (Slack, Jira, Confluence, code repo),
collects their findings as **indexed report files on disk**, reduces them to atomic cited
**claims**, and then **validates each key claim with an independent quorum of verifier subagents**
that re-fetch the primary source. The compiled output is a folder of cross-checked reports with a
confidence level per claim and an explicit list of contested findings.

It is `pi-marathon` (the loop + context hygiene + disk-as-memory + termination metric) composed
with the `pi-superpowers` spawn mechanism (headless `pi --mode json -p` children), with one
critical change: **subagent output goes to disk, not the parent context.**

## Goal

From one problem statement, produce a validated, navigable evidence report with minimal human
involvement: specialists gather, verifiers independently corroborate, the orchestrator compiles.
"Validated" means *independently corroborated against primary sources by a quorum*, surfaced with
honest confidence — not asserted as truth.

## Non-goals (v1)

- pi-bus coordination (verification requires isolation; staying bus-free is a feature here).
- Auto-writing to Slack/Jira/Confluence (read-only evidence gathering only).
- A general task runner — this is scoped to evidence investigation over known sources.
- Guaranteeing truth. The quorum reduces correlated error and catches bad citations; it does not
  prove a claim.

## Why this rides on what we already built

| Investigation concept | Existing pi-marathon primitive |
|---|---|
| subagent output → disk file, summary → context | `marathon_run`'s redirect-and-extract |
| `claims.jsonl` / `verdicts.jsonl` (append-only, tool-owned) | `results.tsv` |
| `report_compile` → index/report/contested | `writeSummary` |
| `agreement` (confirmed/total) drives the loop | the metric fed to `checkTermination` |
| spawn a highly-specified child agent | `pi-superpowers` `runPiJsonProcess` + profiles |

## Architecture

Second extension `extensions/marathon-investigation.ts` (auto-discovered alongside the core
engine; `extensions/` loads every `.ts`). Pure, testable logic lives in `src/claims.ts` and
`src/investigation.ts`. Subskills live in `skills/` (recursively discovered).

```
<project>/.marathon/investigation/
  brief.md                 # problem + sub-questions (one investigation per dir)
  reports/
    slack.md jira.md confluence.md repo.md   # one file per specialist (gather phase)
  claims.jsonl             # atomic, cited claims extracted from reports
  verdicts.jsonl           # one row per (claim, verifier) independent verdict
  index.md                 # navigable index of reports + claim status breakdown
  report.md                # final: confirmed claims grouped by sub-question, with confidence
  contested.md             # contested / refuted / unverifiable claims with conflicting verdicts
  runs/<id>.log            # raw subagent stdout — NEVER enters the orchestrator context
```

## The pipeline (this is the marathon loop)

```
PLAN     decompose the problem → brief.md + sub-questions
PREFLIGHT check each source's availability (MCP config + env + live connect); if a source is
          unavailable, ASK THE HUMAN for access, re-check, then confirm. Spawning is gated until
          the human confirms — this is the one interactive point before autonomous kickoff.
GATHER   for each (source, sub-question): spawn_specialist → reports/<source>.md (+ claims)
EXTRACT  reduce reports to atomic cited claims → claims.jsonl
VERIFY   for each KEY claim: spawn_verifier x N independent children → verdicts.jsonl
COMPILE  report_compile → index/report/contested + agreement metric
LOOP     if agreement < target or gaps remain → spawn more targeted specialists → repeat
```

The orchestrator's context never holds raw evidence — only file paths, claim ids, and verdict
tallies — so it can run the full pipeline across dozens of subagents and survive compaction.

## Readiness gate (preflight access before kickoff)

A long autonomous run must not start only to discover halfway that Slack/Jira access was never
available. So spawning is gated behind an explicit readiness check + human confirmation:

1. `investigation_preflight({ sources, live })` checks each intended source:
   - `repo` → always ready (built-in `bash`/`grep`/`read`, no MCP).
   - `slack`/`jira`/`confluence` → **availability is decided by reaching the MCP server**, not by
     any token. A **static** pass confirms structure (config has the profile + enabled servers); a
     **live** pass (default on, timeout-bounded) actually starts each MCP server and lists its
     tools. An MCP may authenticate via an already-logged-in CLI or OAuth and need no env var, so
     unset referenced env vars are an **advisory hint only, never a gate**. Statuses: `ready`
     (live-verified) · `configured` (structurally ok but **not** live-verified, so **not** usable
     yet — a live connect is required to open the gate) · `missing-config` · `missing-profile` ·
     `missing-server` · `no-tools` · `connect-failed`.
   - Writes `readiness.json` and clears any prior confirmation.
2. If a source is not reachable, the orchestrator skill **asks the human** to make that MCP
   available (enable/add the profile, log in the backing CLI, start the server), naming exactly
   what preflight reported, then re-runs preflight.
3. `investigation_confirm({ proceedWithout? })` stamps `confirmedAt`. It refuses while any source is
   still unmet unless the human explicitly drops it (`proceedWithout` → marked `skipped`).
4. `spawn_specialist` / `spawn_verifier` call a gate (`ensureKickoff`): no spawning until
   `confirmedAt` is set, and MCP sources must be `ready && !skipped`.

The live probe reuses the same stdio/env-expansion approach as `pi-superpowers` and needs the MCP
SDK (added as a dependency; dynamically imported so a missing SDK degrades to a static check).

## Spawning specialists (context hygiene applied to subagents)

`spawn_specialist({ source, brief, subQuestion, outFile, timeoutMs })`:

1. Build a child `pi` invocation: `pi --mode json -p --no-session --no-context-files
   --no-prompt-templates --system-prompt <subskill> --append-system-prompt <brief+output-contract>
   "<task>"`. The child bin is `--marathon-child-pi` (default `pi`).
2. For MCP-backed sources, optionally attach pi-superpowers: when `--marathon-superpowers <path>`
   is set, spawn with `-e <superpowers> --superpower-child --superpower-profile <source>` so the
   child gets Slack/Jira/Confluence MCP tools. Without it, the `repo` specialist still works fully
   via built-in `bash`/`grep`/`read`; the others degrade to "state what you cannot access."
3. Parse the child's JSON event stream for the final assistant text (same approach as
   superpowers), **write it to `outFile`**, and return only `{ path, headline, claimCount }`.

The output contract in each subskill requires the specialist to end its report with a
machine-parseable claims block so `claims_extract` is deterministic:

```
<claims>
{"statement": "...", "citations": ["<permalink|issue#comment|path:line>"], "confidence": "high"}
...
</claims>
```

## Validation: independent grounded quorum (the core)

Naive "spawn 5 validators on the report" fails three ways — they inherit the author's framing
(correlated error), they free-search and diverge, and they hallucinate citations. So:

1. **Atomic claims, not prose.** Verify `{id, statement, source, citations}` units.
2. **Verifier sees the claim + source pointers, not the author's reasoning.** Each verifier is a
   *fresh headless process* (`spawn_verifier`) asked to independently judge the claim and return
   `{verdict: supported|partial|refuted|unverifiable, quote, citation, confidence}`.
3. **Grounding re-fetch is the verifier's primary job:** open the cited permalink / comment /
   `path:line` and confirm it actually says the claim. A `supported` verdict only counts toward
   quorum if it carries a re-fetched citation. This is the defense against hallucinated evidence.
4. **Independence enforcement:** separate processes, no shared context, **no pi-bus**, no access
   to peers' verdicts. Optionally decorrelate further by varying model/temperature per verifier.
5. **Quorum gate** (`--marathon-verifiers`, default 5):
   - `confirmed`  — grounded supports ≥ N
   - `refuted`    — refutes ≥ N
   - `contested`  — both sides present, neither reaches N
   - `unverifiable` — sources unreachable for ≥ N
   - `pending`    — fewer than N verdicts so far
6. **Agreement metric** = `confirmed / max(1, claims)` (higher = better). Feeds straight into
   marathon's termination: loop until `agreement ≥ target` or it plateaus.

## Tools (deterministic, disk-owned)

- `investigation_plan({ problem })` → write `brief.md` + sub-questions.
- `investigation_preflight({ sources, live })` → check source/MCP availability → `readiness.json`.
- `investigation_confirm({ proceedWithout })` → stamp confirmation; opens the spawn gate.
- `spawn_specialist({ source, subQuestion, brief?, timeoutMs? })` → child → `reports/<source>.md`;
  returns summary only.
- `claims_extract({ reportFile })` / `claim_add({...})` → append to `claims.jsonl`.
- `spawn_verifier({ claimId, n?, timeoutMs? })` → spawn N independent verifiers → append
  `verdicts.jsonl`; returns the tally + computed status only.
- `investigation_status({})` / `report_compile({})` → build index/report/contested + agreement.

## Subskills shipped with the package

- `marathon-investigation` — orchestrator playbook: PLAN → GATHER → EXTRACT → VERIFY → COMPILE →
  LOOP; never dump raw evidence into context; never stop until agreement target or plateau.
- `evidence-slack`, `evidence-jira`, `evidence-confluence`, `evidence-repo` — specialist briefs
  with the strict output contract (cited claims block). Slack/Jira/Confluence reuse the prompt
  shape from `pi-superpowers/agents/*`; `repo` drives built-in `bash`/`grep`/`read`.
- `claim-verifier` — the independent verification protocol: judge one claim, re-fetch its
  citation, return a structured verdict; do not trust the author's framing.

## Cost & safety bounds (baked in from day one)

- N verifiers × claims explodes → verify **key** claims only (those feeding conclusions), batch
  claims per verifier where independence allows, cap spawn concurrency (`--marathon-spawn-concurrency`),
  and honor marathon's existing iteration/budget caps.
- Specialists are read-only; verification is read-only.
- Each subagent runs headless and ephemeral (`--no-session`); raw output stays in `runs/`.
- Be explicit in `report.md` that confirmed = corroborated-by-quorum, not proven.

## Open questions for implementation

- Claim extraction: trust the specialist's `<claims>` block, or run a separate extractor pass for
  reliability? (Start by trusting the block; add an extractor pass if it proves noisy.)
- "Key claim" selection: orchestrator-tagged vs verify-everything-under-a-budget. Start with
  orchestrator tags + a global cap.
- Verifier source access: verifiers need the same MCP profiles as specialists to re-fetch; when a
  verifier lacks access, its verdict is `unverifiable`, not `refuted`.
- Model diversity for decorrelation: expose `--marathon-verifier-models` to round-robin verifier
  models, or keep single-model replication for v1.
