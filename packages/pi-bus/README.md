# pi-bus

`pi-bus` is a small broker + pi extension that lets multiple pi agents communicate over a bidirectional event bus.

- Broker: TCP or Unix-socket JSONL server
- Pi extension: connects each pi process as an agent
- Agent tools: `bus_publish`, `bus_inbox`, `bus_agents`, `bus_wait`
- Slash commands: `/bus-status`, `/bus-send`, `/bus-inbox`, `/bus-reconnect`

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
| `--bus-inject-broadcast` | `PIBUS_INJECT_BROADCAST` | `true` |
| `--bus-trigger-addressed` | `PIBUS_TRIGGER_ADDRESSED` | `true` |

Use a token if you bind beyond localhost:

```bash
PIBUS_TOKEN=$(openssl rand -hex 16) bun run packages/pi-bus/bin/pi-bus-server.ts --host 127.0.0.1 --token "$PIBUS_TOKEN"
PIBUS_TOKEN=$PIBUS_TOKEN pi -e ./packages/pi-bus/extensions/pi-bus.ts
```

## Protocol model

Clients send a `hello` frame, then publish or receive `event` frames. Events have this shape:

```json
{
  "id": "evt_...",
  "room": "default",
  "topic": "agent.message",
  "from": { "agentId": "planner", "name": "Planner" },
  "target": ["worker"],
  "text": "Please inspect the failing tests.",
  "priority": "normal",
  "createdAt": "2026-05-05T00:00:00.000Z"
}
```

Broadcast events deliver to clients in the same room with matching topic subscriptions. Direct `target` events deliver to the target agent id/name even if its topic subscription would not otherwise match.

## Development

```bash
bun test packages/pi-bus/test/*.test.ts
bun run packages/pi-bus/test/pi-rpc-smoke.ts
```

## Safety notes

PiBus messages become agent context by default. This is useful for coordination but means connected peers can influence each other. Keep the broker on localhost or protect it with `PIBUS_TOKEN`, and only connect agents you trust.
