import { SharedMemoryCommunication, SharedMemoryCommunicationStatus } from "./protocol";
import { WorkerToMainMessage } from "./worker";
import type { WasmDiagnostic } from "./wasm/typst_wasm";
import { PackageManager } from "./package-manager";
import TypstWorker from "./worker.ts?worker";
import type { Font } from "./fonts/index";
import { Context, Data, Effect, Layer, Deferred, Ref, Scope, Either } from "effect";
import { CompileError } from "./errors";

export * from "./errors";
export interface CompileResult {
  svg?: string;
  diagnostics: WasmDiagnostic[];
}

export interface TypstCompilerOptions {
  wasmUrl: string;
  fonts?: Font[];
  memoryPackageCacheCapacity?: number;
}

export interface TypstCompilerService {
  readonly compile: (options: { mainPath: string; files?: Record<string, Uint8Array> }) => Effect.Effect<CompileResult, CompileError>;
  readonly ready: Effect.Effect<void>;
  readonly dispose: Effect.Effect<void>;
}

export class TypstCompilerService extends Context.Tag("TypstCompilerService")<TypstCompilerService, TypstCompilerServiceImpl>() {
  static Live = (options: TypstCompilerOptions) => Layer.scoped(TypstCompilerService, makeTypstCompiler(options));
}

export interface TypstCompilerServiceImpl {
  readonly compile: (options: { mainPath: string; files?: Record<string, Uint8Array> }) => Effect.Effect<CompileResult, CompileError>;
  readonly ready: Effect.Effect<void>;
  readonly dispose: Effect.Effect<void>;
}

export type MainToWorkerMessage =
  | {
      kind: "init";
      payload: {
        sharedMemoryCommunication: SharedMemoryCommunication;
        wasmUrl: string;
      };
    }
  | {
      kind: "compile";
      payload: {
        mainPath: string;
        files?: Record<string, Uint8Array<ArrayBufferLike>>;
      };
    }
  | {
      kind: "load_font";
      payload: {
        data: Uint8Array;
      };
    };

export * from "./fonts/index";

function makeTypstCompiler(options: TypstCompilerOptions) {
  return Effect.gen(function* () {
    const worker = new TypstWorker();
    const packageManager = new PackageManager(options.memoryPackageCacheCapacity ?? 400);
    const sharedMemoryCommunication = new SharedMemoryCommunication();
    const fonts = options.fonts ?? [];

    const readyDeferred = yield* Deferred.make<void>();
    const disposedRef = yield* Ref.make(false);
    const compileDeferredRef = yield* Ref.make<{
      resolve: (result: CompileResult) => void;
      reject: (error: unknown) => void;
    } | null>(null);

    const loadFonts = Effect.gen(function* () {
      for (const font of fonts) {
        const result = yield* Effect.tryPromise(() => font.load()).pipe(Effect.either);
        if (result._tag === "Right") {
          yield* Effect.sync(() => {
            worker.postMessage({
              kind: "load_font",
              payload: { data: result.right },
            } as MainToWorkerMessage);
          });
        }
      }
    });

    const handleFetchRequest = (path: string) =>
      Effect.gen(function* () {
        const disposed = yield* Ref.get(disposedRef);
        if (disposed) return;

        const result = yield* Effect.tryPromise({
          try: async () => {
            let data: Uint8Array;
            if (path.startsWith("@")) {
              data = await packageManager.getFile(path);
            } else {
              const res = await fetch(path);
              if (!res.ok) throw new Error(`Status ${res.status}`);
              data = new Uint8Array(await res.arrayBuffer());
            }
            return data;
          },
          catch: (err) => err,
        }).pipe(Effect.either);

        if (result._tag === "Right") {
          sharedMemoryCommunication.setBuffer(result.right);
          sharedMemoryCommunication.setStatus(SharedMemoryCommunicationStatus.Success);
        } else {
          sharedMemoryCommunication.setStatus(SharedMemoryCommunicationStatus.Error);
        }
      });

    const messageHandler = (e: MessageEvent) => {
      const data = e.data as WorkerToMainMessage;

      switch (data.kind) {
        case "ready":
          Effect.runFork(loadFonts.pipe(Effect.flatMap(() => Deferred.succeed(readyDeferred, undefined))));
          break;
        case "compiled": {
          Effect.runFork(
            Effect.gen(function* () {
              const deferred = yield* Ref.get(compileDeferredRef);
              if (deferred) {
                deferred.resolve({
                  svg: data.payload.svg,
                  diagnostics: data.payload.diagnostics,
                });
                yield* Ref.set(compileDeferredRef, null);
              }
            }),
          );
          break;
        }
        case "compile_error": {
          Effect.runFork(
            Effect.gen(function* () {
              const deferred = yield* Ref.get(compileDeferredRef);
              if (deferred) {
                deferred.reject(new Error(data.payload.error));
                yield* Ref.set(compileDeferredRef, null);
              }
            }),
          );
          break;
        }
        case "web_fetch":
          Effect.runFork(handleFetchRequest(data.payload.path));
          break;
      }
    };

    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        yield* Ref.set(disposedRef, true);
        const deferred = yield* Ref.get(compileDeferredRef);
        if (deferred) {
          deferred.reject(new Error("Compiler disposed"));
        }
        yield* Effect.sync(() => {
          worker.removeEventListener("message", messageHandler);
          worker.terminate();
        });
      }),
    );

    yield* Effect.sync(() => {
      worker.addEventListener("message", messageHandler);
      worker.postMessage({
        kind: "init",
        payload: {
          sharedMemoryCommunication,
          wasmUrl: options.wasmUrl,
        },
      } as MainToWorkerMessage);
    });

    return TypstCompilerService.of({
      ready: Deferred.await(readyDeferred),

      compile: (compileOptions: { mainPath: string; files?: Record<string, Uint8Array> }) =>
        Effect.gen(function* () {
          const disposed = yield* Ref.get(disposedRef);
          if (disposed) {
            return yield* Effect.fail(
              new CompileError({
                diagnostics: [{ message: "Compiler has been disposed" } as WasmDiagnostic],
              }),
            );
          }

          yield* Deferred.await(readyDeferred);

          const existingDeferred = yield* Ref.get(compileDeferredRef);
          if (existingDeferred) {
            return yield* Effect.fail(
              new CompileError({
                diagnostics: [{ message: "Compilation already in progress" } as WasmDiagnostic],
              }),
            );
          }

          return yield* Effect.async<CompileResult, CompileError>((resume) => {
            const deferred = {
              resolve: (result: CompileResult) => resume(Effect.succeed(result)),
              reject: (error: unknown) =>
                resume(
                  Effect.fail(
                    new CompileError({
                      diagnostics: [{ message: String(error) } as WasmDiagnostic],
                    }),
                  ),
                ),
            };

            Effect.runFork(Ref.set(compileDeferredRef, deferred));

            worker.postMessage({
              kind: "compile",
              payload: {
                mainPath: compileOptions.mainPath,
                files: compileOptions.files,
              },
            } as MainToWorkerMessage);
          });
        }),

      dispose: Ref.set(disposedRef, true),
    });
  });
}

