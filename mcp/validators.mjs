import { spawnSync } from "node:child_process";
import { validateOutput } from "./gateway.mjs";

export function validateStandaloneHtml(html) {
  const contract = validateOutput(html, "standalone_html");
  const errors = [...contract.errors];
  const warnings = [];
  const checks = { contract: contract.valid, javascriptSyntax: null, uniqueIds: false, accessibility: false };

  const scripts = [...String(html).matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)].map((match) => match[1]);
  if (scripts.length) {
    const syntax = spawnSync(process.execPath, ["--check", "-"], {
      input: scripts.join("\n"),
      encoding: "utf8",
      windowsHide: true,
      timeout: 10_000
    });
    if (syntax.status !== 0) errors.push(`JavaScript syntax check failed: ${(syntax.stderr || syntax.stdout || "unknown error").trim()}`);
    else checks.javascriptSyntax = true;
  }

  const ids = [...String(html).matchAll(/\sid=["']([^"']+)["']/gi)].map((match) => match[1]);
  const duplicates = [...new Set(ids.filter((id, index) => ids.indexOf(id) !== index))];
  if (duplicates.length) errors.push(`Duplicate HTML ids: ${duplicates.join(", ")}`);
  else checks.uniqueIds = true;

  if (!/<canvas\b/i.test(html)) warnings.push("No canvas element found.");
  if (!/addEventListener\s*\(\s*["']keydown["']/i.test(html)) warnings.push("No keyboard handler detected.");
  if (!/aria-label=|role=|<button\b/i.test(html)) warnings.push("No basic accessibility markers detected.");
  else checks.accessibility = true;

  return { valid: errors.length === 0, errors, warnings, checks };
}
