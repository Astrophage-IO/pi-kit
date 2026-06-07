# @astrophage-io/pi-marathon

A long-running, context-window-aware pi agent that iterates on a measurable goal **indefinitely**
in a single session.

It ports Andrej Karpathy's [autoresearch](https://github.com/karpathy/autoresearch) loop
(*"LOOP FOREVER: tune → run → keep/discard → log → repeat"*) onto pi and adds the piece
autoresearch leaves to the host agent: **self context-window management**. The session keeps
experiment output out of the context window, records progress to disk, lets pi compact older
turns while preserving the mission state, and re-triggers itself after each turn so it keeps
working without a human.

## Why this works as one session

Three things let a single pi session run for hundreds of experiments instead of dying when the
context fills:

1. **Output never enters context.** The `marathon_run` tool redirects stdout/stderr to a log
   file and returns only the lines you `extract` (e.g. `^val_bpb:`). This is Karpathy's
   `> run.log 2>&1` rule made mechanical.
2. **Disk is memory.** `.marathon/results.tsv`, `best.md`, and `log.md` hold the full history;
   context is just scratch space. After a compaction the agent re-reads them and continues.
3. **State-preserving compaction.** pi auto-compacts at its threshold; pi-marathon hooks
   `session_compact` to re-inject the goal, metric, baseline, best, and next steps after a
   compaction so the loop keeps going (the agent also re-reads `.marathon/` on disk).

See [`docs/plans/2026-06-06-pi-marathon-design.md`](../../docs/plans/2026-06-06-pi-marathon-design.md)
for the full design and how it differs from the cron-based `pi-research` approach.

## Install

