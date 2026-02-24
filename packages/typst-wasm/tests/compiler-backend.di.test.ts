import { Deferred, Effect, Layer, Ref } from "effect";
import { describe, expect, it } from "vitest";
import { CompilerBackend } from "../src/compiler-backend";
import { TypstCompilerService } from "../src/index";

describe("compiler backend DI", () => {
  it("uses injected backend implementation", async () => {
    const initCalls = await Effect.runPromise(Ref.make(0));
    const ready = await Effect.runPromise(Deferred.make<void>());

    const backendLayer = Layer.succeed(CompilerBackend, {
      ready: Deferred.await(ready),
      init: () =>
        Effect.gen(function* () {
          yield* Ref.update(initCalls, (n) => n + 1);
          yield* Deferred.succeed(ready, undefined);
        }),
      dispose: Effect.void,
      addFont: () => Effect.void,
      addFile: () => Effect.void,
      addSource: () => Effect.void,
      removeFile: () => Effect.void,
      clearFiles: Effect.void,
      listFiles: Effect.succeed(["main.typ"]),
      hasFile: () => Effect.succeed(true),
      setMain: () => Effect.void,
      compile: () => Effect.succeed({ svg: "<svg />", diagnostics: [] }),
    });

    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const compiler = yield* TypstCompilerService;
          yield* compiler.init({ wasmUrl: "test.wasm" });
          const files = yield* compiler.listFiles;
          const output = yield* compiler.compile();
          return { files, output };
        }).pipe(
          Effect.provide(TypstCompilerService.Default),
          Effect.provide(backendLayer),
        ),
      ),
    );

    const calls = await Effect.runPromise(Ref.get(initCalls));
    expect(calls).toBe(1);
    expect(result.files).toEqual(["main.typ"]);
    expect(result.output.svg).toBe("<svg />");
  });
});
