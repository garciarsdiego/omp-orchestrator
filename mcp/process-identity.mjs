import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

// A PID alone does not identify a process: numbers are reused, and a restarted
// container recreates the same low PIDs within seconds. A process is
// identified by its PID plus its start time:
//   linux:<boot_id>:<pid>:<starttime clock ticks>   (from /proc)
//   win32:<pid>:<start FILETIME UTC>                (from Get-Process)
// Other platforms, processes whose start time cannot be read (another user,
// system processes) and records written before identities existed fall back
// to the PID-only liveness check.

let bootId;

function linuxBootId() {
  if (bootId === undefined) {
    try { bootId = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim() || null; }
    catch { bootId = null; }
  }
  return bootId;
}

function linuxStartTime(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    // The command name (field 2) may contain spaces and parentheses; fields
    // after the last ")" start at field 3, so starttime (field 22) is index 19.
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    return /^\d+$/.test(fields[19] || "") ? fields[19] : null;
  } catch {
    return null;
  }
}

// Node has no API for a process start time on Windows. One PowerShell call
// costs ~200 ms, so answers are cached briefly: runtime status asks for two
// PIDs per call, and a reuse within one second of a check is not a concern.
const WINDOWS_CACHE_MS = 1_000;
const windowsCache = new Map();

function windowsStartTime(pid) {
  const cached = windowsCache.get(pid);
  if (cached && Date.now() - cached.at < WINDOWS_CACHE_MS) return cached.value;
  let value = null;
  try {
    const result = spawnSync("powershell.exe", [
      "-NoProfile", "-NonInteractive", "-Command",
      `try { (Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToFileTimeUtc() } catch { '' }`
    ], { encoding: "utf8", timeout: 5_000, windowsHide: true });
    const text = (result.stdout || "").trim();
    value = /^\d+$/.test(text) ? text : null;
  } catch {
    value = null;
  }
  windowsCache.set(pid, { at: Date.now(), value });
  return value;
}

function pidExists(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/** Returns an opaque identity for a live PID, or null when unavailable. */
export function processIdentity(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  if (process.platform === "linux") {
    const boot = linuxBootId();
    const start = linuxStartTime(pid);
    return boot && start ? `linux:${boot}:${pid}:${start}` : null;
  }
  if (process.platform === "win32") {
    const start = windowsStartTime(pid);
    return start ? `win32:${pid}:${start}` : null;
  }
  return null;
}

/** Fields to persist whenever a worker PID is recorded. */
export function workerProcess(pid) {
  return { workerPid: pid, workerIdentity: processIdentity(pid) };
}

function recordedPid(identity) {
  if (typeof identity !== "string") return null;
  const parts = identity.split(":");
  if (parts[0] === "linux" && parts.length === 4) return Number(parts[2]);
  if (parts[0] === "win32" && parts.length === 3) return Number(parts[1]);
  return null;
}

function identityMismatch(pid, identity) {
  if (recordedPid(identity) !== pid) return false;
  const current = processIdentity(pid);
  // Unreadable start time for a PID that just answered: no evidence of reuse;
  // the next reconciliation re-checks.
  return current !== null && current !== identity;
}

/**
 * True when `pid` exists but provably belongs to a different process than the
 * recorded identity (PID reuse). Never signal such a PID or its group.
 */
export function processReused(pid, identity) {
  return pidExists(pid) && identityMismatch(pid, identity);
}

/**
 * True when `pid` is alive and, if a matching identity was recorded, is still
 * the same process. An identity recorded for a different PID is ignored.
 */
export function processAlive(pid, identity) {
  return pidExists(pid) && !identityMismatch(pid, identity);
}
