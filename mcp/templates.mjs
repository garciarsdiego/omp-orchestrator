const templates = {
  "multi-model-build-review": {
    id: "multi-model-build-review",
    description: "Parallel planning and design, artifact generation, deterministic validation, and Codex attestation.",
    nodes: [
      { id: "plan", type: "inference", role: "plan", contract: "notes", maxOutputTokens: 2500, estimatedInputTokens: 1500 },
      { id: "design", type: "inference", role: "designer", contract: "notes", maxOutputTokens: 2500, estimatedInputTokens: 1500, fallbackRole: "plan" },
      { id: "candidate", type: "inference", role: "default", contract: "standalone_html", maxOutputTokens: 19500, estimatedInputTokens: 8000, dependsOn: ["plan", "design"], fallbackRole: "designer" },
      { id: "validate", type: "validator", dependsOn: ["candidate"] },
      { id: "codex", type: "attestation", dependsOn: ["validate"] },
      { id: "finalize", type: "inference", role: "default", contract: "standalone_html", maxOutputTokens: 19500, estimatedInputTokens: 14000, conditional: true, dependsOn: ["codex"] }
    ],
    defaultBudget: {
      maxCalls: 5,
      maxTotalTokens: 70000,
      maxDurationMs: 1200000,
      costPolicy: "observe",
      maxApiEquivalentUsd: 0.8
    }
  },
  "single-file-web-app": {
    id: "single-file-web-app",
    extends: "multi-model-build-review",
    description: "Offline single-file HTML generation with JavaScript and browser-oriented validation.",
    outputContract: "standalone_html"
  },
  "independent-analysis": {
    id: "independent-analysis",
    description: "Two independent analytical notes for Codex reconciliation.",
    nodes: [
      { id: "analysis-a", type: "inference", role: "plan", contract: "notes", maxOutputTokens: 3000, estimatedInputTokens: 2000 },
      { id: "analysis-b", type: "inference", role: "advisor", contract: "notes", maxOutputTokens: 3000, estimatedInputTokens: 2000 },
      { id: "codex", type: "attestation", dependsOn: ["analysis-a", "analysis-b"] }
    ],
    defaultBudget: {
      maxCalls: 2,
      maxTotalTokens: 20000,
      maxDurationMs: 900000,
      costPolicy: "observe",
      maxApiEquivalentUsd: 0.5
    }
  }
};

export function getTemplate(id) {
  const template = templates[id];
  if (!template) throw new Error(`Unknown pipeline template: ${id}`);
  if (template.extends) {
    const parent = templates[template.extends];
    return structuredClone({ ...parent, ...template, nodes: parent.nodes });
  }
  return structuredClone(template);
}

export function listTemplates() {
  return Object.values(templates).map(({ nodes, ...template }) => ({
    ...template,
    nodeCount: nodes?.length || templates[template.extends]?.nodes.length || 0
  }));
}
