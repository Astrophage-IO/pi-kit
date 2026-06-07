# pi-marathon design

Date: 2026-06-06
Status: scaffolded in `packages/pi-marathon` (extension + skill + CLI + tests + smoke all green)

A pi extension + skill that turns a **single long-running pi session** into an autonomous
agent that iterates on a measurable goal indefinitely. It ports Andrej Karpathy's
[autoresearch](https://github.com/karpathy/autoresearch) loop ("LOOP FOREVER: tune → run →
keep/discard → log → repeat") into pi and adds the one thing autoresearch leaves to the host
agent: **self context-window management**. The agent watches its own context, keeps tool
output out of the window, and lets pi compact a research-state-preserving summary so the same
session can run for hundreds of iterations without a human and without dying when the context
fills.

## Relationship to the cron `pi-research` design

[`2026-05-07-pi-research-design.md`](./2026-05-07-pi-research-design.md) ports the same
autoresearch loop but makes a deliberate structural choice: **cron is the loop** — one headless
`pi -p` tick per experiment, no long-lived session, context-window awareness explicitly out of
scope. pi-marathon is the **opposite structural choice**: **the session is the loop** — one
persistent pi process drives itself with `pi.sendMessage({ triggerTurn: true })` and survives
by self-compacting. Both share the same on-disk state model and the same "disk is memory"
principle, so they can coexist; pi-marathon is the right tool when you want one live session you
can attach to, steer, and watch, rather than a fleet of stateless ticks.

| | cron `pi-research` | `pi-marathon` |
|---|---|---|
| Loop driver | external `crontab` tick | the session re-triggers itself |
| Process model | fresh `pi -p` per experiment | one persistent `pi` process |
| Context management | N/A (fresh each tick) | self-aware + auto-compaction + handoff summary |
| Survives reboot | yes (cron re-fires) | needs a supervisor to relaunch (`--continue`) |
| Steerability | none mid-tick | attach to the live session any time |

## Goal

Let a user describe a measurable optimization goal once, start one pi session, and walk away.
The session experiments on a loop, keeps what improves the metric, discards what doesn't,
manages its own context window so it never stalls, and only stops on a termination condition or
a human interrupt. `pi-marathon status` shows progress without touching the live session.

## Non-goals (v1)

- pi-bus / multi-agent coordination (explicitly excluded for now)
- Multiple concurrent missions in one project dir (one `.marathon/` per dir)
- A GPU/ML-specific harness — pi-marathon is metric-agnostic; autoresearch is the flagship
  *example program*, not a hard dependency
- Distributed/remote execution
- Token-cost accounting (user controls cost via model choice + budget caps)
- HTML/web dashboard

## Why a single long-running session can actually work

The naive objection is "the context window fills after a few experiments." Karpathy's
`program.md` already answers most of this — its loop is a context-hygiene discipline in
disguise. pi-marathon makes that discipline mechanical and adds compaction as the safety net.
Three pillars:

1. **Keep tool output out of context (the biggest lever).** autoresearch's rule —
   *"`uv run train.py > run.log 2>&1` … do NOT use tee or let output flood your context"* — is
   the whole game. Each experiment should add only ~5 lines to context: the idea, the commit
   sha, the one grepped metric line, and the TSV row. pi-marathon ships a `run_step` tool that
   **always** redirects to a logfile and returns only a caller-specified extraction (e.g.
   `grep "^val_bpb:"`), so the model physically cannot flood its own window. This alone buys
   hundreds of iterations per window.

2. **Disk is long-term memory; context is scratch.** Durable state lives in `.marathon/`
   (`results.tsv`, `log.md`, git branch). The agent can always re-read it. Losing context to a
   compaction is therefore non-fatal — the agent re-grounds from disk.

3. **Auto-compaction that preserves the mission.** pi auto-compacts when
   `contextTokens > contextWindow - reserveTokens` (defaults: `reserveTokens` 16384,
   `keepRecentTokens` 20000). pi-marathon hooks `session_before_compact` to guarantee the
   summary always carries the research state forward — goal, metric + direction, baseline,
   best-so-far + its config, recent keeps/discards, active branch, next ideas — so the
   post-compaction agent resumes the loop seamlessly instead of "waking up confused."

## Architecture

```
pi-kit/
└── packages/
    └── pi-marathon/                      # NEW
        ├── package.json
        ├── README.md
        ├── skills/
        │   └── marathon/
        │       └── SKILL.md              # the "program": LOOP FOREVER + context-hygiene rules
        ├── extensions/
        │   └── pi-marathon.ts            # the engine: tools + hooks + loop driver + slash cmds
        ├── bin/
        │   ├── pi-marathon.ts            # CLI: init, start, status, stop, attach
        │   └── pi-marathon-supervisor.ts # optional: relaunch with --continue on crash/reboot
        ├── src/
        │   ├── mission.ts                # read/write .marathon/ files
        │   ├── results.ts                # deterministic results.tsv read/append
        │   ├── status.ts                 # compact summary view (no pi boot)
        │   ├── compaction-summary.ts     # build the state-preserving compaction preamble
        │   └── lock.ts                   # PID lockfile + pause sentinel
        └── test/
            ├── mission.test.ts
            ├── results.test.ts
            ├── status.test.ts
            └── compaction-summary.test.ts
```

On-disk state, per project (in the user's repo, gitignored):

```
<project>/.marathon/
  config.md        # goal, metric command + direction, scope, constraints, termination, budget
  results.tsv      # one row per experiment (commit, metric, status, description, …)
  log.md           # THINK/RUN/REFLECT narrative, append-only
  best.md          # current best config + how to reproduce it (rewritten on each new best)
  runs/<n>.log     # full stdout/stderr per step (never enters context)
  state.json       # iteration count, best metric, plateau counter, branch, budget spent
  marathon.lock    # PID lock for the live session
  pause            # sentinel: touch to pause the loop, rm to resume
  stop             # sentinel: touch to end the mission cleanly
  summary.md       # written on termination
```

## The engine (extension `pi-marathon.ts`)

Built on the pi `ExtensionAPI` (same surface pi-bus/pi-superpowers already use). Key hooks and
the exact pi primitives they rely on:

### a) Context self-awareness

A `turn_end` handler reads `ctx.getContextUsage()` → `{ tokens, contextWindow, percent }` and
publishes it to a footer/status widget (`ctx.ui.setStatus`), e.g. `marathon: exp #42 · ctx 61%`.
Two thresholds:

- **soft (default 70%)**: nudge the agent to wrap the current experiment to a clean commit
  boundary before the window gets tight (no mid-experiment compaction).
- **hard**: left to pi's own auto-compaction; we only ensure the summary is good (see (d)).

### b) `run_step` tool — context hygiene as a guarantee

The single most important tool. Signature roughly:

```ts
run_step({ command, extract?, timeoutMs?, cwd? })
// → runs `command` with stdout+stderr redirected to .marathon/runs/<n>.log
// → kills on timeout (budget + grace), records status=crash on overrun
// → returns ONLY: the matched `extract` lines (default: tail -n 5), exit code, logfile path
```

The model never receives raw training/build output — only the extraction it asked for. This
encodes Karpathy's redirect rule so it can't be violated by an over-eager agent.

### c) `record_result` tool — deterministic logging

```ts
record_result({ commit, metric, secondary?, status, description })
// → appends a TSV row to results.tsv (tab-safe), updates state.json + best.md,
//   writes the log.md entry, and on status=discard/crash runs `git reset --hard` per policy.
```

Owning formatting/idempotency in a tool (rather than asking the model to hand-format TSV every
time) keeps output deterministic and saves context — same rationale as the cron design's
`lab_record_experiment`.

### d) State-preserving compaction

`SessionBeforeCompactResult` only accepts `{ cancel }` or a full `{ compaction }` — it has **no**
`customInstructions` passthrough (the event's `customInstructions` is the user's `/compact` arg).
So rather than biasing the summary, we re-ground **after** compaction:

```ts
pi.on("session_compact", async (_event, ctx) => {
  const state = await readState(paths);
  if (!state) return;
  const rows = await readResults(paths.results);
  // Inject a small mission-state note so the resumed context can continue the loop immediately,
  // then re-read .marathon/ for the full history (pillar 2: disk is memory).
  pi.sendMessage({ customType: "marathon.state", content: buildCompactionInstructions(state, rows, paths), display: true }, { triggerTurn: false });
});
```

This is robust and uses a supported API. A future enhancement (open question) is to additionally
supply a full custom `compaction` via `session_before_compact` with an LLM-generated summary
(cf. `examples/extensions/custom-compaction.ts`).

### e) The loop driver — "NEVER STOP", safely

autoresearch mandates the agent never pause to ask "should I keep going?". In a live pi session,
the agent would otherwise stop and wait for input after each turn. pi-marathon re-drives it:

```ts
pi.on("agent_end", (_event, ctx) => {
  if (!loopActive(ctx)) return;                 // stopped or paused → let it idle
  setTimeout(() => {
    if (!ctx.isIdle()) return;                  // a human is steering → defer
    pi.sendMessage(
      { customType: "marathon.tick", content: "Continue the loop: next experiment.", display: false },
      { triggerTurn: true },
    );
  }, tickDelayMs);
});
```

Guards that make this safe (and stoppable):

- **`stop` sentinel / `/marathon-stop`** → loop driver goes dormant; agent writes `summary.md`.
- **`pause` sentinel** → skip ticks until removed (lets a human take over the session).
- **`ctx.isIdle()` check + small delay** → never fights a human typing into the live session.
- **Budget caps** in `config.md`: max iterations, max wall-clock, plateau limit (best unchanged
  for N) → on breach, auto-stop and summarize.
- **Termination condition** (target metric hit) → auto-stop.

### f) Slash commands + CLI

`/marathon-init`, `/marathon-status`, `/marathon-pause`, `/marathon-stop` inside the session;
`pi-marathon init|start|status|stop|attach` outside it. `status` reads `.marathon/` directly —
no pi boot, no LLM call — exactly like the cron design's `pi-research status`.

## The program (skill `skills/marathon/SKILL.md`)

A retargeted port of autoresearch's `program.md`, the human-editable "research org code":

- **Discovery** (once): objective, primary metric command + direction, scope (files the agent
  may modify), constraints, per-step budget, termination, iteration/plateau caps.
- **The loop**: THINK (write a hypothesis to `log.md` first — mandatory) → edit in-scope files →
  `git commit` → `run_step` (redirected!) → read the extracted metric → `record_result` →
  keep (advance branch) or discard (`git reset --hard`) → repeat.
- **Context-hygiene rules** baked into the prompt: always use `run_step`; never `cat`/`tail` a
  run log into context (read via `run_step`'s extraction or `grep`); re-read `.marathon/` after
  any compaction to re-ground.
- **NEVER STOP** framing, plus the convergence/branching/strategy-diversification guidance that
  ports verbatim from autoresearch + ResearcherSkill with only tool-name swaps.

The autoresearch ML setup (`train.py`/`prepare.py`, val_bpb, 5-min budget) ships as an optional
example under `examples/autoresearch/` so the package is metric-agnostic: the same engine drives
"lower p99 latency", "raise eval accuracy", "shrink bundle size", etc.

## Lifecycle

- **Start**: `pi-marathon init` runs Discovery via the skill, creates branch `marathon/<slug>`,
  writes `.marathon/`, records baseline (experiment #0), then the loop driver takes over.
- **Resume / crash recovery**: the live session is one process. A thin optional supervisor
  (`pi-marathon-supervisor`) relaunches `pi --continue --session <id>` if the process dies, so a
  crash or reboot resumes the same session from its last saved entry. Disk state + git mean an
  interrupted experiment is reconciled on the next THINK (read `results.tsv`, check `git log`).
- **Compaction**: automatic and transparent (pillar 3) — no human action.
- **Termination**: target hit / budget breach / `/marathon-stop` → loop dormant, `summary.md`
  written, branch left for the human to review.

## Open questions for implementation

- Re-triggering a turn from inside `agent_end` via `sendMessage({ triggerTurn: true })`: confirm
  re-entrancy is safe and that a `setTimeout` defer + `ctx.isIdle()` guard is sufficient to avoid
  a tight loop. Validate against pi's print vs interactive modes (the loop driver targets a
  persistent/interactive session; pure `-p` exits after one prompt).
- `session_before_compact`: prefer biasing the default summary via `customInstructions`, or
  always supply a full custom `compaction`? Start with `customInstructions` (less brittle).
- Does `pi install <package>` register skills as well as extensions, or must the skill be passed
  with `--skill <abs>`? (Same open question as the cron design — verify on first build.)
- Budget/timeout enforcement for `run_step`: reuse the cron design's `flock`/PID + wall-clock
  approach, or lean on pi's tool `AbortSignal`? Likely both (signal for cooperative cancel,
  hard timeout for runaway processes).
- Scope enforcement: runtime check in `record_result` (reject commits touching out-of-scope
  files) since pi has no tool-level filesystem allowlist today.
