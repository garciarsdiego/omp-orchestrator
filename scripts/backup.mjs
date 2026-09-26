#!/usr/bin/env node
import { createHash, randomUUID } from "node:crypto";
import {
  copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync
} from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import Database from "better-sqlite3";
import { CAS_ROOT, DATABASE_PATH, getDatabase } from "../mcp/storage.mjs";

const FORMAT = "omp-orchestrator-backup-v1";

function timestamp() { return new Date().toISOString().replace(/[:.]/g, "-"); }
function checksum(filename) { return createHash("sha256").update(readFileSync(filename)).digest("hex"); }
function objectRelativePath(sha256) { return path.join("objects", "sha256", sha256.slice(0, 2), sha256.slice(2, 4), sha256); }

function assertHash(sha256) {
  if (!/^[a-f0-9]{64}$/i.test(sha256)) throw new Error("Invalid artifact SHA-256 in backup source.");
}

function assertOutputDirectory(outputDir) {
  const absolute = path.resolve(outputDir);
  if (absolute === path.dirname(path.resolve(DATABASE_PATH))) {
    throw new Error("Backup output must not be the live database directory.");
  }
  mkdirSync(absolute, { recursive: true, mode: 0o700 });
  return absolute;
}

function referencedArtifacts(snapshot) {
  const db = new Database(snapshot, { readonly: true });
  try {
    return db.prepare("SELECT sha256, bytes, object_path AS objectPath FROM artifacts ORDER BY sha256").all();
  } finally {
    db.close();
  }
}

function copyObject({ sha256, bytes, objectPath }, packageDir) {
  assertHash(sha256);
  const expectedRoot = path.resolve(CAS_ROOT);
  const source = path.resolve(objectPath);
  if (source !== expectedRoot && !source.startsWith(`${expectedRoot}${path.sep}`)) {
    throw new Error(`Artifact ${sha256} is outside the configured CAS root.`);
  }
  if (!existsSync(source)) throw new Error(`Artifact ${sha256} is missing from the CAS.`);
  const relativePath = objectRelativePath(sha256);
  const destination = path.join(packageDir, relativePath);
  mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
  copyFileSync(source, destination);
  if (Buffer.byteLength(readFileSync(destination)) !== bytes || checksum(destination) !== sha256) {
    throw new Error(`Artifact ${sha256} failed backup verification.`);
  }
  return { sha256, bytes, file: relativePath.split(path.sep).join("/") };
}

function verifyPackage(packageDir, manifest) {
  if (!manifest || manifest.format !== FORMAT || !manifest.database || !Array.isArray(manifest.objects)) {
    throw new Error("Backup manifest is invalid.");
  }
  const verify = (entry) => {
    if (typeof entry?.file !== "string" || entry.file.includes("..") || path.isAbsolute(entry.file)) {
      throw new Error("Backup manifest contains an unsafe file path.");
    }
    const filename = path.join(packageDir, entry.file);
    if (!existsSync(filename) || checksum(filename) !== entry.sha256) throw new Error(`Backup hash verification failed: ${entry.file}`);
    return filename;
  };
  const database = verify(manifest.database);
  const objects = manifest.objects.map((entry) => ({ entry, filename: verify(entry) }));
  return { database, objects };
}

