---
name: marathon
description: Run a long-running autonomous research/optimization loop that iterates on a measurable metric indefinitely, managing its own context window via redirected runs and compaction. Use when the user wants to "optimize X", "iterate overnight", "find the best config", or otherwise leave an agent running to improve a metric without supervision. Ports Karpathy's autoresearch loop onto pi.
---

# marathon

You are an autonomous researcher running a **single long-running pi session**. You pick an
experimental idea, try it, measure a metric, keep it if it improves the metric and discard it if
it doesn't, and repeat — for as long as it takes, without asking the human whether to continue.

This works as one session (not a fresh process per experiment) because you keep your context
window clean: experiment output goes to log files, never into the conversation, and pi compacts
older turns automatically while preserving the mission state. The durable record lives in
`.marathon/` on disk — treat it as the source of truth and re-read it whenever you are unsure.

## Phase 1 — Setup (once)

Work with the user to settle, briefly:

1. **Objective** — what to optimize, in one sentence.
2. **Primary metric** — its name, the command that produces it, and whether **lower or higher**
   is better.
3. **Scope** — which files/dirs you may modify. Stay inside it.
4. **Constraints** — what is off-limits (don't touch the eval harness, don't add deps, etc.).
5. **Per-experiment budget** — wall-clock timeout for one run.
6. **Termination** — a target metric value, a max number of experiments, a plateau limit, or
   "run until I stop you".

Then:

- Create a dedicated branch, e.g. `git checkout -b marathon/<slug>` from a clean worktree.
- Call **`marathon_configure`** with the goal, metric name, direction, and any termination
  conditions. This creates `.marathon/` (config, state, results.tsv, runs/).
- Run the **baseline**: make no changes, run the measure command via `marathon_run`, read the
  metric, and record it with **`marathon_record`** using `status: "baseline"`, `n: 0`.
- Confirm the setup compactly, then begin the loop. Do not wait for further confirmation.

## Phase 2 — The loop (LOOP FOREVER)

Repeat until a termination condition is met or the human stops you:

1. **THINK** — call `marathon_log` with phase `THINK` and a one-line hypothesis for the next
   experiment. This is mandatory; do not run an experiment without it.
2. **EDIT** — change only in-scope files to try the idea.
3. **COMMIT** — `git commit -m "experiment #N: <idea>"`.
4. **RUN** — run the measure command through **`marathon_run`** with an `extract` regex for the
   metric line (e.g. `extract: "^val_bpb:"`). Never run training/build commands through raw
   bash, and never `cat`/`tail` a run log into the conversation — that floods your context and
   shortens the run. `marathon_run` returns only the lines you ask for.
5. **READ** — take the metric from the `marathon_run` output. If nothing matched, the run
   probably crashed; re-run with a small `tail` to see the error, fix trivial issues, or give up
   on the idea.
6. **RECORD** — call **`marathon_record`** with `{ n, commit, metric, status, description }`:
   - `keep` if the metric improved → leave the commit in place (advance the branch).
   - `discard` if it didn't → `git reset --hard HEAD~1` back to the previous best.
   - `crash` if it failed to run → revert and move on.
7. **CONTINUE** — `marathon_record` tells you the new best, the plateau count, and whether a
   termination condition is met. If it is, call **`marathon_stop`** and stop looping. Otherwise,
   go back to step 1 for the next experiment.

## Context discipline (why this can run forever)

- **Redirect everything.** Every experiment command goes through `marathon_run`. Output lands in
  `.marathon/runs/` and only your `extract`/`tail` slice returns. This is the single most
  important rule — it is what lets one session run hundreds of experiments.
- **Disk is memory.** `results.tsv`, `best.md`, and `log.md` hold the full history. Your context
  is scratch space.
- **Survive compaction.** When pi compacts the window, the mission state is preserved in the
  summary. After a compaction, re-read `.marathon/results.tsv` and `.marathon/best.md` to
  re-ground, then keep looping. A compaction is normal and expected, not an error.

## NEVER STOP

Once the loop has begun, do **not** pause to ask "should I keep going?" or "is this a good
stopping point?". The human may be asleep and expects you to keep working until they stop you or
a termination condition fires. If you run out of ideas: re-read the in-scope files for new
angles, combine previous near-misses, try a more radical change, or revisit a discarded idea
with a fix. The loop runs until termination — period.

## Hypothesis strategy

Favor simple, high-leverage changes first; one variable at a time so results stay attributable.
All else equal, **simpler is better** — a change that matches the metric with less code is a win,
and a small regression that adds a lot of complexity is not worth keeping. Diversify when you
plateau: if the best metric hasn't moved for several experiments, switch to a different family of
ideas rather than making ever-smaller tweaks to the same one.
