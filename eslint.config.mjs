import globals from "globals";

// Correctness guard only: catches references to names that are neither
// declared nor imported (e.g. a missing store import that only fails when a
// tool is invoked). Style is intentionally not linted.
export default [
  { ignores: ["node_modules/", "docs/", "coverage/"] },
  {
    files: ["**/*.mjs"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: { ...globals.node }
    },
    rules: { "no-undef": "error" }
  },
  {
    files: ["web/**/*.js"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "script",
      globals: { ...globals.browser }
    },
    rules: { "no-undef": "error" }
  }
];
