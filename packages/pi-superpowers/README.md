# @astrophage-io/pi-superpowers

Specialist Pi agents spawned from a primary Pi session.

The normal Pi agent gets high-level tools like `slack_research`, `jira_research`, and `confluence_research`. When one is called, the tool spawns an isolated child `pi` process with a specialist prompt and MCP-backed tools for that profile. The child gathers evidence and returns a researched answer to the parent session.

## Why this exists

You keep using the original Pi session:

```text
Use Slack research to explain what was decided in this thread: https://...
```

The parent agent calls `slack_research(...)`; you do **not** manually run a `pi-slack` alias.

## Install

From GitHub Packages (configure your `~/.npmrc` once — see the [root README](../../README.md#install-from-github-packages)):

```bash
pi install @astrophage-io/pi-superpowers
```

Or from this workspace:

```bash
pi install /Users/manash/projects/pi-kit/packages/pi-superpowers
```

Or for only the current project:

```bash
pi install -l /Users/manash/projects/pi-kit/packages/pi-superpowers
```

## Configure MCP profiles

Copy the example config:

```bash
mkdir -p ~/.pi/agent
cp /Users/manash/projects/pi-kit/packages/pi-superpowers/config/superpowers.example.json ~/.pi/agent/superpowers.json
```

Edit `~/.pi/agent/superpowers.json` to match the Slack/Atlassian MCP servers you actually use.

The default config path can be overridden with:

```bash
PI_SUPERPOWERS_CONFIG=/path/to/superpowers.json pi
```

or with the Pi flag:

```bash
pi --superpower-config /path/to/superpowers.json
```

## Config shape

```json
{
  "profiles": {
    "slack": {
      "servers": ["slack"],
      "allowTools": ["*"],
      "blockTools": ["*post*", "*send*", "*update*", "*delete*", "*react*"],
      "model": "claude-haiku-4-5"
    }
  },
  "servers": {
    "slack": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-slack"],
      "env": {
        "SLACK_BOT_TOKEN": "$SLACK_BOT_TOKEN",
        "SLACK_TEAM_ID": "$SLACK_TEAM_ID"
      }
    }
  }
}
```

- `profiles.<name>.servers` lists MCP servers available to that specialist.
- `allowTools` and `blockTools` are matched against MCP tool names and generated Pi tool names. `*` wildcards are supported.
- `model`, `thinking`, `systemPrompt`, and `extraArgs` are optional child-Pi settings.
- `servers.<name>` is a stdio MCP server command. Env values like `$SLACK_BOT_TOKEN` are expanded from the parent environment.

## Usage

Start normal Pi after install:

```bash
pi
```

Ask normally:

```text
Use Slack research to answer what the team decided in this Slack thread: https://...
```

Or:

```text
Use Jira research to explain the blocker on PROJ-1234 and cite comments.
```

The primary agent calls one of:

- `slack_research`, `jira_research`, `confluence_research` — always registered; route to the matching profile in `superpowers.json`.
- `<profile>_research` — auto-registered for every additional profile defined in `superpowers.json`. For example, adding a `github` profile registers `github_research`.
- `specialist_research({ profile, question, ... })` — generic fallback that takes the profile name as a parameter; useful for custom or rarely used profiles.

Each tool starts a child command roughly like:

```bash
pi --mode json -p --no-session --no-builtin-tools \
  -e ./extensions/superpowers.ts \
  --superpower-child=true \
  --superpower-profile slack \
  --superpower-config ~/.pi/agent/superpowers.json \
  --system-prompt '<bundled Slack research prompt>' \
  '<task>'
```

## Specialist prompts

Bundled prompts live in `agents/`:

- `agents/slack-research.md`
- `agents/jira-research.md`
- `agents/confluence-research.md`

Override per profile with:

```json
{
  "profiles": {
    "slack": {
      "servers": ["slack"],
      "systemPrompt": "/absolute/path/to/my-slack-research.md"
    }
  }
}
```

## Coordinate with pi-bus (optional)

Specialists can publish findings back to the parent or other peers via PiBus by passing `--superpower-bus`:

```bash
pi --superpower-bus --bus-name planner
# or, persistently:
PI_SUPERPOWER_BUS=1 pi
```

When set, every child spawned by `slack_research`, `jira_research`, etc. loads `@astrophage-io/pi-bus` and connects to the same broker as the parent. Children inherit `PIBUS_ROOM`/`PIBUS_TOPICS` from the parent's env and get a derived `PIBUS_NAME` like `planner/slack`. The child's push mode defaults to `off` so inbound events don't steal the specialist's context — it just gains the ability to call `bus_publish` to surface progress, ask questions, or hand off work.

If the `@astrophage-io/pi-bus` package isn't installed alongside `@astrophage-io/pi-superpowers`, pass an explicit path with `--superpower-bus-extension /path/to/pi-bus/extensions/pi-bus.ts`.

## Safety

Use read-only MCP tools for research profiles. The example config blocks common mutation tool names (`post`, `send`, `update`, `delete`, `comment`, etc.), but MCP servers vary. Review your MCP server's tool list and tighten `allowTools`/`blockTools` before using this with production workspaces.
