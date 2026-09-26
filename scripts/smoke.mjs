import { doctor, getModels, getRoles, getStatus } from "../mcp/lib.mjs";

const status = getStatus();
const roles = getRoles();
const models = getModels({ limit: 2 });
const report = doctor();

if (!status.version || !status.configPath) throw new Error("OMP status is incomplete");
// Smoke proves that the public metadata commands work. A user's configured
// roles or credentials can be unavailable without breaking the installation.
console.log(JSON.stringify({
  status,
  roleCount: Object.keys(roles).length,
  modelCount: models.totalAvailable,
  allConfiguredRolesResolved: report.ok,
  unresolvedRoles: report.unresolvedRoles
}, null, 2));
