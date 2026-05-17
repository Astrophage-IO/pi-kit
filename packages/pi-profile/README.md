# @astrophage-io/pi-profile

Portable pi setup via a single gist. Declare which pi extensions to install, which `~/.pi/agent/settings.json` keys to manage, which files to materialize, and which env vars are required — then `pi-profile sync` makes any machine match.

## Why this exists

You run pi on a laptop, a desktop, and a remote box. You want all three to have the same extensions installed, the same default model, the same `superpowers.json` MCP profiles, the same `PIBUS_*` defaults. You do not want to copy/paste settings into a gist each time — you want to edit one file and have every machine catch up.

`pi-profile` is that thin layer:

- One JSON manifest, served from any URL (a single gist works great).
- `pi-profile init <url>` on a new machine; `pi-profile sync` afterwards.
- Tracks what it owns so it can coexist with hand-installed pi packages and per-host settings.
- Secrets stay local: the manifest only declares which env var names are required; tokens never go in the gist.

## Install

From this workspace:

```bash
pi install /Users/manash/projects/pi-kit/packages/pi-profile
```

Or, project-local:

```bash
pi install -l /Users/manash/projects/pi-kit/packages/pi-profile
```

## Bootstrap on a fresh machine

```bash
bunx -p @astrophage-io/pi-profile pi-profile init https://gist.github.com/<user>/<id>
```

Once bun + pi are present:

```bash
pi install @astrophage-io/pi-profile
pi-profile init <gist-url>
```

`init` saves the source URL in `~/.pi/profile/state.json`. After that you only need:

```bash
pi-profile sync
```

## Manifest (`pi-profile.json`)

```json
{
  "apiVersion": "pi-profile/v1",
  "name": "manash-default",
  "description": "My pi setup across machines",
  "packages": [
    "@astrophage-io/pi-bus",
    "@astrophage-io/pi-superpowers",
    { "source": "@vendor/pi-something@^1.2.0", "extensions": ["specific-ext"] },
    "git+https://github.com/manash/some-pi-thing#main"
  ],
  "settings": {
    "defaultProvider": "anthropic",
    "defaultModel": "claude-sonnet-4-5",
    "defaultThinkingLevel": "medium",
    "theme": "tokyonight",
    "enableSkillCommands": true
  },
  "env": {
    "PIBUS_PUSH": "targeted",
    "PIBUS_ROOM": "default"
  },
  "files": [
    { "target": "~/.pi/agent/superpowers.json", "source": "superpowers.json" }
  ],
  "secrets": {
    "required": ["SLACK_BOT_TOKEN", "SLACK_TEAM_ID"],
    "optional": ["PIBUS_TOKEN"]
  },
  "hosts": {
    "homelab": {
      "env": { "PIBUS_HOST": "10.0.0.5" },
      "packages": ["@some-other/extension"]
    }
  },
  "postApply": ["echo Profile applied at $(date)"]
}
```

Field rules:

- `packages[]` accepts any source `pi install` accepts: marketplace name, version range, scoped name, `git+...`, local path. Either a bare string or `{ source, extensions?, skills?, prompts?, themes? }`.
- `settings` keys are written into `~/.pi/agent/settings.json` (the same file pi writes). `pi-profile` only touches keys it owns (see ownership below).
- `env[KEY]` must be uppercase alphanumeric/underscore; values must be strings. `pi-profile` does not modify your shell, it just reports `export ...` lines via `diff`/`sync` output.
- `files[]` writes string contents from the gist (file name in `source`) to `target` (tilde-expanded). `mode` is an optional octal integer.
- `secrets.required[]` are checked against `process.env` on `apply` and fail the run if missing. `secrets.optional[]` are reported but not enforced.
- `hosts[<hostname>]` is a per-host overlay: `env`/`settings` shallow-merge over the base, `packages`/`postApply` append, `files` merge by `target`. Set `PI_PROFILE_HOST` to override the detected hostname.

## Source (single gist)

A GitHub gist holds multiple files in one place. Put `pi-profile.json` plus any `files[].source` (e.g. `superpowers.json`) into the same gist. `init`/`sync`/`diff` accept any of:

- Full gist URL: `https://gist.github.com/<user>/<id>`
- Raw file URL: `https://gist.githubusercontent.com/<user>/<id>/raw/...` (optionally pinned to a commit sha)
- Bare gist id (32 hex)
- Local directory or file path (skips fetching; useful when iterating)

Secret gists work if you set `GITHUB_TOKEN` (or `PI_PROFILE_GITHUB_TOKEN`) in your environment.

## Ownership: how `pi-profile` coexists with hand-installed packages

`pi-profile` records what it installed/wrote in `~/.pi/profile/state.json` (`ownedPackages`, `ownedSettings`, `ownedFiles`). On every `apply`:

- It only `pi remove`s packages it previously installed via the profile.
- It only overwrites settings keys listed in the manifest; when a key disappears from the manifest, the previous value (captured at first apply) is restored.
- Managed files snapshot their pre-profile content; removing a file from the manifest restores it (or deletes it if nothing was there before).

That means you can keep `pi install`-ing extras on a single machine without `pi-profile sync` clobbering them.

## Secrets

Tokens never go in the gist. The manifest declares names; `pi-profile` checks them on the local machine.

- Set them in your shell (`~/.zshrc`) like normal.
- Or put `KEY=value` lines in `~/.pi/profile/secrets.env` (gitignored, you set the perms). `pi-profile` reads it before checking env.

`pi-profile secrets` prints which are required, which are optional, and which are currently missing.

## CLI

```
pi-profile init <gist-url|id|local-path>   # save source and apply now
pi-profile sync                            # re-fetch saved source and apply
pi-profile diff [path]                     # show drift without writing
pi-profile apply <path>                    # apply a local manifest (skip fetch)
pi-profile status                          # show URL, pinned version, last sync, ownership
pi-profile secrets                         # list required/optional secrets and gaps
pi-profile push                            # write current state back to the gist (stub in v1)
```

Common flags: `--state-file`, `--settings-file`, `--host`, `--token`, `--pi <bin>`, `--dry-run`.

## Pi extension

When loaded into pi (`pi install @astrophage-io/pi-profile`), the extension registers:

- Slash commands: `/profile-status`, `/profile-diff`, `/profile-sync`
- Tools: `profile_status`, `profile_diff`, `profile_sync({ dryRun? })`
- A `session_start` hook that surfaces the active profile in the status bar

Override the saved source for a single session via `--profile-source <url-or-path>`.

## v1 scope and known limits

In scope:

- Marketplace + git + local pi extensions
- pi `~/.pi/agent/settings.json` keys (any of pi's documented fields)
- Managed files (multi-line strings stored in the same gist)
- Per-host overlay
- Required/optional env var checks
- Ownership-aware diff/sync (won't clobber hand-installed packages or unmanaged settings)

Out of scope (deliberate, called out so you don't expect them):

- Encrypted secrets in the gist (use 1Password CLI / sops / age outside the tool)
- Multi-profile (per-project profiles) — start with one global profile
- Auto-sync on pi startup — `sync` is explicit
- Non-gist private sources (S3, private GitLab) — work via `apply <local-file>` after a manual download
- `pi-profile push` writes back to the gist — v1 prints instructions; full `gh gist edit` flow lands later

## Development

```bash
bun run typecheck
bun test packages/pi-profile/test/*.test.ts
```
