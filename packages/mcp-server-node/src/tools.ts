import { NodeCompiler } from "@myriaddreamin/typst-ts-node-compiler";
import { Resvg } from "@resvg/resvg-js";
import { searchIndex } from "diagram-creator-mcp-common";
import { create, load, search } from "@orama/orama";
import { writeFileSync } from "fs";

let db: ReturnType<
  typeof create<{
    id: "string";
    description: "string";
    content: "string";
    author: "string";
  }>
> | null = null;

export async function getDb() {
  if (db === null) {
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

const compiler = NodeCompiler.create({ workspace: "/" });

export async function compileTypst(source: string) {
  const mainFilePath = "/main.typ";
  compiler.addSource(mainFilePath, source);

  const compileResult = compiler.compile({
    mainFilePath,
  });

  const error = compileResult.takeError();
  const warnings = compileResult.takeWarnings();

  let diagnosticsMessage = "";

  if (error !== null) {
    const diagnostic = compiler.fetchDiagnostics(error);
    diagnosticsMessage = diagnosticsMessage.concat(`### Errors
${diagnostic.reduce((acc: string, curr: any) => acc + "\n" + JSON.stringify(curr), "")}
`);
  }

  if (warnings !== null) {
    const diagnostic = compiler.fetchDiagnostics(warnings);
    diagnosticsMessage = diagnosticsMessage.concat(`\n### Warnings
${diagnostic.reduce((acc: string, curr: any) => acc + "\n" + JSON.stringify(curr), "")}
`);
  }

  if (error !== null || compileResult.result === null) {
    return {
      success: false as const,
      diagnostics: diagnosticsMessage,
    };
  }

  const svg = compiler.svg(compileResult.result);

  const resvg = new Resvg(svg, {
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
