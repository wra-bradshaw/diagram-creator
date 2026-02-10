import { SharedMemoryCommunication, SharedMemoryCommunicationStatus } from "./protocol";
import { WorkerToMainMessage } from "./worker";
import { WasmDiagnostic } from "./wasm/typst_wasm";
import { PackageManager } from "./package-manager";
import TypstWorker from "./worker.ts?worker";
import type { Font } from "./fonts/index";

export type MainToWorkerMessage =
  | {
      kind: "init";
      payload: {
        sharedMemoryCommunication: SharedMemoryCommunication;
      };
    }
  | {
      kind: "compile";
      payload: {
        mainPath: string;
        files: Record<string, Uint8Array<ArrayBufferLike>>;
      };
    }
  | {
      kind: "load_font";
      payload: {
        data: Uint8Array;
      };
    };

// Re-export Font type for users
export type { Font } from "./fonts/index";

export interface CompileResult {
  success: boolean;
  svg?: string;
  diagnostics: WasmDiagnostic[];
}

export interface TypstCompilerOptions {
  /** Enable debug logging. Default: false */
  debug?: boolean;
  /** Fonts to load for compilation */
  fonts?: Font[];
}

export class TypstCompiler {
  private worker: Worker;
  private initPromise: Promise<void>;
  private compileResolver: ((result: CompileResult) => void) | null = null;
  private compileRejecter: ((err: any) => void) | null = null;
  private packageManager: PackageManager;
  private debug: boolean;
  private disposed: boolean = false;
  private sharedMemoryCommunication: SharedMemoryCommunication;
  private fonts: Font[] = [];

  constructor(options: TypstCompilerOptions = {}) {
    this.debug = options.debug ?? false;
    console.log(new Worker("./blah.js"));
    this.worker = new TypstWorker();
    console.log(this.worker);
    this.packageManager = new PackageManager();
    this.sharedMemoryCommunication = new SharedMemoryCommunication();
    this.fonts = options.fonts ?? [];

    this.initPromise = new Promise((resolve, reject) => {
      const handler = (e: MessageEvent) => {
        const data = e.data as WorkerToMainMessage;
        console.log(e);
        if (data.kind === "ready") {
          this.worker.removeEventListener("message", handler);
          resolve();
        }
      };
      this.worker.addEventListener("message", handler);

      console.log("initing");
      this.worker.postMessage({
        kind: "init",
        payload: {
          sharedMemoryCommunication: this.sharedMemoryCommunication,
        },
      } as MainToWorkerMessage);
      console.log("message posted!");
    });

    this.worker.addEventListener("message", (e) => this.handleMessage(e));

    // Load fonts after initialization
    if (this.fonts.length > 0) {
      this.initPromise.then(() => this.loadFonts());
    }
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
            success: true,
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
        // Handle fetch request from Worker
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

  /**
   * Dispose of the compiler and terminate the worker.
   * After calling this method, the compiler instance cannot be used.
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.worker.terminate();

    // Reject any pending compilation
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
