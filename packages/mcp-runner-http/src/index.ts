import express from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpServer } from "diagram-creator-mcp-server-node";
import { randomUUID } from "crypto";

async function main() {
  const app = express();
  const server = await createMcpServer();

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
  });

  await server.connect(transport);

  app.post("/sse", async (req, res) => {
    await transport.handleRequest(req, res);
  });

  app.post("/messages", async (req, res) => {
    await transport.handleRequest(req, res);
  });

  const port = process.env.PORT || 3000;
  app.listen(port, () => {
    console.log(`MCP HTTP Server listening on port ${port}`);
  });
}

main().catch(console.error);
