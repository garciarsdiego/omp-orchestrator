import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { ompExecutable, parseJsonOutput, runOmp } from "./lib.mjs";

const RUNTIME_DIR = path.join(os.tmpdir(), "omp-orchestrator");
const STATE_FILE = path.join(RUNTIME_DIR, "runtime.json");
const BROKER = { host: "127.0.0.1", port: 9000 };
const GATEWAY = { host: "127.0.0.1", port: 4000 };

function readState() {
  try {
    return JSON.parse(readFileSync(STATE_FILE, "utf8"));
  } catch {
    return null;
  }
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function portOpen({ host, port }, timeout = 300) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    const done = (value) => {
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(timeout);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}

async function waitForPort(target, expected, timeout = 10_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await portOpen(target) === expected) return;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`Timed out waiting for ${target.host}:${target.port}.`);
}

function spawnOmp(args, env = process.env) {
  const child = spawn(ompExecutable(env), args, {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    env
  });
  child.unref();
  return child.pid;
}

function stopPid(pid) {
  if (!pidAlive(pid)) return false;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true
    });
  } else {
    process.kill(-pid, "SIGTERM");
  }
  return true;
}

export async function runtimeStatus() {
  const state = readState();
  const brokerPortOpen = await portOpen(BROKER);
  const gatewayPortOpen = await portOpen(GATEWAY);
  return {
    managed: Boolean(state),
    running: Boolean(state && pidAlive(state.brokerPid) && pidAlive(state.gatewayPid) && brokerPortOpen && gatewayPortOpen),
    broker: {
      url: `http://${BROKER.host}:${BROKER.port}`,
      pid: state?.brokerPid || null,
      processAlive: pidAlive(state?.brokerPid),
      portOpen: brokerPortOpen
    },
    gateway: {
      url: `http://${GATEWAY.host}:${GATEWAY.port}/v1`,
      pid: state?.gatewayPid || null,
      processAlive: pidAlive(state?.gatewayPid),
      portOpen: gatewayPortOpen,
      bearerRequired: true
    },
    secretsReturned: false
  };
}

export async function startRuntime({ confirm = false } = {}) {
  if (!confirm) throw new Error("Runtime startup requires confirm=true.");
  const current = await runtimeStatus();
  if (current.running) return { changed: false, ...current };
  if ((!current.managed && current.broker.portOpen) || (!current.managed && current.gateway.portOpen)) {
    throw new Error("A required loopback port is already occupied by an unmanaged process.");
  }

  const brokerAuth = parseJsonOutput(runOmp(["auth-broker", "token", "--json"]), "broker token command");
  const gatewayAuth = parseJsonOutput(runOmp(["auth-gateway", "token", "--json"]), "gateway token command");
  if (!brokerAuth.token || !gatewayAuth.token) throw new Error("OMP did not provide the required runtime tokens.");

  let brokerPid;
  let gatewayPid;
  try {
    brokerPid = spawnOmp(["auth-broker", "serve", "--bind", `${BROKER.host}:${BROKER.port}`]);
    await waitForPort(BROKER, true);
    gatewayPid = spawnOmp(
      ["auth-gateway", "serve", "--bind", `${GATEWAY.host}:${GATEWAY.port}`],
      {
        ...process.env,
        OMP_AUTH_BROKER_URL: `http://${BROKER.host}:${BROKER.port}`,
        OMP_AUTH_BROKER_TOKEN: brokerAuth.token
      }
    );
    await waitForPort(GATEWAY, true);
    mkdirSync(RUNTIME_DIR, { recursive: true });
    writeFileSync(STATE_FILE, JSON.stringify({ brokerPid, gatewayPid, startedAt: new Date().toISOString() }), {
      encoding: "utf8",
      mode: 0o600
    });
    return { changed: true, ...(await runtimeStatus()) };
  } catch (error) {
    if (gatewayPid) stopPid(gatewayPid);
    if (brokerPid) stopPid(brokerPid);
    throw error;
  }
}

export async function stopRuntime({ confirm = false } = {}) {
  if (!confirm) throw new Error("Runtime shutdown requires confirm=true.");
  const state = readState();
  if (!state) return { changed: false, ...(await runtimeStatus()) };
  const gatewayStopped = stopPid(state.gatewayPid);
  const brokerStopped = stopPid(state.brokerPid);
  rmSync(STATE_FILE, { force: true });
  await waitForPort(GATEWAY, false).catch(() => {});
  await waitForPort(BROKER, false).catch(() => {});
  return { changed: gatewayStopped || brokerStopped, ...(await runtimeStatus()) };
}
