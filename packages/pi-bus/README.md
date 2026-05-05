# pi-bus

`pi-bus` is a small broker + pi extension that lets multiple pi agents communicate over a bidirectional event bus.

- Broker: TCP or Unix-socket JSONL server
- Pi extension: connects each pi process as an agent
- Agent tools: `bus_connect`, `bus_publish`, `bus_agents`, `bus_inbox`, `bus_wait`, `bus_disconnect`
- Slash commands: `/bus-connect`, `/bus-disconnect`, `/bus-status`, `/bus-send`, `/bus-inbox`, `/bus-reconnect`
- Push-based delivery: connected agents receive matching events immediately; the extension pushes them into context by default and can auto-trigger turns for targeted events.

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

## Package usage

This module is a pi package. Load it directly:

```bash
pi -e /path/to/pi-kit/packages/pi-bus
```

Or install it into pi settings:

```bash
pi install /path/to/pi-kit/packages/pi-bus
```

## Configuration

The extension supports CLI flags and matching environment variables:

| Flag | Env | Default |
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
- `targeted` — push only events addressed to this agent, unless the event has `meta.push=true`.
- `off` — buffer events only; use `bus_inbox`/`bus_wait` manually.

`--bus-trigger` controls whether pushed events also start/steer an agent turn:

- `targeted` — trigger only events addressed to this agent, unless the event has `meta.trigger=true`.
- `all` — trigger every pushed event.
- `off` — never auto-trigger; events still appear in context/inbox.

Use a token if you bind beyond localhost:

```bash
PIBUS_TOKEN=$(openssl rand -hex 16) bun run packages/pi-bus/bin/pi-bus-server.ts --host 127.0.0.1 --token "$PIBUS_TOKEN"
PIBUS_TOKEN=$PIBUS_TOKEN pi -e ./packages/pi-bus/extensions/pi-bus.ts
```

## Protocol model

Clients send a `hello` frame, then the broker pushes matching `event` frames to connected subscribers. Events have this shape:

```json
{
  "id": "evt_...",
  "room": "default",
  "topic": "agent.message",
  "from": { "agentId": "planner", "name": "Planner" },
  "target": ["worker"],
  "text": "Please inspect the failing tests.",
  "priority": "normal",
  "meta": { "push": true, "trigger": false },
  "createdAt": "2026-05-05T00:00:00.000Z"
}
```

Broadcast events deliver to connected clients in the same room with matching topic subscriptions. Direct `target` events deliver to the target agent id/name even if its topic subscription would not otherwise match. Disconnected agents do not receive live pushes; they can reconnect later and inspect broker history if needed.

## Development

```bash
bun test packages/pi-bus/test/*.test.ts
bun run packages/pi-bus/test/pi-rpc-smoke.ts
```

## Safety notes

PiBus messages become agent context by default. This is useful for coordination but means connected peers can influence each other. Keep the broker on localhost or protect it with `PIBUS_TOKEN`, and only connect agents you trust.
