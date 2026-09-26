// Read-only product probes. State is isolated in an audit-owned temporary directory.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateStandaloneHtml } from '../../mcp/validators.mjs';
import { routingCompatibility } from '../../mcp/run-manager.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const state = mkdtempSync(path.join(os.tmpdir(), 'omp-audit-interfaces-'));
const env = { ...process.env, OMP_ORCHESTRATOR_STATE_DIR: state };
function rpc(lines) {
  const run = spawnSync(process.execPath, ['mcp/server.mjs'], {
    cwd: root, env, input: lines.join('\n') + '\n', encoding: 'utf8',
    windowsHide: true, timeout: 10_000,
  });
  return { exitCode: run.status, stdout: run.stdout.trim(), stderr: run.stderr.trim() };
}
const request = (id, method, params = {}) => JSON.stringify({jsonrpc:'2.0',id,method,params});
const protocolRun = rpc([
  request(1, 'initialize', {protocolVersion:'1900-01-01'}),
  request(2, 'server/discover', {_meta:{'io.modelcontextprotocol/protocolVersion':'2026-07-28'}}),
  request(3, 'tools/call', {name:'omp_pipeline_templates',arguments:{}}),
  request(4, 'tools/call', {name:'omp_job_create',arguments:{confirmQuota:'false'}}),
  request(5, 'tools/call', {name:'omp_routing_policy',arguments:{undeclaredArgument:true}}),
]);
const responses = protocolRun.stdout.split(/\r?\n/).filter(Boolean).map(JSON.parse);
const externalScript = '<!DOCTYPE html><html><body><button>Go</button><script src="//example.invalid/app.js"></script><script>let x=1;</script></body></html>';
const staticHtml = '<!DOCTYPE html><html><body><h1>Static report</h1></body></html>';
const report = {
  checkedAt:new Date().toISOString(), node:process.version, stateRoot:state,
  protocol:{exitCode:protocolRun.exitCode, responses:responses.map(r=>r.id===3
    ? {id:r.id,structuredContentType:Array.isArray(r.result?.structuredContent)?'array':typeof r.result?.structuredContent,isError:r.result?.isError}
    :r)},
  nullMessage:rpc(['null',request(99,'ping')]),
  html:{protocolRelativeDependency:validateStandaloneHtml(externalScript),staticDocument:validateStandaloneHtml(staticHtml)},
  quarantine:{bare:routingCompatibility('xai-oauth/grok-composer-2.5-fast','standalone_html'),withEffort:routingCompatibility('xai-oauth/grok-composer-2.5-fast:high','standalone_html')},
};
writeFileSync(path.join(here,'interface-probes.json'),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify(report,null,2));
