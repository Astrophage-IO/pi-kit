# @astrophage-io/pi-bus

`@astrophage-io/pi-bus` is a Bun-first pi package that provides a small broker, client library, CLI, and pi extension for push-based coordination between isolated pi agents.

- Broker: TCP or Unix-socket server using length-prefixed protobuf frames (`proto/pi_bus/v1/pi_bus.proto`).
- Pi extension: connects each pi process as an agent and receives pushed events in real time.
- Agent tools: `bus_connect`, `bus_publish`, `bus_agents`, `bus_inbox`, `bus_wait`, `bus_disconnect`.
- Slash commands: `/bus-connect`, `/bus-disconnect`, `/bus-status`, `/bus-send`, `/bus-inbox`, `/bus-reconnect`.
- Push-based delivery: connected agents receive matching events immediately; the extension pushes them into context by default and can auto-trigger turns for targeted events.

## Requirements

This package intentionally ships TypeScript source and Bun shebang binaries. Use Bun to run the broker and CLI.

Peer packages used by the extension:

- `@mariozechner/pi-coding-agent` `^0.73.0`
- `@mariozechner/pi-tui` `^0.73.0`
- `typebox` `^1.1.0`

The client/server protocol dependency is `@bufbuild/protobuf`.

## Quick start from the workspace root

Start the broker:

```bash
bun run packages/pi-bus/bin/pi-bus-server.ts --port 7373 --verbose
```

Start two pi sessions with different agent names:

```bash
PIBUS_AGENT=planner PIBUS_NAME=planner PIBUS_PORT=7373 pi -e ./packages/pi-bus/extensions/pi-bus.ts
PIBUS_AGENT=worker  PIBUS_NAME=worker  PIBUS_PORT=7373 pi -e ./packages/pi-bus/extensions/pi-bus.ts
```

Ask one agent to coordinate:

```text
Use bus_agents to find peers, then send worker a short implementation request with bus_publish.
```

For isolated/on-demand agents, disable autostart and connect only when needed:

```bash
PIBUS_AUTOSTART=0 PIBUS_AGENT=scout PIBUS_NAME=scout PIBUS_PORT=7373 pi -e ./packages/pi-bus/extensions/pi-bus.ts
```

Then ask the agent to use `bus_connect`, dispatch with `bus_publish`, receive pushed events, and call `bus_disconnect` when done.

## From inside this package

```bash
bun run bin/pi-bus-server.ts --port 7373 --verbose
PIBUS_AGENT=planner PIBUS_NAME=planner pi -e ./extensions/pi-bus.ts
```

The convenience CLI can publish or inspect broker state:

```bash
bun run bin/pi-bus.ts publish --topic agent.message "hello peers"
bun run bin/pi-bus.ts peers
bun run bin/pi-bus.ts history --room default --topic agent.*
```

## Package usage

Load it directly as a pi package:

```bash
pi -e /path/to/pi-kit/packages/pi-bus
```

Or install it into pi settings:

```bash
pi install /path/to/pi-kit/packages/pi-bus
```

## Broker configuration

Broker flags are accepted by `pi-bus-server` / `bun run packages/pi-bus/bin/pi-bus-server.ts`:

| Broker flag | Env | Default | Notes |
|---|---|---:|---|
| `--host` | `PIBUS_HOST` | `127.0.0.1` | TCP bind host |
| `--port` | `PIBUS_PORT` | `7373` | TCP bind port; `0` picks a free port |
| `--socket` | `PIBUS_SOCKET` | unset | Unix socket path; overrides host/port |
| `--token` | `PIBUS_TOKEN` | unset | Shared token required from clients |
| `--history` | `PIBUS_HISTORY` | `500` | Events retained for history |
| `--verbose` | — | `false` | Log broker activity |
| `--version` | — | — | Print package version |

Use a token if you bind beyond localhost:

```bash
PIBUS_TOKEN=$(openssl rand -hex 16)
bun run packages/pi-bus/bin/pi-bus-server.ts --host 127.0.0.1 --token "$PIBUS_TOKEN"
PIBUS_TOKEN=$PIBUS_TOKEN pi -e ./packages/pi-bus/extensions/pi-bus.ts
```

## Extension configuration

The pi extension supports pi flags and matching environment variables:

| Extension flag | Env | Default |
|---|---|---|
| `--bus-host` | `PIBUS_HOST` | `127.0.0.1` |
| `--bus-port` | `PIBUS_PORT` | `7373` |
| `--bus-socket` | `PIBUS_SOCKET` | unset |
| `--bus-token` | `PIBUS_TOKEN` | unset |
| `--bus-room` | `PIBUS_ROOM` | `default` |
| `--bus-topics` | `PIBUS_TOPICS` | `*` |
| `--bus-agent` | `PIBUS_AGENT` | generated process id |
| `--bus-name` | `PIBUS_NAME` | project/pid label |
| `--bus-autostart` | `PIBUS_AUTOSTART` | `true` |
| `--bus-push` | `PIBUS_PUSH` / `PIBUS_PUSH_MODE` | `all` |
| `--bus-trigger` | `PIBUS_TRIGGER` / `PIBUS_TRIGGER_MODE` | `targeted` |

`--bus-push` controls automatic pushed context injection:

- `all` — push every subscribed incoming event into context immediately.
- `targeted` — push only events addressed to this agent, unless the event has `hints.push=true` or `hints.trigger=true`.
- `off` — buffer events only; use `bus_inbox`/`bus_wait` manually.

`--bus-trigger` controls whether pushed events also start/steer an agent turn:

- `targeted` — trigger only events addressed to this agent, unless the event has `hints.trigger=true`.
- `all` — trigger every pushed event.
- `off` — never auto-trigger; events still appear in context/inbox.

## Protocol model

PiBus uses a four-byte big-endian length prefix followed by a protobuf `pi_bus.v1.Frame`. The schema lives in [`../../proto/pi_bus/v1/pi_bus.proto`](../../proto/pi_bus/v1/pi_bus.proto), and generated TypeScript lives under `src/gen/`.

Clients send a `hello` frame, then commands such as `publish`, `subscribe`, `history_request`, and `peers_request`. The broker pushes matching `event`, `presence`, `ping`, and response frames to connected subscribers.

Events have this logical shape:

```json
{
  "id": "evt_...",
  "room": "default",
  "topic": "agent.message",
  "from": { "agentId": "planner", "name": "Planner" },
  "target": ["worker"],
  "text": "Please inspect the failing tests.",
  "priority": "normal",
  "hints": { "push": true, "trigger": false },
  "meta": { "source": "handoff" },
  "createdAt": "2026-05-05T00:00:00.000Z"
}
```

Broadcast events deliver to connected clients in the same room with matching topic subscriptions. Direct `target` events deliver to the target agent id/name/connection id even if its topic subscription would not otherwise match. Disconnected agents do not receive live pushes; they can reconnect later and inspect broker history if needed.

## Development

```bash
bun run proto:lint
bun run proto:generate
bun run typecheck
bun test packages/pi-bus/test/*.test.ts
bun run packages/pi-bus/test/pi-rpc-smoke.ts
```

## Safety notes

PiBus messages become agent context by default. This is useful for coordination but means connected peers can influence each other. Keep the broker on localhost or protect it with `PIBUS_TOKEN`, and only connect agents you trust.
