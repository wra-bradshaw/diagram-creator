import { gunzipSync } from "fflate";

export interface Diagnostic {
  message: string;
  severity: "error" | "warning";
  start?: number;
  end?: number;
  line?: number;
  column?: number;
}

export interface CompileResult {
  svg?: string;
  diagnostics: Diagnostic[];
}

const STATUS_READY = 2;
const STATUS_ERROR = 3;
const OFFSET_STATUS = 4;
const OFFSET_RESULT_LEN = 1040;
const OFFSET_ERROR_CODE = 1044;
const OFFSET_DATA = 1048;

export interface TypstCompilerOptions {
  /** Enable debug logging. Default: false */
  debug?: boolean;
}

export class TypstCompiler {
  private worker: Worker;
  private initPromise: Promise<void>;
  private compileResolver: ((result: CompileResult) => void) | null = null;
  private compileRejecter: ((err: any) => void) | null = null;
  private packageCache = new Map<string, Uint8Array>();
  private bridgePtr: number = 0;
  private wasmMemory: WebAssembly.Memory | null = null;
  private debug: boolean;
  private disposed: boolean = false;

  constructor(wasmUrl: string, workerUrl: string, options: TypstCompilerOptions = {}) {
    this.debug = options.debug ?? false;
    this.worker = new Worker(workerUrl, { type: "module" });

    this.initPromise = new Promise((resolve, reject) => {
      const handler = (e: MessageEvent) => {
        if (e.data.type === "ready") {
          this.worker.removeEventListener("message", handler);
          this.bridgePtr = e.data.payload.bridgePtr;
          this.wasmMemory = { buffer: e.data.payload.memory } as WebAssembly.Memory;
          resolve();
        }
      };
      this.worker.addEventListener("message", handler);
      this.worker.postMessage({ type: "init", payload: { wasmUrl } });
    });

    this.worker.addEventListener("message", (e) => this.handleMessage(e));
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
        type: "compile",
        payload: {
          mainPath: options.mainPath,
          files: options.files,
        },
      });
    });
  }

  private async handleMessage(e: MessageEvent) {
    const { type, payload, result, error } = e.data;

    switch (type) {
      case "compiled":
        if (this.compileResolver) {
          if (error) {
            // Return diagnostics if it's an array, else throw
            if (Array.isArray(error) || (error && Array.isArray(error.diagnostics))) {
              this.compileResolver({ diagnostics: error.diagnostics || error });
            } else {
              this.compileRejecter?.(error);
            }
          } else {
            this.compileResolver({ svg: result, diagnostics: [] });
          }
          this.compileResolver = null;
          this.compileRejecter = null;
        }
        break;
      case "resource_request":
        await this.handleResourceRequest(payload);
        break;
    }
  }

  private async handleResourceRequest({ kind, path }: { kind: number; path: string }) {
    try {
      let data: Uint8Array;

      if (this.debug) {
        console.log(`[TypstCompiler] Fetching ${path}`);
      }

      if (path.startsWith("@")) {
        data = await this.fetchPackage(path);
      } else {
        data = await this.fetchFile(path);
      }

      if (this.debug) {
        console.log(`[TypstCompiler] Ready ${path} (${data.length} bytes)`);
      }

      this.writeToMemory(data);
    } catch (err: any) {
      if (this.debug) {
        console.error(`[TypstCompiler] Failed to fetch ${path}:`, err);
      }
      this.writeError(404);
    }
  }

  private writeToMemory(data: Uint8Array) {
    if (!this.bridgePtr || !this.wasmMemory) return;

    const view = new DataView(this.wasmMemory.buffer);
    const ptr = this.bridgePtr;

    // Copy data to buffer
    const dest = new Uint8Array(this.wasmMemory.buffer, ptr + OFFSET_DATA, data.length);
    dest.set(data);

    view.setUint32(ptr + OFFSET_RESULT_LEN, data.length, true);
    view.setUint32(ptr + OFFSET_STATUS, STATUS_READY, true); // Status Ready

    // Notify via Atomics
    const signalIndex = ptr / 4; // Int32 index
    const int32View = new Int32Array(this.wasmMemory.buffer);

    Atomics.store(int32View, signalIndex, STATUS_READY);
    Atomics.notify(int32View, signalIndex, 1);
  }

  private writeError(code: number) {
    if (!this.bridgePtr || !this.wasmMemory) return;

    const view = new DataView(this.wasmMemory.buffer);
    const ptr = this.bridgePtr;

    view.setUint32(ptr + OFFSET_ERROR_CODE, code, true);
    view.setUint32(ptr + OFFSET_STATUS, STATUS_ERROR, true);

    // Notify via Atomics - signal value just needs to change from PENDING
    // The Rust side checks the status field to determine success/error
    const signalIndex = ptr / 4;
    const int32View = new Int32Array(this.wasmMemory.buffer);

    Atomics.store(int32View, signalIndex, STATUS_ERROR);
    Atomics.notify(int32View, signalIndex, 1);
  }

  /**
   * Dispose of the compiler and terminate the worker.
   * After calling this method, the compiler instance cannot be used.
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.worker.terminate();
    this.packageCache.clear();
    this.wasmMemory = null;
    
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

  private async fetchPackage(spec: string): Promise<Uint8Array> {
    // spec: @namespace/name:version/path
    const match = spec.match(/^@([^/]+)\/([^:]+):([^/]+)\/(.+)$/);
    if (!match) throw new Error("Invalid package spec: " + spec);

    const [, namespace, name, version, filePath] = match;
    const cacheKey = `${namespace}/${name}/${version}`;
    let tarData = this.packageCache.get(cacheKey);

    if (!tarData) {
      const url = `https://packages.typst.org/${namespace}/${name}-${version}.tar.gz`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`Failed to fetch package ${url}`);
      const buffer = await res.arrayBuffer();
      tarData = new Uint8Array(buffer);
      this.packageCache.set(cacheKey, tarData);
    }

    const decompressed = gunzipSync(tarData);
    return this.extractFromTar(decompressed, filePath);
  }

  private extractFromTar(tarBuffer: Uint8Array, targetPath: string): Uint8Array {
    let offset = 0;
    const textDecoder = new TextDecoder();

    while (offset < tarBuffer.length) {
      const nameBytes = tarBuffer.subarray(offset, offset + 100);
      const nameEnd = nameBytes.indexOf(0);
      const name = textDecoder.decode(nameBytes.subarray(0, nameEnd < 0 ? 100 : nameEnd));

      if (name.length === 0) break;

      const sizeBytes = tarBuffer.subarray(offset + 124, offset + 136);
      const sizeStr = textDecoder.decode(sizeBytes).trim().replace(/\0/g, "");
      const size = parseInt(sizeStr, 8);

      const typeFlag = tarBuffer[offset + 156];
      const headerSize = 512;
      const contentOffset = offset + headerSize;

      // Regular file: typeFlag 48 ('0') or 0 (legacy tar format)
      // Typst packages use flat paths without a root directory prefix
      if ((typeFlag === 48 || typeFlag === 0) && name === targetPath) {
        return tarBuffer.slice(contentOffset, contentOffset + size);
      }

      offset += 512 + Math.ceil(size / 512) * 512;
    }

    throw new Error(`File ${targetPath} not found in package`);
  }
}
