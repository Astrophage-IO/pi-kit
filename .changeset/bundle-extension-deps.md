---
"@astrophage-io/pi-superpowers": patch
"@astrophage-io/pi-marathon": patch
"@astrophage-io/pi-profile": patch
"@astrophage-io/pi-bus": patch
---

Ship extensions as self-contained bundles so they load regardless of install method.

Each extension is now bundled into `dist/` with its real npm dependencies inlined
(`@bufbuild/protobuf`, `@modelcontextprotocol/sdk`), while pi-provided modules
(pi-coding-agent, pi-tui, typebox) stay external. `pi.extensions` points at the built
bundle, so an installed extension no longer fails with `Cannot find module` when the
host doesn't install or co-locate dependencies (e.g. `pi install <local path>`, a bare
clone, or partial workspace hoisting).

Also marks the legacy `@mariozechner/*` and `typebox` peer dependencies optional so
package managers stop pulling stale host packages on install.
