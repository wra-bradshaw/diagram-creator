Strategy B: JSPI (Direct Execution), designed to run alongside the Worker strategy using the same "dumb" Rust binary.
1. The Concept: DirectBackend
Unlike the Worker strategy which delegates execution to a separate thread, the JSPI strategy runs the Wasm directly on the main thread (or the single Cloudflare Worker thread).
*   Import: We wrap the async fetch function with WebAssembly.Suspending. When WASM calls this import, the entire WASM stack is suspended until the Promise resolves.
*   Export: We wrap the WASM entry point with WebAssembly.promising. This transforms the synchronous WASM export into an async function that returns a Promise.
2. Implementation: src/backend_jspi.ts
This file implements the "Direct" backend.
A. The Async Import
We define the standard async fetcher. No Atomics, no SharedMemory.
async function asyncHostFetch(pathPtr: number, pathLen: number, resultLenPtr: number): Promise<number> {
  // Read path from WASM memory
  const pathBytes = new Uint8Array(wasmMemory.buffer, pathPtr, pathLen);
  const path = new TextDecoder().decode(pathBytes);
  
  // Perform async fetch
  const res = await fetch(path);
  if (!res.ok) {
    // Write 0 to resultLenPtr to indicate error
    new Uint32Array(wasmMemory.buffer, resultLenPtr, 1)[0] = 0;
    return 0; // null pointer indicates error
  }
  
  const data = new Uint8Array(await res.arrayBuffer());
  
  // Allocate memory in WASM for the result
  const resultPtr = wasmExports.__wbindgen_malloc(data.length, 1);
  
  // Copy data to WASM memory
  new Uint8Array(wasmMemory.buffer, resultPtr, data.length).set(data);
  
  // Write length to resultLenPtr
  new Uint32Array(wasmMemory.buffer, resultLenPtr, 1)[0] = data.length;
  
  return resultPtr;
}

Note: The function signature must match what Rust expects from the extern "C" import.
This function is async but WASM sees it as synchronous thanks to JSPI.
B. The Loader & Wrapping
JSPI requires wrapping at the WebAssembly level, NOT at the JavaScript wrapper level.
This is the critical distinction from the original plan.
import wasmUrl from './wasm/typst_wasm_bg.wasm?url';

let wasmMemory: WebAssembly.Memory;
let wasmExports: any;

export class JspiBackend {
  private compiler: any;

  async init() {
    // 1. Fetch the WASM binary
    const wasmBytes = await fetch(wasmUrl).then(r => r.arrayBuffer());
    const wasmModule = await WebAssembly.compile(wasmBytes);
    
    // 2. Create shared memory (required for the WASM module)
    wasmMemory = new WebAssembly.Memory({
      initial: 2048,
      maximum: 4096,
      shared: true
    });
    
    // 3. Wrap the async import with Suspending
    // CRITICAL: WebAssembly.Suspending wraps the async function itself
    // @ts-ignore - WebAssembly.Suspending is not in standard TS types yet
    const suspendingFetch = new WebAssembly.Suspending(asyncHostFetch);
    
    // 4. Build the imports object
    // The import names must match what wasm-bindgen generates
    const imports = {
      env: {
        memory: wasmMemory,
      },
      bridge: {
        host_fetch: suspendingFetch,
      },
      // ... other wasm-bindgen imports (from typst_wasm.js)
      // You may need to extract these from the generated JS
    };
    
    // 5. Instantiate with our custom imports
    const instance = await WebAssembly.instantiate(wasmModule, imports);
    wasmExports = instance.exports;
    
    // 6. Wrap exports that may suspend with WebAssembly.promising
    // CRITICAL: This must wrap the RAW WASM export, not a JS wrapper function
    //
    // WebAssembly.promising takes the raw export function and returns
    // a new function that returns a Promise<T> instead of T.
    //
    // @ts-ignore
    const promisingCompile = WebAssembly.promising(wasmExports.compile);
    
    // 7. Now you can call promisingCompile() and it returns a Promise
    // that resolves when the WASM function completes (including any suspensions)
    
    // Store for later use
    this._promisingCompile = promisingCompile;
  }
  
  async compile(source: string): Promise<string> {
    // Call the promising-wrapped export
    // This returns a Promise that resolves when WASM completes
    return await this._promisingCompile(/* args */);
  }
}
C. The Challenge with wasm-bindgen
wasm-bindgen generates a JS wrapper class (TypstCompiler) that internally calls the raw WASM exports. The problem is:

