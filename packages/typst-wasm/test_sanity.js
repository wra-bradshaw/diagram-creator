import { defaultFonts, TypstCompilerService, WorkerBackendLayer } from "./dist/index.js";
import { Effect } from "effect";
import fs from "fs";

const wasmUrl = "file:///Users/will/Documents/diagram-creator-tanstack/packages/typst-wasm/dist/typst_wasm_bg.wasm";

async function run() {
  try {
    console.log("Initializing compiler...");
    console.log("WASM URL:", wasmUrl);

    const mainText = `
#import "@preview/cetz:0.4.2": canvas, draw
#import "@preview/cetz-plot:0.1.3": chart

#set page(width: auto, height: auto, margin: .5cm)

#let data2 = (
  ([15-24], 18.0, 20.1, 23.0, 17.0),
  ([25-29], 16.3, 17.6, 19.4, 15.3),
  ([30-34], 14.0, 15.3, 13.9, 18.7),
  ([35-44], 35.5, 26.5, 29.4, 25.8),
  ([45-54], 25.0, 20.6, 22.4, 22.0),
  ([55+],   19.9, 18.2, 19.2, 16.4),
)

#canvas({
  draw.set-style(legend: (fill: white), barchart: (bar-width: .8, cluster-gap: 0))
  chart.barchart(mode: "clustered",
                 size: (9, auto),
                 label-key: 0,
                 value-key: (..range(1, 5)),
                 x-tick-step: 2.5,
                 data2,
                 labels: ([Low], [Medium], [High], [Very high]),
                 legend: "inner-north-east",)
})
`;

    const program = Effect.gen(function* () {
      const compiler = yield* TypstCompilerService;

      // Initialize
      yield* compiler.init({ wasmUrl });
      yield* compiler.ready;
      console.log("Compiler ready!");

      // Load and add fonts
      console.log("Loading fonts...");
      for (const font of defaultFonts) {
        const data = yield* Effect.tryPromise(() => font.load());
        yield* compiler.addFont(data);
      }
      console.log("Fonts loaded!");

      // Add source files
      console.log("Adding files...");
      yield* compiler.addSource("main.typ", mainText);

      // Check file state
      const hasMain = yield* compiler.hasFile("main.typ");
      console.log("Has main.typ:", hasMain);

      const files = yield* compiler.listFiles;
      console.log("Files:", files);

      // Set main and compile
      console.log("Setting main...");
      yield* compiler.setMain("main.typ");

      console.log("Compiling...");
      const result = yield* compiler.compile();

      if (result.diagnostics && result.diagnostics.length > 0) {
        console.error("Diagnostics:", result.diagnostics);
      }

      if (result.svg) {
        console.log("SVG generated successfully (length: " + result.svg.length + ")");
        fs.writeFileSync("output1.svg", result.svg);
        console.log("Wrote output1.svg");
      }

      // Test iterative editing - update and recompile
      console.log("\n--- Testing iterative editing ---");
      const updatedText = mainText.replace("Low", "MIN");
      yield* compiler.addSource("main.typ", updatedText);

      console.log("Recompiling...");
      const result2 = yield* compiler.compile();
      if (result2.svg) {
        console.log("Second SVG (length: " + result2.svg.length + ")");
        fs.writeFileSync("output2.svg", result2.svg);
        console.log("Wrote output2.svg");
      }

      if (result.svg) {
        console.log("SVG generated successfully (length: " + result.svg.length + ")");
      }

      // Test clear and new project
      console.log("\n--- Testing clear and new project ---");
      yield* compiler.clearFiles;

      const newFiles = yield* compiler.listFiles;
      console.log("Files after clear:", newFiles);

      yield* compiler.addSource("test.typ", "= Hello World");
      yield* compiler.setMain("test.typ");

      const result3 = yield* compiler.compile();
      if (result3.svg) {
        console.log("New project SVG (length: " + result3.svg.length + ")");
        fs.writeFileSync("output3.svg", result3.svg);
        console.log("Wrote output3.svg");
      }

      return result3;
    });

    const result = await Effect.runPromise(
      program.pipe(Effect.provide(TypstCompilerService.Default), Effect.provide(WorkerBackendLayer)),
    );

    console.log("\nDone!");
  } catch (e) {
    console.error("Error:", e);
    process.exit(1);
  }
}

run();
