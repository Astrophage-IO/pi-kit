# pi-research design

Date: 2026-05-07
Status: design accepted, ready for implementation plan

A pi extension that ports Andrej Karpathy's autoresearch loop (via Krzysztof Dudek's [ResearcherSkill](https://github.com/krzysztofdudek/ResearcherSkill)) into pi, with one structural change: instead of running iterations in a single long-lived agent session, the workflow installs a cron entry that wakes pi on schedule to run **one** experiment per tick. Iteration survives reboots, crashes, and weeks of idle time.

## Goal

Let a user describe a measurable optimization goal once, then walk away. Pi runs experiments on cron, keeps what improves the metric, discards what doesn't, and stops automatically when the target is hit. `pi-research status` shows progress without booting pi.

## Non-goals (v1)

- Multi-evaluator protocol / qualitative metrics (deferred — quantitative only)
- launchd plist on macOS (cron only)
- Multiple concurrent labs in one project dir (one `.lab/` per dir)
- HTML/web dashboard
- pi-bus integration (explicitly excluded)
- Token / LLM cost accounting (user controls cost via cadence)
- IDE-aware "is the user editing?" detection (only `.lab/pause` + dirty-worktree precondition)
- Per-experiment isolated worktrees
- Remote / distributed research

## Architecture

```
pi-kit/
├── packages/
│   ├── pi-bus/                          # existing, untouched
│   └── pi-research/                     # NEW
│       ├── package.json
│       ├── README.md
│       ├── skills/
│       │   └── researcher/
│       │       └── SKILL.md             # ported playbook, retargeted to pi tools
│       ├── extensions/
│       │   └── pi-research.ts           # tools + slash commands + small system-prompt preamble
│       ├── bin/
│       │   ├── pi-research.ts           # CLI: `tick`, `status`, `cron`, `init`
│       │   └── pi-research-tick.ts      # internal: spawns one headless pi turn
│       ├── src/
│       │   ├── lab.ts                   # read/write .lab/ files
│       │   ├── status.ts                # render compact summary view
│       │   ├── cron.ts                  # tagged crontab read/write
│       │   └── lock.ts                  # PID lockfile
│       └── test/
│           ├── lab.test.ts
│           ├── status.test.ts
│           └── cron.test.ts
```

State per-project (in user's repo, not pi-kit):

```
<project>/.lab/                          # gitignored, single source of truth
  config.md  results.tsv  log.md  branches.md  parking-lot.md
  workspace/  cron.lock  cron.log  summary.md  pause?
```

## Side-effect isolation

**Cron isolation.** Every line we write is tagged with `# pi-research:<lab-id>` where `<lab-id>` is a sha8 of the absolute project path. `cron_install` is idempotent (replaces our tagged line). `cron_remove` only matches by tag — never touches anything else in `crontab -e`. Multiple research projects coexist without colliding.

**Git isolation.** Hard preconditions in every tick: `git status --porcelain` must be empty (else exit 0 with `skipped: dirty worktree` — never overwrites uncommitted work). HEAD must be on a branch listed in `.lab/branches.md` as active (else `skipped: wrong branch`). Never `git push`. Never touch `main`/`master`.

**Process isolation.** `flock`-style PID lockfile at `.lab/cron.lock`. Concurrent ticks exit cleanly. Stale locks (PID dead) are reaped. Wall-clock budget per tick (default 5min from Discovery); on overrun, SIGTERM pi, log `crash`, release lock.

**Cost / blast radius.** `cron_install` accepts `--max-ticks-per-day N` (default 96). Tick checks today's count from `.lab/results.tsv` and exits if over. Discovery's "Scope" answer is enforced at record time: `lab_record_experiment` rejects any commit that touched a file outside scope (`status=scope-violation`, `git reset --hard`).

**User-presence respect.** `.lab/pause` sentinel — user `touch`es it to pause without removing the cron entry. Ticks see it and exit. Removed → ticks resume.

## Discovery flow

User triggers with `/research-init` (or with a phrase the SKILL's `description` matches: "optimize X", "iterate overnight", "find best config"). The SKILL drives Discovery conversationally:

1. Objective (free text)
2. Primary metric: command + direction (lower/higher better)
3. Optional secondary metrics
4. Scope (files/dirs the agent may modify)
5. Constraints (off-limits)
6. Wall-clock budget per experiment (default 5min)
7. Termination (target value, or "until I run /research-stop")
8. Cron schedule (default `*/15 * * * *`)
9. Max ticks per day (default 96)

Then the agent confirms compactly and calls four tools in order:

1. `lab_init` — create branch `research/<slug>`, `.lab/` directory and files, write `config.md`.
2. `lab_record_experiment` for #0 — run measure command, record baseline.
3. `cron_install` — write tagged crontab line, store the line in `.lab/config.md` for audit.
4. Print one-screen summary; exit.

## Cron-tick flow

```
cron fires:  */15 * * * *  pi-research tick /path/to/project

pi-research tick <dir>  (Bun script, ~150 lines)
├── 1. acquire .lab/cron.lock (flock; reap stale)
├── 2. preconditions (any failure → exit 0, log reason):
│       ✓ .lab/config.md exists
│       ✓ git status --porcelain == ""
│       ✓ HEAD on a branch listed active in .lab/branches.md
│       ✓ .lab/pause does not exist
│       ✓ today's tick count < max-ticks-per-day
├── 3. spawn (timeout = budget + 30s grace):
│       pi -p "researcher: run one iteration"
│         --skill   <abs>/skills/researcher
│         --extension <abs>/extensions/pi-research.ts
│         --no-session --no-context-files
│         --append-system-prompt "Lab dir: /path/to/project"
├── 4. capture pi stdout/stderr → .lab/cron.log (rotate at 10MB)
├── 5. on timeout: SIGTERM pi, log status=crash, git reset --hard
└── 6. release lock; exit
```

Inside the pi turn (driven by SKILL, **one** iteration):

1. Read `.lab/results.tsv`, `.lab/log.md` tail, `.lab/branches.md`, `.lab/parking-lot.md`, in-scope source.
2. Write `## THINK — before Experiment N` entry to `.lab/log.md` (mandatory; SKILL refuses to proceed without it).
3. Edit files. `git commit -m "experiment #N: ..."`. Run measure command. Read result.
4. Call `lab_record_experiment` with `{n, branch, parent, sha, metric, secondary, status, duration, description, insight}`. Tool writes results.tsv row, log.md entry, runs `git reset --hard HEAD~1` if status is `discard`/`crash`/`scope-violation`.
5. Check termination signals (target hit / plateau / max experiments). If met → call `cron_remove`, write `.lab/summary.md`, exit.
6. Otherwise exit. Next tick takes it from here.

Per-tick cost is bounded: one wake → one experiment → one exit. **Cron is the loop.**

## Progress view

```
$ pi-research status

research: reduce p99 latency
schedule: */15 * * * *  (last tick: 6m ago)

metric:  p99_ms (lower=better)
  baseline   142.0
  best        94.0  (#9, -33.8%)
  last       103.0  (#11, discarded)

branch:  research/reduce-p99
experiments: 12  (keeps:5  discards:5  crashes:1  thoughts:1)
plateau check: best unchanged for 3 experiments

recent:
  #11 discard  raw SQL switch              -34s
  #10 keep     JSON serialization tweak    -2:14
  #9  keep     batch getOrderDetails       -4:01
```

`pi-research status` reads `.lab/` directly — no pi boot, no LLM call. Available as `/research-status` slash command inside pi as well.

## Lifecycle

**Resume** is implicit. Every tick reads `.lab/`. The original SKILL's "Phase 0: Resume Check" collapses into the natural read at the start of every tick.

**Branching.** When the SKILL forks (5+ discards, plateau, etc.), the agent runs `git checkout <SHA> && git checkout -b research/<new-slug>` inside the same tick, then logs the new branch via `lab_record_experiment`. Next tick's precondition accepts any branch listed active in `branches.md`.

**Termination.** Agent calls `cron_remove` when target hit / user runs `/research-stop` / convergence guardrails decide we're done. Cron line disappears. `.lab/summary.md` is written. User reads it next time they look.

**Crash recovery.** Three layers: (1) stale lockfile reaped on next tick; (2) dirty worktree from a partial experiment → tick exits cleanly until user resolves; (3) commit landed but row missing → tick reconciles `results.tsv` from `git log --grep="experiment #"` on first read.

## SKILL adaptations from ResearcherSkill

- "Spawn evaluator subagents" removed → quantitative-only path. Multi-evaluator deferred to v2.
- Add "ONE iteration per invocation" framing at the top — the biggest divergence from original.
- Replace inline `.lab/bin/` token-hygiene scripts → tools (`lab_init`, `lab_record_experiment`, `lab_status`) own formatting/idempotency. Less per-tick boilerplate, deterministic output.
- Add cron-aware termination instruction: when termination is met, agent must call `cron_remove` and write `summary.md`.
- All other content (Phase 1 Discovery, THINK→TEST→REFLECT, Execution Discipline, Convergence Signals, Hypothesis Strategies, Branching, Strategy Diversification, Metric Revision, Wrap-Up) ports verbatim with only tool-name swaps.

## Open questions for implementation

- Does `pi install <package>` register both extensions and skills, or only extensions? If only extensions, `cron_install` must inject `--skill <abs-path>` into the cron line explicitly. Verify on first build.
- Does pi support tool-level filesystem allowlists? If yes, scope the extension's tools to the project dir + `.lab/`. If no, runtime check in `lab_record_experiment` is the only enforcement.
- Test harness for cron: probably mock `crontab` via PATH-overridden stub in tests, since real `crontab` is global state.
- Lockfile across pi crash: `flock` releases on FD close, so an unclean exit still releases. PID file is for visibility only.