1. TypstCompiler.prototype.compile is a JS function, not a WASM export
2. WebAssembly.promising ONLY works with raw WASM export functions
3. We cannot simply wrap the JS method

Solutions:

Option 1: Bypass wasm-bindgen entirely for JSPI
- Manually instantiate the WASM module
- Call raw exports directly (no nice Rust struct wrappers)
- Most reliable for JSPI

Option 2: Patch the wasm-bindgen output (like patch_wasm_import.cjs)
- Modify the generated JS to:
  a. Accept custom imports including Suspending wrappers
  b. Wrap internal calls to raw exports with promising
- Complex but preserves the nice API

Option 3: Re-export raw functions from Rust
- Add #[wasm_bindgen] exports that are simple functions (not methods)
- These become raw WASM exports that can be wrapped with promising
- Requires Rust changes

Recommended: Option 2 (patching), extended from the existing patcher:

// In patch_wasm_import.cjs, also patch the internal compile call:
// Find where the JS wrapper calls the raw wasm export and wrap it.
//
// The generated code typically looks like:
//   const ret = wasm.typstcompiler_compile(this.__wbg_ptr);
//
// Patch to:
//   const ret = await WebAssembly.promising(wasm.typstcompiler_compile)(this.__wbg_ptr);
//
// And change the method signature to async.
3. The Switch (src/index.ts)
The main entry point acts as the factory.
export async function createCompiler(opts: Options) {
  // Detection Logic
  // @ts-ignore
  const supportsJSPI = typeof WebAssembly.Suspending !== 'undefined';
  const supportsWorkers = typeof Worker !== 'undefined';
  const supportsAtomicsWait = typeof Atomics !== 'undefined' && typeof Atomics.wait === 'function';
  
  if (supportsJSPI && !supportsWorkers) {
    // Cloudflare Workers, Deno Deploy, etc.
    console.log("Booting JSPI Backend (Direct)...");
    const backend = new JspiBackend();
    await backend.init(opts);
    return backend;
  } else if (supportsWorkers && supportsAtomicsWait) {
    // Browser with SharedArrayBuffer support
    console.log("Booting Worker Backend (Atomics)...");
    return new WorkerBackend(opts);
  } else {
    throw new Error("No supported backend available");
  }
}

Note: In browsers, JSPI may be available but Workers+Atomics is usually preferred
because JSPI blocks the main thread during suspension, causing UI freezes.
JSPI is ideal for server-side environments (Cloudflare Workers, Deno) where
there's no UI to freeze.
4. Integration Notes
This JSPI plan requires:

1. Rust changes: The extern "C" import must use raw pointers/primitives, not 
   wasm_bindgen types, because JSPI wraps at the WebAssembly level.

2. Patching changes: Extend patch_wasm_import.cjs to:
   - Handle Suspending imports
   - Wrap raw exports with promising
   - Make affected JS wrapper methods async

3. Same WASM binary: Both backends use the same compiled WASM. The difference
   is how JS provides the host_fetch import:
   - Worker backend: Synchronous function that does Atomics.wait()
   - JSPI backend: Async function wrapped with Suspending
---
5. Key Technical Corrections from Original Plan

1. WebAssembly.promising wraps RAW WASM EXPORTS only:
   - WRONG: new WebAssembly.promising(TypstCompiler.prototype.compile)
   - RIGHT: WebAssembly.promising(wasmInstance.exports.compile)
   
   The original plan attempted to wrap a JS method, which doesn't work.
   JSPI operates at the WebAssembly level, not JavaScript.

2. WebAssembly.Suspending is a constructor:
   - const wrapped = new WebAssembly.Suspending(asyncFn)
   - The wrapped function is passed as a WASM import
   - When WASM calls it, the stack suspends until the Promise resolves

3. WebAssembly.promising is NOT a constructor:
   - const wrapped = WebAssembly.promising(wasmExport)
   - Note: No 'new' keyword
   - Returns a function that returns Promise<T>

4. wasm-bindgen compatibility requires patching:
   - wasm-bindgen generates JS wrappers that hide the raw exports
   - You must either bypass wasm-bindgen or patch the generated code
   - The init() function's import handling may need modification

5. Memory considerations:
   - With JSPI, the WASM memory is not detached during suspension
   - This is simpler than the Atomics approach
   - But you still need to handle memory allocation for return values
