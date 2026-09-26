import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { McpServer, fromJsonSchema } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { invoke, tools } from "./tool-catalog.mjs";

const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

export function createMcpServer() {
  const server = new McpServer({ name: "omp-orchestrator", version });
  for (const tool of tools) {
    server.registerTool(tool.name, {
      description: tool.description,
      inputSchema: fromJsonSchema(tool.inputSchema)
    }, async (args) => {
      try {
        const value = await invoke(tool.name, args);
        return {
          content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
          structuredContent: value !== null && typeof value === "object" && !Array.isArray(value)
            ? value : { value },
          isError: false
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
          isError: true
        };
      }
    });
  }
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  serveStdio(createMcpServer, { onerror: (error) => console.error("MCP transport error:", error?.name || "Error") });
}
