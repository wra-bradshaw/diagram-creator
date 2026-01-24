import { createTypstCompiler, createTypstRenderer, FetchPackageRegistry, MemoryAccessModel } from "@myriaddreamin/typst.ts";
import { CompileFormatEnum } from "@myriaddreamin/typst.ts/compiler";
import { Resvg } from "@resvg/resvg-js";
import { searchIndex } from "diagram-creator-mcp-common";
import { create, load, search } from "@orama/orama";
import { withPackageRegistry } from "@myriaddreamin/typst.ts/dist/esm/options.init.mjs";
import { NodeFetchPackageRegistry } from "@myriaddreamin/typst.ts/dist/esm/fs/package.node.mjs";

let db: ReturnType<
  typeof create<{
    id: "string";
    description: "string";
    content: "string";
    author: "string";
  }>
> | null = null;
const compiler = createTypstCompiler();

if (typeof window === "undefined") {
  const { request } = await import("node:http");

  await compiler.init({
    beforeBuild: [withPackageRegistry(new NodeFetchPackageRegistry(new MemoryAccessModel(), request))],
  });
} else if (typeof window.XMLHttpRequest === "function") {
  await compiler.init({
    beforeBuild: [withPackageRegistry(new FetchPackageRegistry(new MemoryAccessModel()))],
  });
} else {
  throw new Error("No supported PackageRegistry");
}

const renderer = createTypstRenderer();

await renderer.init();

export async function getDb() {
  if (!db) {
    db = create({
      schema: {
        id: "string",
        description: "string",
        content: "string",
        author: "string",
      },
    });
    load(db, searchIndex);
  }
  return db;
}

export async function searchCetzExamples(query: string) {
  const db = await getDb();
  const searchResult = await search(db, {
    term: query,
    limit: 5,
  });

  return searchResult.hits.map((hit) => hit.document);
}

export async function compileTypst(source: string) {
  const mainFilePath = "/main.typ";
  compiler.addSource(mainFilePath, source);

  const compileResult = await compiler.compile({
    mainFilePath,
    format: CompileFormatEnum.vector,
    diagnostics: "full",
  });

  const errors: any[] = [];
  const warnings: any[] = [];

  if (compileResult.diagnostics) {
    errors.push(...compileResult.diagnostics.filter((d: any) => d.severity === "error"));
    warnings.push(...compileResult.diagnostics.filter((d: any) => d.severity === "warning"));
  }

  let diagnosticsMessage = "";
  if (compileResult.diagnostics && compileResult.diagnostics?.length > 0) {
    diagnosticsMessage = diagnosticsMessage.concat("## Diagnostics:\n");
    if (errors.length > 0) {
      diagnosticsMessage = diagnosticsMessage.concat(
        `### Errors:
${errors.reduce((acc: string, curr: any) => acc + "\n" + curr.message + " at " + curr.range, "")}
`,
      );
    }
    if (warnings.length > 0) {
      diagnosticsMessage = diagnosticsMessage.concat(
        `### Warnings:
${warnings.reduce((acc: string, curr: any) => acc + "\n" + curr.message + " at " + curr.range, "")}
`,
      );
    }
  }

  if (errors.length > 0 || !compileResult.result) {
    return {
      success: false as const,
      diagnostics: diagnosticsMessage,
    };
  }

  const artifact = compileResult.result;
  const svg = renderer.renderSvg({
    format: "vector",
    artifactContent: artifact,
  });

  const resvg = new Resvg(await svg, {
    fitTo: { mode: "width", value: 2000 },
    background: "#fff",
  });

  const pngData = resvg.render();
  const pngBuffer = pngData.asPng();
  const pngUint8ArrayBuf = new Uint8Array(pngBuffer);

  return {
    success: true as const,
    image: pngUint8ArrayBuf,
    diagnostics: diagnosticsMessage,
  };
}
