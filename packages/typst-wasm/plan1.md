Here is the comprehensive plan to implement the Polymorphic Typst Runtime.
1. Core Architecture
The complexity of environment detection and blocking logic is moved entirely to JavaScript. The Rust binary is compiled once and remains "dumb," expecting only a synchronous host_fetch import.
The Components
1.  Rust Core (src/lib.rs): Standard wasm-bindgen definitions. No manual memory management or threading logic.
2.  Communication Buffer (SharedArrayBuffer): A growable SharedArrayBuffer used solely for transferring file data from Main -> Worker. It allows the Main thread to "hand over" data while the Worker is blocked via Atomics.wait().
3.  Main Thread (src/index.ts): Orchestrates the fetch, handles buffer growth, and unblocks the worker.
4.  Worker Thread (src/worker.ts): Runs the Wasm. Intercepts the host_fetch call, blocks the thread, and reads the response.
---
2. Implementation Steps
Step 1: Purify Rust Core (src/lib.rs)
Goal: Remove all threading and manual memory logic.
*   Remove: ResourceRequest struct, BRIDGE static, init_bridge function, and all Atomics imports.
*   Define:
        #[link(wasm_import_module = "bridge")]
    extern "C" {
        // Returns a pointer to the result data and its length
        // On error, returns null pointer and length contains error code
        fn host_fetch(path_ptr: *const u8, path_len: u32, result_len: *mut u32) -> *const u8;
    }
    
    Note: Using raw extern "C" with #[link(wasm_import_module = ...)] is required for JSPI 
    compatibility, as JSPI wraps raw WASM imports. wasm_bindgen extern blocks generate 
    JS glue code that would interfere with JSPI's Suspending wrapper.
    
*   Update: ResourceBridge::request_file to call host_fetch and reconstruct the Vec<u8> from the raw pointer.
Step 2: Define Communication Protocol (src/protocol.ts)
Goal: Create a shared definition for the memory layout to avoid magic numbers.
*   Create a simple TS file to export constants.
    *   STATUS_INT32_INDEX = 0 (index into Int32Array, byte offset 0)
    *   SIZE_UINT32_INDEX = 1 (index into Uint32Array, byte offset 4)
    *   DATA_BYTE_OFFSET = 8
    *   STATUS_PENDING = 0
    *   STATUS_OK = 1
    *   STATUS_ERROR = 2
    
    Important: Atomics.wait() and Atomics.notify() take an INDEX into the typed array, 
    not a byte offset. For Int32Array, the index is byte_offset / 4.
Step 3: Implement Main Thread Controller (src/index.ts)
Goal: Manage the Communication Buffer and perform the actual fetching.
*   Initialization:
    *   Create a growable SharedArrayBuffer for communication:
        // Initial 1MB, can grow up to 64MB
        const INITIAL_SIZE = 1024 * 1024;
        const MAX_SIZE = 64 * 1024 * 1024;
        communicationBuffer = new SharedArrayBuffer(INITIAL_SIZE, { maxByteLength: MAX_SIZE });
        
        Note: This is a growable SharedArrayBuffer (ES2024 feature), NOT a WebAssembly.Memory.
        WebAssembly.Memory.grow() operates in 64KB pages and replaces the underlying ArrayBuffer,
        detaching all existing views. A growable SharedArrayBuffer retains the same object reference
        and views remain valid after growth.
        
    *   Pass communicationBuffer to the Worker during initialization.
*   Request Handling Loop:
    *   Listen for type: 'FETCH_REQUEST'.
    *   Action:
        1.  Run fetch(path).
        2.  Growth Check: If data.byteLength + DATA_BYTE_OFFSET > communicationBuffer.byteLength:
            *   Calculate required size.
            *   Call communicationBuffer.grow(requiredSize).
            *   Note: Unlike WebAssembly.Memory.grow(), SharedArrayBuffer.grow() takes the 
                new total byte length, not a delta. Existing typed array views remain valid.
        3.  Write: Create a Uint8Array view and copy data at DATA_BYTE_OFFSET.
        4.  Header: Write SIZE to the Uint32Array view at index 1 (byte offset 4).
        5.  Signal: 
            *   Create Int32Array view.
            *   Atomics.store(int32View, STATUS_INT32_INDEX, STATUS_OK).
            *   Atomics.notify(int32View, STATUS_INT32_INDEX).
            
            Critical: Atomics.notify takes an index, not a byte offset. STATUS_INT32_INDEX = 0.
Step 4: Implement Worker Adapter (src/worker.ts)
Goal: Implement the blocking interface.
*   Initialization: Receive communicationBuffer from Main.
*   Implement hostFetch(path):
    1.  Reset: Atomics.store(int32View, STATUS_INT32_INDEX, STATUS_PENDING).
    2.  Signal: postMessage({ type: 'FETCH_REQUEST', path }).
    3.  Block: Atomics.wait(int32View, STATUS_INT32_INDEX, STATUS_PENDING).
        *   Note: Atomics.wait() blocks the thread until the value at the index changes 
            from STATUS_PENDING, or until timeout (if specified).
    4.  Wake:
        *   Read status from int32View at index 0.
        *   If STATUS_ERROR, throw an error.
        *   Read size from a Uint32Array view at index 1 (byte offset 4).
        *   Important: For growable SharedArrayBuffer, existing views remain valid after 
            growth, but you should still create fresh views after waking to ensure you're 
            reading the current byteLength. The buffer object reference remains the same.
        *   Slice the data: new Uint8Array(communicationBuffer, DATA_BYTE_OFFSET, size).slice()
            (slice() creates a copy, which is what we want to pass to WASM).
    5.  Return: Pass the copied Uint8Array back to Rust via the WASM memory.
*   Bridge Injection: 
    The host_fetch function must write the result into WASM linear memory and return a pointer.
    This requires allocating memory in WASM first. Consider using wasm-bindgen's built-in 
    allocation (__wbindgen_malloc) or exporting an allocator from Rust.
    
    Alternative: Keep the current architecture where Rust does Atomics.wait() directly on 
    its own linear memory (WebAssembly.Memory with shared:true). This is simpler but requires 
    Rust to know about the protocol.
Step 5: Verification
*   Build: Run npm run build to ensure the patcher (scripts/patch_wasm_import.cjs) correctly handles the new import structure.
*   Test: Create/Run test_sanity.js to compile a simple Typst file that imports a dummy file, verifying the full loop.
---
3. Key Technical Corrections

1. SharedArrayBuffer.grow() vs WebAssembly.Memory.grow():
   - SharedArrayBuffer.grow(newByteLength) takes the NEW total size in bytes
   - WebAssembly.Memory.grow(deltaPages) takes the NUMBER OF PAGES to add (each page = 64KB)
   - SharedArrayBuffer growth keeps all existing typed array views valid
   - WebAssembly.Memory growth invalidates all views (buffer is detached/replaced)

2. Atomics methods use INDICES, not byte offsets:
   - Atomics.wait(int32Array, index, expectedValue)
   - Atomics.notify(int32Array, index, count)
   - For Int32Array: index = byteOffset / 4

3. Growable SharedArrayBuffer availability:
   - Requires { maxByteLength: n } in constructor
   - Check with: buffer.growable === true
   - Not available in all environments (check compatibility)

4. The existing architecture uses WebAssembly.Memory with shared:true:
   - This creates a SharedArrayBuffer as the backing store
   - Rust can use Atomics.wait() directly on this memory
   - This is simpler than a separate communication buffer
   - However, WebAssembly.Memory.grow() will invalidate views
