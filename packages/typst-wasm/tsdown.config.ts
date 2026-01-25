import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["./src/index.ts", "./src/worker.ts"],
  format: ["cjs", "esm"],
  clean: true,
  dts: true,
});
