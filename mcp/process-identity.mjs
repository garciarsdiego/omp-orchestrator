import { readFileSync } from "node:fs";

// A PID alone does not identify a process: numbers are reused, and a restarted
// container recreates the same low PIDs within seconds. On Linux a process is
// identified by the kernel boot plus its start time in clock ticks. Other
// platforms (and records written before identities existed) fall back to the
// PID-only liveness check.

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

function pidExists(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/** Returns an opaque identity for a live PID, or null when unavailable. */
export function processIdentity(pid) {
  if (process.platform !== "linux" || !Number.isInteger(pid) || pid <= 0) return null;
  const boot = linuxBootId();
  const start = linuxStartTime(pid);
  return boot && start ? `linux:${boot}:${pid}:${start}` : null;
}

/** Fields to persist whenever a worker PID is recorded. */
export function workerProcess(pid) {
  return { workerPid: pid, workerIdentity: processIdentity(pid) };
}

function identityMismatch(pid, identity) {
  if (typeof identity !== "string" || !identity.startsWith("linux:")) return false;
  const parts = identity.split(":");
  if (parts.length !== 4 || Number(parts[2]) !== pid) return false;
  const current = processIdentity(pid);
  // Unreadable /proc entry for a PID that just answered: no evidence of reuse;
  // the next reconciliation tick re-checks.
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
