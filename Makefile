.DEFAULT_GOAL := help
.PHONY: help broker broker-bg broker-stop broker-status install install-local test typecheck proto-gen

PORT   ?= 7373
HOST   ?= 127.0.0.1
PI_BUS := packages/pi-bus
PID    := /tmp/pi-bus.pid
LOG    := /tmp/pi-bus.log

help:
	@echo "pi-kit make targets"
	@echo ""
	@echo "  broker          Run pi-bus broker in foreground ($(HOST):$(PORT), --verbose)"
	@echo "  broker-bg       Run pi-bus broker detached. PID: $(PID)  Log: $(LOG)"
	@echo "  broker-stop     Kill the detached broker"
	@echo "  broker-status   Show whether the detached broker is alive"
	@echo "  install         pi install pi-bus globally (~/.pi/agent/settings.json)"
	@echo "  install-local   pi install pi-bus into project (.pi/settings.json)"
	@echo "  test            Run pi-bus tests"
	@echo "  typecheck       tsc --noEmit on the workspace"
	@echo "  proto-gen       Regenerate protobuf bindings (buf generate)"
	@echo ""
	@echo "Override host/port: make broker PORT=8080 HOST=0.0.0.0"

broker:
	bun run $(PI_BUS)/bin/pi-bus-server.ts --host $(HOST) --port $(PORT) --verbose

broker-bg:
	@if [ -f $(PID) ] && kill -0 $$(cat $(PID)) 2>/dev/null; then \
		echo "broker already running (pid $$(cat $(PID)))"; \
	else \
		nohup bun run $(PI_BUS)/bin/pi-bus-server.ts --host $(HOST) --port $(PORT) >$(LOG) 2>&1 & echo $$! >$(PID); \
		sleep 0.3; \
		echo "broker pid $$(cat $(PID)) on $(HOST):$(PORT) — logs: $(LOG)"; \
	fi

broker-stop:
	@if [ -f $(PID) ]; then \
		kill $$(cat $(PID)) 2>/dev/null && echo "broker stopped (pid $$(cat $(PID)))" || echo "broker pid $$(cat $(PID)) was not running"; \
		rm -f $(PID); \
	else \
		echo "no $(PID) — broker not started via make broker-bg"; \
	fi

broker-status:
	@if [ -f $(PID) ] && kill -0 $$(cat $(PID)) 2>/dev/null; then \
		echo "broker running (pid $$(cat $(PID))) on $(HOST):$(PORT)"; \
	else \
		echo "broker not running"; \
	fi

install:
	pi install $(CURDIR)/$(PI_BUS)

install-local:
	pi install -l $(CURDIR)/$(PI_BUS)

test:
	bun test $(PI_BUS)/test/*.test.ts

typecheck:
	bun run typecheck

proto-gen:
	bun run proto:generate