/** Creates a SQLite online snapshot plus all CAS objects referenced by its metadata. */
export async function backupDatabase({ outputDir } = {}) {
  if (!outputDir) throw new Error("outputDir is required.");
  const destinationDir = assertOutputDirectory(outputDir);
  const packageDir = path.join(destinationDir, `omp-orchestrator-${timestamp()}-${randomUUID().slice(0, 8)}`);
  const partial = `${packageDir}.partial`;
  const snapshot = path.join(partial, "orchestrator.sqlite");
  if (existsSync(partial)) rmSync(partial, { recursive: true, force: true });
  try {
    mkdirSync(partial, { recursive: true, mode: 0o700 });
    // This uses SQLite's online backup API; it never copies live WAL/SHM files.
    await getDatabase().backup(snapshot);
    const verification = new Database(snapshot, { readonly: true });
    try {
      const integrity = verification.pragma("integrity_check", { simple: true });
      if (integrity !== "ok") throw new Error(`Backup integrity check failed: ${integrity}`);
    } finally {
      verification.close();
    }
    const objects = referencedArtifacts(snapshot).map((artifact) => copyObject(artifact, partial));
    const manifest = {
      format: FORMAT,
      createdAt: new Date().toISOString(),
      source: { database: DATABASE_PATH, casRoot: CAS_ROOT },
      database: { file: "orchestrator.sqlite", sha256: checksum(snapshot) },
      objects
    };
    writeFileSync(path.join(partial, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
    renameSync(partial, packageDir);
    return { package: packageDir, manifest: path.join(packageDir, "manifest.json"), database: path.join(packageDir, "orchestrator.sqlite"), objects: objects.length };
  } catch (error) {
    rmSync(partial, { recursive: true, force: true });
    throw error;
  }
}

/** Restores a verified package to a previously non-existent state directory. */
export function restorePackage({ packageDir, stateDir, runtimeStateDir = stateDir } = {}) {
  if (!packageDir || !stateDir) throw new Error("packageDir and stateDir are required.");
  const source = path.resolve(packageDir);
  const target = path.resolve(stateDir);
  const runtimeState = path.resolve(runtimeStateDir);
  if (existsSync(target)) throw new Error("Restore state directory must not already exist.");
  const manifest = JSON.parse(readFileSync(path.join(source, "manifest.json"), "utf8"));
  const verified = verifyPackage(source, manifest);
  const partial = `${target}.partial`;
  if (existsSync(partial)) rmSync(partial, { recursive: true, force: true });
  try {
    mkdirSync(partial, { recursive: true, mode: 0o700 });
    const databasePath = path.join(partial, "orchestrator.sqlite");
    copyFileSync(verified.database, databasePath);
    for (const { entry, filename } of verified.objects) {
      const destination = path.join(partial, entry.file);
      mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
      copyFileSync(filename, destination);
    }
    // Store final paths before the directory rename, so a failure still leaves
    // no partially restored target visible to an operator.
    const restored = new Database(databasePath);
    try {
      restored.transaction(() => {
        const update = restored.prepare("UPDATE artifacts SET object_path = ? WHERE sha256 = ?");
        for (const object of manifest.objects) {
          assertHash(object.sha256);
          update.run(path.join(runtimeState, object.file), object.sha256);
        }
      })();
      if (restored.pragma("integrity_check", { simple: true }) !== "ok") throw new Error("Restored database integrity check failed.");
      restored.pragma("journal_mode = DELETE");
    } finally {
      restored.close();
    }
    renameSync(partial, target);
    return {
      stateDir: target, runtimeStateDir: runtimeState,
      database: path.join(target, "orchestrator.sqlite"), objects: manifest.objects.length
    };
  } catch (error) {
    rmSync(partial, { recursive: true, force: true });
    throw error;
  }
}

export async function main(args = process.argv.slice(2)) {
  if (args.length === 2 && args[0] === "--output") {
    if (!path.isAbsolute(args[1])) throw new Error("Backup output directory must be absolute.");
    process.stdout.write(`${JSON.stringify(await backupDatabase({ outputDir: args[1] }))}\n`);
    return;
  }
  if ((args.length === 4 || args.length === 6) && args[0] === "--restore" && args[2] === "--state") {
    if (args.length === 6 && args[4] !== "--runtime-state") throw new Error("Expected --runtime-state after restore state.");
    const runtimeStateDir = args.length === 6 ? args[5] : args[3];
    if (![args[1], args[3], runtimeStateDir].every(path.isAbsolute)) throw new Error("Restore paths must be absolute.");
    process.stdout.write(`${JSON.stringify(restorePackage({ packageDir: args[1], stateDir: args[3], runtimeStateDir }))}\n`);
    return;
  }
  throw new Error("Usage: backup.mjs --output <absolute-directory> | --restore <package-directory> --state <new-absolute-directory> [--runtime-state <absolute-directory>]");
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
