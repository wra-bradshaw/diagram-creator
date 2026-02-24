import { Context, Effect, Layer } from "effect";
import { DirectService } from "./direct-service";
import type { CompileResult } from "./index";
import { WorkerService } from "./worker-service";

export type CompilerBackendService = {
  readonly ready: Effect.Effect<void>;
  readonly init: (wasmUrl: string) => Effect.Effect<void>;
  readonly dispose: Effect.Effect<void>;
  readonly addFont: (data: Uint8Array) => Effect.Effect<void>;
  readonly addFile: (path: string, data: Uint8Array) => Effect.Effect<void>;
  readonly addSource: (path: string, text: string) => Effect.Effect<void>;
  readonly removeFile: (path: string) => Effect.Effect<void>;
  readonly clearFiles: Effect.Effect<void>;
  readonly listFiles: Effect.Effect<string[], unknown>;
  readonly hasFile: (path: string) => Effect.Effect<boolean, unknown>;
  readonly setMain: (path: string) => Effect.Effect<void>;
  readonly compile: () => Effect.Effect<CompileResult, unknown>;
};

export class CompilerBackend extends Context.Tag("CompilerBackend")<CompilerBackend, CompilerBackendService>() {}

export const WorkerBackendLayer = Layer.effect(
  CompilerBackend,
  Effect.map(WorkerService, (service) => service as CompilerBackendService),
).pipe(Layer.provide(WorkerService.Default));

export const JspiBackendLayer = Layer.effect(
  CompilerBackend,
  Effect.map(DirectService, (service) => service as CompilerBackendService),
).pipe(Layer.provide(DirectService.Default));
