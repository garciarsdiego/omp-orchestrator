import { execFileSync } from "node:child_process";
import http from "node:http";
import { ompExecutable } from "./lib.mjs";

const EFFORTS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"]);

export function parseRoleSelector(selector) {
  const slash = String(selector).indexOf("/");
  if (slash <= 0 || slash === selector.length - 1) throw new Error(`Invalid OMP selector: ${selector}`);
  const provider = selector.slice(0, slash);
  let model = selector.slice(slash + 1);
  let reasoning = null;
  const colon = model.lastIndexOf(":");
  if (colon > 0 && EFFORTS.has(model.slice(colon + 1))) {
    reasoning = model.slice(colon + 1);
    model = model.slice(0, colon);
  }
  return { provider, model, reasoning };
}

export function extractResponseText(payload) {
  if (typeof payload.output_text === "string") return payload.output_text;
  const chunks = [];
  for (const item of payload.output || []) {
    for (const content of item.content || []) {
      if (typeof content.text === "string") chunks.push(content.text);
      else if (typeof content.output_text === "string") chunks.push(content.output_text);
    }
  }
  return chunks.join("\n");
}

export function validateOutput(output, contract = "text") {
  const text = String(output || "").trim();
  if (!text) return { valid: false, contract, errors: ["Output is empty."] };
  if (contract === "text") return { valid: true, contract, errors: [] };
  if (contract === "notes") {
    const errors = [];
    if (Buffer.byteLength(text) > 24_000) errors.push("Notes exceed the 24 KB contract limit.");
    if (/<!DOCTYPE html>|<html[\s>]/i.test(text)) errors.push("Notes must not contain a complete HTML document.");
    if ((text.match(/```/g) || []).length >= 2 && Buffer.byteLength(text) > 8_000) {
      errors.push("Notes contain an oversized fenced artifact.");
    }
    return { valid: errors.length === 0, contract, errors };
  }
  if (contract === "json") {
    try {
      JSON.parse(text);
      return { valid: true, contract, errors: [] };
    } catch {
      return { valid: false, contract, errors: ["Output is not valid JSON."] };
    }
  }
  if (contract === "html" || contract === "standalone_html") {
    const errors = [];
    if (!/^<!DOCTYPE html>/i.test(text)) errors.push("Output must start with <!DOCTYPE html>.");
    if (!/<\/html>$/i.test(text)) errors.push("Output must end with </html>.");
    if (/^```|```$/m.test(text)) errors.push("Output must not contain Markdown fences.");
    if (contract === "standalone_html" && /https?:\/\//i.test(text)) errors.push("Offline HTML must not contain external HTTP URLs.");
    return { valid: errors.length === 0, contract, errors };
  }
  if (contract === "review_json") {
    try {
      const parsed = JSON.parse(text);
      const validVerdict = ["accept", "revise", "reject"].includes(parsed.verdict);
      const validFindings = Array.isArray(parsed.findings);
      const errors = [];
      if (!validVerdict) errors.push("Review verdict must be accept, revise, or reject.");
      if (!validFindings) errors.push("Review findings must be an array.");
      return { valid: errors.length === 0, contract, errors };
    } catch {
      return { valid: false, contract, errors: ["Review output is not valid JSON."] };
    }
  }
  throw new Error(`Unsupported output contract: ${contract}`);
}

export function normalizeOutput(output, contract) {
  const original = String(output || "");
  const trimmed = original.trim();
  if (["html", "standalone_html"].includes(contract)) {
    const match = trimmed.match(/^```(?:html)?\s*\r?\n([\s\S]*?)\r?\n```$/i);
    if (match) {
      const candidate = match[1].trim();
      const validation = validateOutput(candidate, contract);
      if (validation.valid) {
        return { output: candidate, changed: true, transformation: "strip_outer_markdown_fence", validation };
      }
    }
  }
  if (["json", "review_json"].includes(contract)) {
    const match = trimmed.match(/^```(?:json)?\s*\r?\n([\s\S]*?)\r?\n```$/i);
    if (match) {
      const candidate = match[1].trim();
      const validation = validateOutput(candidate, contract);
      if (validation.valid) {
        return { output: candidate, changed: true, transformation: "strip_outer_markdown_fence", validation };
      }
    }
  }
  return { output: original, changed: false, transformation: null, validation: validateOutput(original, contract) };
}

export function buildInferenceBody({ model, prompt, reasoning, maxOutputTokens, cacheKey }) {
  const body = {
    model,
    input: prompt,
    max_output_tokens: maxOutputTokens,
    stream: false,
    prompt_cache_key: cacheKey
  };
  if (reasoning && reasoning !== "off") body.reasoning = { effort: reasoning };
  return body;
}

export function gatewayToken() {
  const raw = execFileSync(ompExecutable(), ["auth-gateway", "token", "--json"], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 10_000
  });
  const token = JSON.parse(raw).token;
  if (!token) throw new Error("OMP gateway token is unavailable.");
  return token;
}

export function requestInference({
  model, prompt, reasoning, maxOutputTokens, cacheKey, timeoutMs = 720_000, shouldCancel
}) {
  if (!cacheKey) throw new Error("A unique prompt cache key is required for session isolation.");
  const body = buildInferenceBody({ model, prompt, reasoning, maxOutputTokens, cacheKey });
  const serialized = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    let cancellationTimer;
    const request = http.request("http://127.0.0.1:4000/v1/responses", {
      method: "POST",
      headers: {
        authorization: `Bearer ${gatewayToken()}`,
        "content-type": "application/json",
        "content-length": Buffer.byteLength(serialized)
      }
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        if (response.statusCode < 200 || response.statusCode >= 300) {
          reject(new Error(`Gateway returned HTTP ${response.statusCode}: ${raw.slice(0, 1000)}`));
          return;
        }
        try { resolve(JSON.parse(raw)); }
        catch { reject(new Error("Gateway returned invalid JSON.")); }
      });
    });
    const clearCancellationTimer = () => {
      if (cancellationTimer) clearInterval(cancellationTimer);
    };
    request.once("close", clearCancellationTimer);
    if (shouldCancel) {
      cancellationTimer = setInterval(() => {
        try {
          if (shouldCancel()) {
            const error = new Error("Inference cancelled by operator.");
            error.name = "CancellationError";
            request.destroy(error);
          }
        } catch {}
      }, 250);
      cancellationTimer.unref?.();
    }
    request.setTimeout(timeoutMs, () => request.destroy(new Error(`Inference timed out after ${timeoutMs}ms.`)));
    request.on("error", reject);
    request.end(serialized);
  });
}
