import { defineConfig } from "tsdown";
import { wasm } from "rolldown-plugin-wasm";
import workerPlugins from "tsdown-plugin-worker";

export default defineConfig({
  entry: ["./src/index.ts"],
  plugins: [
    wasm(),
    workerPlugins({
      format: "es",
      rolldownOptions: {
        plugins: [wasm()],
      },
    }),
  ],
  format: ["esm"],
  clean: true,
  dts: true,
  loader: {
    ".otf": "asset",
  },
  outputOptions: {
    assetFileNames: "fonts/[name][extname]",
  },
});
