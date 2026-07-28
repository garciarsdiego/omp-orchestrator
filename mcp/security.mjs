const SECRET_PATTERNS = [
  { name: "authorization-header", pattern: /\bauthorization\s*:\s*(?:bearer|basic)\s+\S+/i },
  { name: "openai-style-key", pattern: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/ },
  { name: "github-token", pattern: /\bgh[opusr]_[A-Za-z0-9]{30,}\b/ },
  { name: "slack-token", pattern: /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/ },
  { name: "private-key", pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/ }
];

export function scanForSecrets(value) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return SECRET_PATTERNS
    .filter(({ pattern }) => pattern.test(text))
    .map(({ name }) => name);
}

export function assertNoSecrets(value, label = "Persisted content") {
  const matches = scanForSecrets(value);
  if (matches.length) {
    throw new Error(`${label} contains blocked secret patterns: ${matches.join(", ")}.`);
  }
}
