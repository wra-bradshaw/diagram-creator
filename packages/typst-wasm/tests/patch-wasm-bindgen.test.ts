import { describe, expect, it } from "vitest";
import { applyPatch } from "../scripts/patch-wasm-bindgen";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("patch-wasm-bindgen", () => {
  it("applies patch and is idempotent", () => {
    const wasmPath = resolve(import.meta.dirname, "../src/wasm/typst_wasm.js");
    const source = readFileSync(wasmPath, "utf8");

    const once = applyPatch(source);
    const twice = applyPatch(once);

    expect(once).toContain("/* __typst_wasm_custom_imports_patch__ */");
    expect(once).toContain("function __wbg_get_imports(memory, customImports)");
    expect(once).toContain("imports: customImports");
    expect(twice).toBe(once);
  });

  it("fails loudly when expected anchors are missing", () => {
    expect(() => applyPatch("function nope() {}")).toThrowError("Patch anchor not found");
  });
});