From GitHub Packages (configure your `~/.npmrc` once — see the [root README](../../README.md#install-from-github-packages)):

```bash
pi install @astrophage-io/pi-marathon
```

Or from this workspace:

```bash
pi install /Users/manash/projects/pi-kit/packages/pi-marathon
```

Installing registers both the extension and the `marathon` skill.

## Usage

Start a session in the repo you want to optimize and point it at the skill. Run it inside `tmux`
so it survives terminal disconnects:

```bash
pi --skill marathon "Set up a marathon mission to lower p99 latency, then loop."
```

`pi-marathon start` prints the exact launch command (including the dev `--skill`/`-e` paths when
running from a checkout).

The agent runs Discovery once, then loops on its own:

1. `marathon_configure` — writes `.marathon/` (config, state, results.tsv, runs/).
2. THINK → edit in-scope files → `git commit` → `marathon_run` (redirected!) → `marathon_record`.
3. keep (advance branch) or discard (`git reset --hard`); repeat until termination.

The loop self-drives via an `agent_end` hook that re-triggers a turn while the mission is
`running`, guarded by an idle check, a pause/stop sentinel, and an empty-tick safety that
disarms the loop if turns stop producing experiments.

## Tools

- `marathon_configure` — initialize a mission (goal, metric, direction, termination conditions).
- `marathon_run` — run a command with output redirected to a log; return only matching lines.
- `marathon_record` — append to results.tsv, update best/plateau, report termination.
- `marathon_log` — append a THINK/RUN/REFLECT/NOTE entry to the log.
- `marathon_status` — show progress (metric, baseline, best, recent experiments).
- `marathon_stop` — write `summary.md` and end the mission.

## Investigation mode (multi-agent evidence + verification swarm)

Beyond single-metric optimization, pi-marathon ships an **investigation org**: given a problem, an
orchestrator decomposes it, spawns highly-specified specialist subagents (Slack, Jira, Confluence,
code repo), collects their reports **on disk**, reduces them to cited claims, and validates each
key claim with an **independent quorum of verifier subagents** that re-fetch the primary source.

```bash
pi --skill marathon-investigation "Investigate why checkout p99 regressed last week."
```

The same context discipline applies: subagent output is written to `.marathon/investigation/` and
only a one-line summary returns to the orchestrator, so one session can drive dozens of subagents.

**Access gate before kickoff.** The orchestrator first calls `investigation_preflight({ sources })`.
`repo` needs nothing; `slack`/`jira`/`confluence` need an **MCP server**. Availability is decided by
**reaching the MCP and listing its tools** — not by any particular token. The MCP may authenticate
however your environment allows (an already-logged-in CLI, OAuth, or a token), so a referenced-but-
unset env var is only an advisory hint, never a hard failure. An MCP source must be **live-verified**
(a successful connect) to open the kickoff gate — a merely-configured profile is not enough. If a
source isn't reachable, the agent **asks you to make that MCP available** rather than proceeding,
then re-checks. Only once you confirm via `investigation_confirm` does spawning begin — so the long
autonomous run never starts half-blind. Use `investigation_confirm({ proceedWithout: ["slack"] })`
to deliberately run without a source.

**Tools:** `investigation_plan`, `investigation_preflight`, `investigation_confirm`,
`spawn_specialist`, `claim_add`, `spawn_verifier`, `report_compile`, `investigation_status`.

**Subskills (auto-loaded):** `marathon-investigation` (orchestrator), `evidence-slack`,
`evidence-jira`, `evidence-confluence`, `evidence-repo`, `claim-verifier`.

**Validation = independent grounded quorum.** A claim is `confirmed` only when ≥ N independent
verifiers (`--marathon-verifiers`, default 5) support it *with a re-fetched citation*; otherwise
it is `contested` / `refuted` / `unverifiable` and surfaced in `contested.md`. The
`agreement = confirmed/total` metric can drive the marathon loop until a coverage target is hit.

| Flag | Env | Default | Notes |
|---|---|---|---|
| `--marathon-verifiers` | `PI_MARATHON_VERIFIERS` | `5` | Independent verifiers per claim (quorum) |
| `--marathon-spawn-concurrency` | `PI_MARATHON_SPAWN_CONCURRENCY` | `3` | Max concurrent subagents |
| `--marathon-spawn-timeout` | `PI_MARATHON_SPAWN_TIMEOUT_MS` | `300000` | Per-subagent timeout |
| `--marathon-child-pi` | `PI_MARATHON_CHILD_PI` | `pi` | Command used to spawn subagents |
| `--marathon-superpowers` | `PI_MARATHON_SUPERPOWERS` | unset | Path to the pi-superpowers extension; enables MCP tools for slack/jira/confluence specialists |
| `--marathon-superpowers-config` | `PI_SUPERPOWERS_CONFIG` | `~/.pi/agent/superpowers.json` | superpowers profile config used for preflight readiness checks |

The `repo` specialist works out of the box via built-in `bash`/`grep`/`read`. Slack/Jira/
Confluence specialists need MCP tools — install [`@astrophage-io/pi-superpowers`](../pi-superpowers),
configure its profiles, and pass `--marathon-superpowers <path-to-its-extension>`.

See [`docs/plans/2026-06-06-pi-marathon-investigation-design.md`](../../docs/plans/2026-06-06-pi-marathon-investigation-design.md).

## Slash commands

- `/marathon-status` — progress without leaving the session.
- `/marathon-pause` / `/marathon-resume` — pause and resume the auto-loop.
- `/marathon-stop [reason]` — end the mission and write a summary.

## CLI (outside the session)

```bash
pi-marathon status        # read .marathon/ and print progress (no pi boot, no LLM call)
pi-marathon pause         # touch the pause sentinel
pi-marathon resume        # remove it
pi-marathon stop [reason] # end the mission and write summary.md
pi-marathon start         # print the recommended `pi` launch command
```

## Configuration

| Flag | Env | Default | Notes |
|---|---|---|---|
| `--marathon-dir` | `PI_MARATHON_DIR` | `<cwd>/.marathon` | Mission state directory |
| `--marathon-autoloop` | `PI_MARATHON_AUTOLOOP` | `true` | Re-trigger turns to keep the loop running |
| `--marathon-soft-threshold` | `PI_MARATHON_SOFT_THRESHOLD` | `0.7` | Context fraction at which the agent is nudged to wrap up |
| `--marathon-tick-delay` | `PI_MARATHON_TICK_DELAY_MS` | `2000` | Delay before the auto-loop re-triggers a turn |

## State on disk

```
<project>/.marathon/        # gitignore this directory
  config.md      # goal, metric, direction, termination conditions
  state.json     # machine state: iteration, best, plateau, status
  results.tsv    # one row per experiment: n, commit, metric, status, description
  log.md         # THINK/RUN/REFLECT narrative
  best.md        # current best config + how to reproduce it
  summary.md     # written on termination
  runs/<id>.log  # full per-experiment output (never enters context)
  pause          # sentinel: pause the loop
  stop           # sentinel: mission ended
```

## Safety notes

- The auto-loop keeps prompting the model until you stop it; cost is bounded by your model
  choice and the termination conditions (`target`, `maxIterations`, `maxPlateau`).
- `marathon_run` executes arbitrary shell commands via `bash -lc`. Only run missions in repos you
  trust, and keep the experiment scope tight.
- Always run on a dedicated git branch; the loop reverts discarded experiments with
  `git reset --hard`.
