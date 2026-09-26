import { EventEmitter } from "node:events";
import { spawn, spawnSync } from "node:child_process";
import path from "node:path";

const ADAPTER_EVENT_VERSION = 1;
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_FRAME_BYTES = 1_048_576;
const DEFAULT_MAX_REASSEMBLED_BYTES = 8 * 1_024 * 1_024;

export class OmpRpcError extends Error {
  constructor(message, { code = "omp_rpc_error", command, id } = {}) {
    super(message);
    this.name = "OmpRpcError";
    this.code = code;
    this.command = command;
    this.id = id;
  }
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function timeoutAfter(timeoutMs, onTimeout) {
  const timer = setTimeout(onTimeout, timeoutMs);
  timer.unref?.();
  return timer;
}

function assertPositiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} must be a positive integer.`);
}

function assertMessage(message, label = "Message") {
  if (typeof message !== "string" || !message.trim()) throw new Error(`${label} must be a non-empty string.`);
}

function stopProcessTree(child, signal = "SIGTERM") {
  if (!child?.pid) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
  } else {
    try { process.kill(-child.pid, signal); } catch { child.kill(signal); }
  }
}

function rpcFlags(command) {
  if (!/^omp(?:\.exe)?$/i.test(path.basename(command))) return ["--mode", "rpc", "--no-ui"];
  // OMP 18.3.0 serves RPC but predates --no-ui. Probe the public help surface
  // without loading credentials or sending a provider request.
  const help = spawnSync(command, ["--help"], {
    encoding: "utf8", windowsHide: true, timeout: 5_000, maxBuffer: 2_000_000
  });
  return (help.stdout || "").includes("--no-ui")
    ? ["--mode", "rpc", "--no-ui"]
    : ["--mode", "rpc", "--no-extensions"];
}

export class OmpRpcClient extends EventEmitter {
  constructor({
    command = "omp",
    args = [],
    cwd,
    env = {},
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxFrameBytes = DEFAULT_MAX_FRAME_BYTES,
    maxReassembledBytes = DEFAULT_MAX_REASSEMBLED_BYTES,
    spawnImpl = spawn
  } = {}) {
    super();
    if (typeof command !== "string" || !command) throw new Error("OMP RPC command is required.");
    if (!Array.isArray(args) || args.some((arg) => typeof arg !== "string")) throw new Error("OMP RPC args must be a string array.");
    if (typeof cwd !== "string" || !cwd) throw new Error("OMP RPC cwd is required.");
    assertPositiveInteger(timeoutMs, "OMP RPC timeoutMs");
    assertPositiveInteger(maxFrameBytes, "OMP RPC maxFrameBytes");
    assertPositiveInteger(maxReassembledBytes, "OMP RPC maxReassembledBytes");

    this.cwd = path.resolve(cwd);
    this.timeoutMs = timeoutMs;
    this.maxFrameBytes = maxFrameBytes;
    this.maxReassembledBytes = maxReassembledBytes;
    this.pending = new Map();
    this.promptCompletions = new Map();
    this.settledWaiters = new Set();
    this.lastSettled = null;
    this.stdoutBuffer = Buffer.alloc(0);
    this.stderrBytes = 0;
    this.requestNumber = 0;
    this.readyFrame = null;
    this.chunk = null;
    this.closed = false;
    this.closeRequested = false;
    this.readyDeferred = deferred();
    this.exitDeferred = deferred();

    this.child = spawnImpl(command, [...args, ...rpcFlags(command)], {
      cwd: this.cwd,
      env: { ...process.env, ...env },
      shell: false,
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true
    });
    this.child.once("error", () => this.#failTransport("OMP RPC process could not start."));
    this.child.once("exit", (code, signal) => this.#finishExit(code, signal));
    this.child.stdout.on("data", (chunk) => this.#readStdout(chunk));
    this.child.stdout.once("error", () => this.#failTransport("OMP RPC stdout failed."));
    this.child.stderr.on("data", (chunk) => { this.stderrBytes += chunk.length; });
    this.child.stdin.once("error", () => this.#failTransport("OMP RPC stdin failed."));
  }

  async start() {
    try {
      const ready = await this.#waitFor(this.readyDeferred, "OMP RPC did not send a ready frame.");
      if (Array.isArray(ready.supportedProtocolVersions) && ready.supportedProtocolVersions.includes(2)) {
        await this.command("negotiate_protocol", { protocolVersion: 2 });
        this.protocolVersion = 2;
      } else {
        this.protocolVersion = ready.protocolVersion || 1;
      }
      return this;
    } catch (error) {
      try { await this.close({ timeoutMs: 1_000 }); } catch {}
      throw error;
    }
  }

  async command(type, payload = {}, { timeoutMs = this.timeoutMs } = {}) {
    if (this.closed) throw new OmpRpcError("OMP RPC session is closed.", { code: "session_closed", command: type });
    if (typeof type !== "string" || !type) throw new Error("OMP RPC command type is required.");
    assertPositiveInteger(timeoutMs, "OMP RPC command timeoutMs");
    const id = `omp-rpc-${++this.requestNumber}`;
    const result = deferred();
    const timer = timeoutAfter(timeoutMs, () => {
      if (!this.pending.delete(id)) return;
      result.reject(new OmpRpcError(`OMP RPC command ${type} timed out.`, { code: "timeout", command: type, id }));
    });
    this.pending.set(id, { type, result, timer });
    this.#write({ id, type, ...payload });
    const response = await result.promise;
    return { id, ...response };
  }

  async prompt(message, { images, streamingBehavior, timeoutMs = this.timeoutMs } = {}) {
    assertMessage(message, "Prompt");
    this.lastSettled = null;
    const id = `omp-rpc-${this.requestNumber + 1}`;
    const completion = deferred();
    this.promptCompletions.set(id, completion);
    try {
      const accepted = await this.command("prompt", {
        message,
        ...(images ? { images } : {}),
        ...(streamingBehavior ? { streamingBehavior } : {})
      }, { timeoutMs });
      if (accepted.data?.agentInvoked === false) {
        this.promptCompletions.delete(id);
        completion.resolve({ id, agentInvoked: false, status: "completed", sessionSettled: true, source: "response" });
      }
      return { id, accepted, completion: completion.promise };
    } catch (error) {
      this.promptCompletions.delete(id);
      completion.reject(error);
      throw error;
    }
  }

  steer(message, { images, timeoutMs = this.timeoutMs } = {}) {
    assertMessage(message, "Steer message");
    return this.command("steer", { message, ...(images ? { images } : {}) }, { timeoutMs });
  }

  abort({ timeoutMs = this.timeoutMs } = {}) {
    return this.command("abort", {}, { timeoutMs });
  }

  waitForSettled({ timeoutMs = this.timeoutMs } = {}) {
    assertPositiveInteger(timeoutMs, "OMP RPC settled timeoutMs");
    if (this.closed) return Promise.reject(new OmpRpcError("OMP RPC session is closed.", { code: "session_closed" }));
    if (this.lastSettled) return Promise.resolve(this.lastSettled);
    const waiter = deferred();
    const timer = timeoutAfter(timeoutMs, () => {
      this.settledWaiters.delete(waiter);
      waiter.reject(new OmpRpcError("OMP RPC session did not settle in time.", { code: "timeout" }));
    });
    waiter.timer = timer;
    this.settledWaiters.add(waiter);
    return waiter.promise;
  }

  async close({ timeoutMs = this.timeoutMs } = {}) {
    assertPositiveInteger(timeoutMs, "OMP RPC close timeoutMs");
    if (this.closed) return this.exitDeferred.promise;
    this.closeRequested = true;
    this.child.stdin.end();
    const timeout = deferred();
    const timer = timeoutAfter(timeoutMs, () => timeout.resolve());
    const exited = await Promise.race([this.exitDeferred.promise, timeout.promise]);
    clearTimeout(timer);
    if (exited) return exited;
    stopProcessTree(this.child);
    try { return await this.#waitFor(this.exitDeferred, "OMP RPC did not exit after SIGTERM.", 1_000); }
    catch {
      stopProcessTree(this.child, "SIGKILL");
      return this.#waitFor(this.exitDeferred, "OMP RPC did not exit after SIGKILL.", 2_000);
    }
  }

  #waitFor(value, message, timeoutMs = this.timeoutMs) {
    return new Promise((resolve, reject) => {
      const timer = timeoutAfter(timeoutMs, () => reject(new OmpRpcError(message, { code: "timeout" })));
      value.promise.then(
        (result) => { clearTimeout(timer); resolve(result); },
        (error) => { clearTimeout(timer); reject(error); }
      );
    });
  }

  #write(frame) {
    let line;
    try { line = `${JSON.stringify(frame)}\n`; }
    catch { throw new OmpRpcError("OMP RPC command could not be encoded.", { code: "encode_error", command: frame.type, id: frame.id }); }
    if (Buffer.byteLength(line) > this.maxFrameBytes) {
      const pending = this.pending.get(frame.id);
      if (pending) {
        this.pending.delete(frame.id);
        clearTimeout(pending.timer);
        pending.result.reject(new OmpRpcError("OMP RPC command exceeds the configured frame limit.", { code: "frame_too_large", command: frame.type, id: frame.id }));
      }
      return;
    }
    try { this.child.stdin.write(line); }
    catch { this.#failTransport("OMP RPC stdin failed."); }
  }

  #readStdout(chunk) {
    if (this.closed) return;
    if (!Buffer.isBuffer(chunk)) chunk = Buffer.from(chunk);
    let offset = 0;
    while (offset < chunk.length) {
      const newline = chunk.indexOf(0x0a, offset);
      const end = newline < 0 ? chunk.length : newline;
      const part = chunk.subarray(offset, end);
      if (this.stdoutBuffer.length + part.length > this.maxFrameBytes) {
        this.#failTransport("OMP RPC exceeded the configured frame limit.");
        return;
      }
      this.stdoutBuffer = Buffer.concat([this.stdoutBuffer, part]);
      if (newline < 0) return;
      const line = this.stdoutBuffer;
      this.stdoutBuffer = Buffer.alloc(0);
      offset = newline + 1;
      if (!line.length) continue;
      try {
        this.#handleFrame(JSON.parse(line.toString("utf8")));
      } catch (error) {
        if (error instanceof OmpRpcError) this.#failTransport(error.message);
        else this.#failTransport("OMP RPC emitted invalid JSONL.");
        return;
      }
    }
  }

  #handleFrame(frame) {
    if (!frame || typeof frame !== "object" || Array.isArray(frame)) throw new OmpRpcError("OMP RPC emitted an invalid frame.");
    if (frame.type === "rpc_chunk") return this.#handleChunk(frame);
    if (this.chunk) throw new OmpRpcError("OMP RPC interrupted a chunked frame.");
    this.#dispatchFrame(frame);
  }

  #handleChunk(frame) {
    const { chunkId, index, count, byteLength, data } = frame;
    if (typeof chunkId !== "string" || !Number.isSafeInteger(index) || !Number.isSafeInteger(count)
      || !Number.isSafeInteger(byteLength) || typeof data !== "string" || index < 0 || count <= 0 || index >= count
      || byteLength < 0 || byteLength > this.maxReassembledBytes) {
      throw new OmpRpcError("OMP RPC emitted an invalid chunk.");
    }
    if (!this.chunk) {
      if (index !== 0) throw new OmpRpcError("OMP RPC chunk sequence did not start at zero.");
      this.chunk = { chunkId, count, byteLength, parts: [], bytes: 0 };
    }
    if (this.chunk.chunkId !== chunkId || this.chunk.count !== count || index !== this.chunk.parts.length) {
      throw new OmpRpcError("OMP RPC chunk sequence is not contiguous.");
    }
    const part = Buffer.from(data, "base64");
    this.chunk.bytes += part.length;
    if (this.chunk.bytes > this.chunk.byteLength || this.chunk.bytes > this.maxReassembledBytes) {
      throw new OmpRpcError("OMP RPC chunk sequence exceeds its declared size.");
    }
    this.chunk.parts.push(part);
    if (this.chunk.parts.length !== count) return;
    if (this.chunk.bytes !== byteLength) throw new OmpRpcError("OMP RPC chunk sequence has an invalid final size.");
    const completed = this.chunk;
    this.chunk = null;
    let frameValue;
    try { frameValue = JSON.parse(Buffer.concat(completed.parts).toString("utf8")); }
    catch { throw new OmpRpcError("OMP RPC chunk sequence did not decode to JSON."); }
    this.#dispatchFrame(frameValue);
  }

  #dispatchFrame(frame) {
    const event = { version: ADAPTER_EVENT_VERSION, at: new Date().toISOString(), frame };
    this.emit("event", event);
    if (frame.type === "ready") {
      if (!this.readyFrame) {
        this.readyFrame = frame;
        this.readyDeferred.resolve(frame);
      }
      return;
    }
    if (frame.type === "response" && frame.id && this.pending.has(frame.id)) {
      const pending = this.pending.get(frame.id);
      this.pending.delete(frame.id);
      clearTimeout(pending.timer);
      if (frame.success) pending.result.resolve({ data: frame.data, frame });
      else pending.result.reject(new OmpRpcError(`OMP RPC command ${pending.type} failed.`, {
        code: frame.code || "command_failed", command: pending.type, id: frame.id
      }));
      return;
    }
    if (frame.type === "prompt_result" && frame.id && this.promptCompletions.has(frame.id)) {
      const completion = this.promptCompletions.get(frame.id);
      this.promptCompletions.delete(frame.id);
      completion.resolve(frame);
      this.emit("prompt_result", event);
      return;
    }
    if (frame.type === "session_settled") {
      this.lastSettled = frame;
      for (const waiter of this.settledWaiters) {
        clearTimeout(waiter.timer);
        waiter.resolve(frame);
      }
      this.settledWaiters.clear();
      this.emit("session_settled", event);
    }
  }

  #finishExit(code, signal) {
    if (this.closed) return;
    this.closed = true;
    const result = { code, signal };
    this.exitDeferred.resolve(result);
    const error = new OmpRpcError("OMP RPC session closed before the requested operation completed.", { code: "session_closed" });
    if (!this.readyFrame) this.readyDeferred.reject(error);
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.result.reject(error);
    }
    this.pending.clear();
    for (const completion of this.promptCompletions.values()) completion.reject(error);
    this.promptCompletions.clear();
    for (const waiter of this.settledWaiters) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    this.settledWaiters.clear();
    this.emit("closed", { version: ADAPTER_EVENT_VERSION, at: new Date().toISOString(), ...result });
  }

  #failTransport(message) {
    if (this.closed) return;
    this.emit("transport_error", { version: ADAPTER_EVENT_VERSION, at: new Date().toISOString(), message });
    stopProcessTree(this.child);
    const hardKill = setTimeout(() => {
      if (this.child.exitCode === null) stopProcessTree(this.child, "SIGKILL");
    }, 1_000);
    hardKill.unref?.();
    this.#finishExit(null, "transport_error");
  }
}

export async function startOmpRpc(options) {
  const client = new OmpRpcClient(options);
  return client.start();
}
