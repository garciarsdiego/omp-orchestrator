import { doctor, getModels, getRoles, getStatus } from "../mcp/lib.mjs";

const status = getStatus();
const roles = getRoles();
const models = getModels({ limit: 2 });
const report = doctor();

if (!status.version || !status.configPath) throw new Error("OMP status is incomplete");
if (!Object.keys(roles).length) throw new Error("No OMP model roles were found");
if (!models.totalAvailable) throw new Error("OMP model catalog is empty");
if (!report.ok) throw new Error("OMP doctor failed");

console.log(JSON.stringify({ status, roleCount: Object.keys(roles).length, modelCount: models.totalAvailable }, null, 2));
