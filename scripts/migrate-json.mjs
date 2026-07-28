import os from "node:os";
import path from "node:path";
import { migrateLegacyJson } from "../mcp/migration.mjs";

const apply = process.argv.includes("--apply");
const legacyRoot = process.env.OMP_ORCHESTRATOR_LEGACY_ROOT
  || path.join(os.tmpdir(), "omp-orchestrator");
const result = migrateLegacyJson({
  jobsDir: path.join(legacyRoot, "jobs"),
  runsDir: path.join(legacyRoot, "runs"),
  apply
});
console.log(JSON.stringify(result, null, 2));
if (result.errors.length) process.exitCode = 1;
