import { AsyncLocalStorage } from "node:async_hooks";

// The transport that authenticated a request records who is acting; the core
// reads it for audit events and review attestations. Local transports (stdio
// MCP, CLI) run as the operator of this machine.
const storage = new AsyncLocalStorage();
const LOCAL_ACTOR = Object.freeze({ name: "local-operator", mechanism: "local-process" });

export function withActor(actor, work) {
  return storage.run(Object.freeze({ name: actor.name, mechanism: actor.mechanism }), work);
}

export function currentActor() {
  return storage.getStore() || LOCAL_ACTOR;
}
