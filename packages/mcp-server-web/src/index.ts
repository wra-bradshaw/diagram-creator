import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { searchCetzExamples, compileTypst, initTypst } from "./tools.js";

export async function createMcpServer() {
  const server = new McpServer({
    name: "diagram-creator-mcp",
    version: "1.0.0",
  });

  const searchInputSchema = z.object({
    query: z.string().describe("Search query for Cetz examples"),
  });

  server.registerTool(
    "search_cetz_examples",
    {
      description: "Search query for Cetz examples",
      inputSchema: searchInputSchema,
    },
    async ({ query }) => {
      const results = await searchCetzExamples(query);
      return {
        content: results.map((doc: any) => ({
          type: "text",
          text: `File: ${doc.id}\nDescription: ${doc.description}\n\n${doc.content}`,
        })),
      };
    },
  );

  const compileSchema = z.object({
    source: z.string().describe("Typst source code to compile"),
  });

  server.registerTool(
    "compile_typst",
    {
      description: "Typst source code to compile",
      inputSchema: compileSchema,
    },
    async ({ source }) => {
      const result = await compileTypst(source);
      if (!result.success) {
        return {
          content: [
            {
              type: "text",
              text: `Unable to compile your diagram.`,
            },
            {
              type: "text",
              text: result.diagnostics,
            },
          ],
        };
      }
      return {
        content: [
          {
            type: "image",
            mimeType: "image/png",
            data: Buffer.from(result.image).toString("base64"),
          },
          {
            type: "text",
            text: result.diagnostics,
          },
        ],
      };
    },
  );

  return server;
}
