const $ = (id) => document.getElementById(id);
let token = "";
let tools = [];
let refreshTimer;

function message(text, error = false) {
  $("message").textContent = text;
  $("message").classList.toggle("error", error);
}

async function request(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { authorization: `Bearer ${token}`, ...(options.body ? { "content-type": "application/json" } : {}) }
  });
  let payload;
  try { payload = await response.json(); } catch { throw new Error(`HTTP ${response.status}`); }
  if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
  return payload;
}

async function call(name, args = {}) {
  return (await request("/api/call", {
    method: "POST", body: JSON.stringify({ name, arguments: args })
  })).result;
}

function shortId(id) { return String(id || "").slice(0, 12); }
function display(value, label) {
  $("inspection-label").textContent = label;
  $("inspection-output").textContent = typeof value === "string" ? value : JSON.stringify(value, null, 2);
}

function record(item, type) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "record";
  const left = document.createElement("span");
  const id = document.createElement("span");
  id.className = "record-id";
  id.textContent = shortId(item.id);
  id.title = item.id;
  const meta = document.createElement("span");
  meta.className = "record-meta";
  meta.textContent = type === "run" ? (item.template || "Run") : type === "agent"
    ? `${item.backend} · ${item.workspace}` : (item.request?.selector || item.selector || "Job");
  left.append(id, meta);
  const badge = document.createElement("span");
  badge.className = `badge ${String(item.status || "").replace(/[^a-z_]/g, "")}`;
  badge.textContent = item.status || "—";
  button.append(left, badge);
  button.addEventListener("click", async () => {
    try {
      const result = await call(type === "run" ? "omp_run_get" : type === "agent" ? "omp_agent_get" : "omp_job_get", { id: item.id });
      display(result, `${type === "run" ? "Run" : type === "agent" ? "Agente" : "Job"} ${item.id}`);
      if (type === "agent") {
        const recent = await call("omp_agent_events", { id: item.id, limit: 100 });
        const completed = result.status === "succeeded" ? await call("omp_agent_result", { id: item.id }) : null;
        display({ job: result, events: recent.events, output: completed?.output ?? null }, `Agente ${item.id}`);
        if (["queued", "running", "cancellation_requested"].includes(result.status)) {
          $("tool-name").value = "omp_agent_abort";
          $("tool-args").value = JSON.stringify({ id: item.id, confirm: true }, null, 2);
        }
      }
      const artifact = type === "run" && result.artifacts?.at(-1);
      if (artifact?.name) {
        const content = await call("omp_run_artifact", { id: item.id, name: artifact.name });
        display(content.body, `Artefato ${artifact.name} · ${item.id} · SHA-256 ${artifact.sha256 || "indisponível"}`);
        if (["awaiting_codex", "awaiting_review"].includes(result.status) && artifact.sha256) {
          $("tool-name").value = "omp_run_attest";
          $("tool-args").value = JSON.stringify({
            id: item.id, verdict: "accept", findings: [], expectedArtifactSha256: artifact.sha256
          }, null, 2);
          message("Artefato carregado como texto. Revise-o antes de executar a operação preparada.");
        }
      }
    } catch (error) { message(error.message, true); }
  });
  return button;
}

function renderList(id, countId, items, type) {
  $(countId).textContent = String(items.length);
  const elements = items.map((item) => record(item, type));
  if (!elements.length) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = type === "run" ? "Nenhuma run encontrada."
      : type === "agent" ? "Nenhum agente executado." : "Nenhum job encontrado.";
    elements.push(empty);
  }
  $(id).replaceChildren(...elements);
}

async function refresh() {
  const { runs = [], jobs = [], agents = [] } = await request("/api/overview");
  const inferenceJobs = jobs.filter((job) => !String(job.selector || "").startsWith("agent/"));
  $("metric-runs").textContent = String(runs.length);
  $("metric-review").textContent = String(runs.filter((run) => ["awaiting_codex", "awaiting_review"].includes(run.status)).length);
  $("metric-active").textContent = String([...inferenceJobs, ...agents].filter((job) => ["queued", "running"].includes(job.status)).length);
  $("metric-failed").textContent = String([...runs, ...inferenceJobs, ...agents].filter((entry) => ["failed", "invalid", "budget_exceeded", "limit_exceeded", "interrupted"].includes(entry.status)).length);
  renderList("runs-list", "runs-count", runs, "run");
  renderList("jobs-list", "jobs-count", inferenceJobs, "job");
  renderList("agents-list", "agents-count", agents, "agent");
}

async function connect(raw) {
  token = raw;
  try {
    await refresh();
    tools = (await request("/api/tools")).tools;
    const backends = await call("omp_agent_backends");
    $("agent-backend").replaceChildren(...backends.map((backend) => {
      const option = document.createElement("option");
      const profile = backend.profile ? ` · ${backend.profile}` : "";
      const usage = backend.capabilities?.usageReported === true ? "" : " · sem uso";
      option.value = backend.id;
      option.textContent = `${backend.id} · ${backend.type}${profile}${usage}`;
      option.title = backend.capabilities?.cacheBehavior || "";
      return option;
    }));
    $("tool-name").replaceChildren(...tools.map((tool) => {
      const option = document.createElement("option");
      option.value = tool.name;
      option.textContent = tool.name;
      return option;
    }));
    $("token").value = "";
    $("auth-panel").hidden = true;
    $("workspace").hidden = false;
    $("disconnect").hidden = false;
    $("refresh").disabled = false;
    $("connection").textContent = "Conectado";
    $("connection").classList.add("online");
    message("Conexão autenticada.");
    clearInterval(refreshTimer);
    refreshTimer = setInterval(() => { void refresh().catch((error) => message(error.message, true)); }, 10_000);
  } catch (error) {
    token = "";
    message(error.message, true);
  }
}

$("auth-form").addEventListener("submit", (event) => {
  event.preventDefault();
  void connect($("token").value.trim());
});
$("disconnect").addEventListener("click", () => {
  clearInterval(refreshTimer);
  token = "";
  tools = [];
  $("auth-panel").hidden = false;
  $("workspace").hidden = true;
  $("disconnect").hidden = true;
  $("refresh").disabled = true;
  $("connection").textContent = "Desconectado";
  $("connection").classList.remove("online");
  display("Nenhum item selecionado.", "Selecione uma run ou job para ver seus detalhes.");
  message("Sessão encerrada nesta aba.");
});
$("refresh").addEventListener("click", () => void refresh().catch((error) => message(error.message, true)));
$("doctor").addEventListener("click", async () => {
  try { display(await call("omp_doctor"), "Diagnóstico OMP"); }
  catch (error) { message(error.message, true); }
});
$("tool-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const name = $("tool-name").value;
  try {
    const args = JSON.parse($("tool-args").value);
    const result = await call(name, args);
    display(result, `Operação ${name}`);
    message(`${name} concluída.`);
    await refresh();
  } catch (error) { message(error.message, true); }
});
$("agent-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!window.confirm("Executar o agente no workspace selecionado? Ele pode usar ferramentas e quota até o limite de tempo.")) return;
  try {
    const result = await call("omp_agent_create", {
      backend: $("agent-backend").value,
      workspace: $("agent-workspace").value.trim(),
      prompt: $("agent-prompt").value,
      timeoutMs: 600_000,
      idempotencyKey: crypto.randomUUID(),
      confirmQuota: true
    });
    display(result, `Agente criado · ${result.id}`);
    message(`Agente ${shortId(result.id)} criado.`);
    $("agent-prompt").value = "";
    await refresh();
  } catch (error) { message(error.message, true); }
});
