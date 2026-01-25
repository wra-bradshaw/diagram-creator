import init, { init_bridge, TypstCompiler } from "./wasm/typst_wasm.js";

// Bridge struct offsets - must match ResourceRequest layout in lib.rs
const OFFSET_KIND = 8;
const OFFSET_PATH_LEN = 12;
const OFFSET_PATH_DATA = 16;

let wasmMemory: WebAssembly.Memory;
let bridgePtr: number = 0;
let compiler: TypstCompiler | null = null;

self.onmessage = async (e: MessageEvent) => {
    const { type, payload } = e.data;

    switch (type) {
        case 'init':
            await initWasm(payload.wasmUrl);
            break;
        case 'compile':
            if (!compiler) {
                self.postMessage({ type: 'compiled', error: { message: "Compiler not initialized" } });
                return;
            }
            try {
                if (payload.mainPath) {
                    compiler.set_main(payload.mainPath);
                }
                
                if (payload.files) {
                    for (const [path, data] of Object.entries(payload.files)) {
                        compiler.add_file(path, data as Uint8Array);
                    }
                }
                
                const result = compiler.compile();
                self.postMessage({ type: 'compiled', result });
            } catch (err) {
                self.postMessage({ type: 'compiled', error: err });
            }
            break;

    }
};

async function initWasm(wasmUrl: string) {
    wasmMemory = new WebAssembly.Memory({
        initial: 2048, // 128MB
        maximum: 4096, // 256MB
        shared: true
    });

    const imports = {
        env: {
            memory: wasmMemory,
        },
        bridge: {
            notify_host: () => {
                if (!bridgePtr) return;
                
                const view = new DataView(wasmMemory.buffer);
                const ptr = bridgePtr;
                
                const kind = view.getUint32(ptr + OFFSET_KIND, true);
                const pathLen = view.getUint32(ptr + OFFSET_PATH_LEN, true);
                const pathBytes = new Uint8Array(wasmMemory.buffer, ptr + OFFSET_PATH_DATA, pathLen);
                const path = new TextDecoder().decode(pathBytes);

                self.postMessage({
                    type: 'resource_request',
                    payload: { kind, path }
                });
            }
        }
    };

    // @ts-expect-error - The init function accepts custom imports after patching by patch_wasm_import.cjs
    await init(wasmUrl, imports);
    
    // Initialize bridge
    bridgePtr = init_bridge();
    
    compiler = new TypstCompiler();
    
    self.postMessage({ 
        type: 'ready',
        payload: {
            bridgePtr,
            memory: wasmMemory.buffer
        }
    });
}