export class TypstCompilerOld {
  private worker: Worker;
  private initPromise: Promise<void>;
  private compileResolver: ((result: CompileResult) => void) | null = null;
  private compileRejecter: ((err: any) => void) | null = null;
  private packageManager: PackageManager;
  private debug: boolean;
  private disposed: boolean = false;
  private sharedMemoryCommunication: SharedMemoryCommunication;
  private fonts: Font[] = [];

  constructor(options: TypstCompilerOptions) {
    this.debug = options.debug ?? false;
    this.worker = new TypstWorker();
    this.packageManager = new PackageManager(options.memoryPackageCacheCapacity ?? 400);
    this.sharedMemoryCommunication = new SharedMemoryCommunication();
    this.fonts = options.fonts ?? [];

    const initPromise = new Promise<void>((resolve) => {
      const handler = (e: MessageEvent) => {
        const data = e.data as WorkerToMainMessage;
        if (data.kind === "ready") {
          this.worker.removeEventListener("message", handler);
          resolve();
        }
      };
      this.worker.addEventListener("message", handler);

      this.worker.postMessage({
        kind: "init",
        payload: {
          sharedMemoryCommunication: this.sharedMemoryCommunication,
          wasmUrl: options.wasmUrl,
        },
      } as MainToWorkerMessage);
    });

    this.worker.addEventListener("message", (e) => this.handleMessage(e));

    const fontsPromise = initPromise.then(async () => {
      await this.loadFonts();
    });

    this.initPromise = fontsPromise;
  }

  private async loadFonts(): Promise<void> {
    for (const font of this.fonts) {
      try {
        const data = await font.load();
        this.worker.postMessage({
          kind: "load_font",
          payload: { data },
        } as MainToWorkerMessage);
      } catch (err) {
        if (this.debug) {
          console.error(`[TypstCompiler] Failed to load font "${font.name}":`, err);
        }
      }
    }
  }

  async ready(): Promise<void> {
    return this.initPromise;
  }

  async compile(options: { mainPath: string; files?: Record<string, Uint8Array> }): Promise<CompileResult> {
    if (this.disposed) {
      throw new Error("Compiler has been disposed");
    }
    await this.ready();

    if (this.compileResolver) {
      throw new Error("Compilation already in progress");
    }

    return new Promise((resolve, reject) => {
      this.compileResolver = resolve;
      this.compileRejecter = reject;
      this.worker.postMessage({
        kind: "compile",
        payload: {
          mainPath: options.mainPath,
          files: options.files,
        },
      } as MainToWorkerMessage);
    });
  }

  private async handleMessage(e: MessageEvent) {
    const data = e.data as WorkerToMainMessage;

    switch (data.kind) {
      case "compiled":
        if (this.compileResolver) {
          this.compileResolver({
            svg: data.payload.svg,
            diagnostics: data.payload.diagnostics,
          });
          this.compileResolver = null;
          this.compileRejecter = null;
        }
        break;
      case "compile_error":
        if (this.compileRejecter) {
          this.compileRejecter(new Error(data.payload.error));
        }
        break;
      case "web_fetch":
        await this.handleFetchRequest(data.payload.path);
        break;
    }
  }

  private async handleFetchRequest(path: string) {
    try {
      let data: Uint8Array;
      if (path.startsWith("@")) {
        data = await this.packageManager.getFile(path);
      } else {
        data = await this.fetchFile(path);
      }

      this.sharedMemoryCommunication.setBuffer(data);
      this.sharedMemoryCommunication.setStatus(SharedMemoryCommunicationStatus.Success);
    } catch (err: any) {
      if (this.debug) {
        console.error(`[TypstCompiler] Failed to fetch ${path}:`, err);
      }
      this.sharedMemoryCommunication.setStatus(SharedMemoryCommunicationStatus.Error);
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.worker.terminate();

    if (this.compileRejecter) {
      this.compileRejecter(new Error("Compiler disposed"));
      this.compileResolver = null;
      this.compileRejecter = null;
    }
  }

  private async fetchFile(path: string): Promise<Uint8Array> {
    const res = await fetch(path);
    if (!res.ok) throw new Error(`Status ${res.status}`);
    return new Uint8Array(await res.arrayBuffer());
  }
}
