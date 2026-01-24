import { defineConfig } from "tsdown";
import fs from "node:fs";
import path from "node:path";
import matter from "gray-matter";
import { create, insert, save } from "@orama/orama";
import { FrontmatterSchema } from "./src/schema.ts";

const markdownPlugin = {
  name: "markdown-loader",
  resolveId(id: string) {
    if (id === "virtual:markdown-files") {
      return "\0virtual:markdown-files";
    }
  },
  async load(id: string) {
    if (id === "\0virtual:markdown-files") {
      const dataDir = path.resolve(process.cwd(), "data");

      const db = create({
        schema: {
          id: "string",
          description: "string",
          content: "string",
          author: "string",
        },
      });

      if (fs.existsSync(dataDir)) {
        const files = fs.readdirSync(dataDir).filter((f) => f.endsWith(".md"));

        for (const file of files) {
          const rawContent = fs.readFileSync(path.join(dataDir, file), "utf-8");
          const parsed = matter(rawContent);
          const frontmatter = FrontmatterSchema.parse(parsed.data);

          await insert(db, {
            id: file,
            description: frontmatter.description ?? "",
            content: parsed.content,
            author: frontmatter.author ?? "",
          });
        }
      }

      const serialized = save(db);
      return `export default ${JSON.stringify(serialized)};`;
    }
  },
};

export default defineConfig({
  entry: ["./src/index.ts"],
  format: "esm",
  clean: true,
  plugins: [markdownPlugin],
});
