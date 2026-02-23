# Structural Error Handling Issues

This document details the high-priority structural error handling issues that require coordinated changes across the Rust ↔ TypeScript boundary. These issues cannot be fixed independently and require protocol/API modifications.

---

## Issue 3: RwLock Poisoning Panics

**Status**: High Priority  
**Category**: Rust Error Propagation  
**Impact**: WASM module crash on any lock poisoning  
**Complexity**: Medium (requires error protocol extension)

### Current State
Multiple locations in `src/lib.rs` use `.expect()` on RwLock operations:

```rust
// src/lib.rs:77-79
self.sources
    .write()
    .expect("Failed to acquire write lock on sources")
    .insert(id, source);

// src/lib.rs:86-88  
self.files
    .write()
    .expect("Failed to acquire write lock on files")
    .insert(id, bytes.clone());

// src/lib.rs:147
.expect("Failed to acquire read lock on sources")

// src/lib.rs:158-160
self.sources
    .write()
    .expect("Failed to acquire write lock on sources")

// src/lib.rs:167
.expect("Failed to acquire read lock on files")

// src/lib.rs:190-192
self.files
    .write()
    .expect("Failed to acquire write lock on files")
```

RwLock poisoning occurs when a thread panics while holding a lock. In WASM, this crashes the entire worker thread.

### Why This Matters

1. **Silent Failures Become Crashes**: Any panic in the WASM module terminates the Web Worker
2. **No Recovery Path**: Once poisoned, the compiler instance is unusable and must be recreated
3. **Poor User Experience**: Users see "Script error" in console with no actionable information
4. **Resource Leaks**: The Worker cannot be properly cleaned up after a panic

### Required Changes

#### Rust Side (`src/lib.rs`)

1. **Add error variant to CompileOutput**:
```rust
#[derive(Tsify, Serialize, Deserialize)]
#[tsify(into_wasm_abi, from_wasm_abi)]
pub struct CompileOutput {
    pub success: bool,
    pub svg: Option<String>,
    pub diagnostics: Vec<WasmDiagnostic>,
    pub internal_error: Option<String>, // NEW: For lock poisoning and other internal errors
}
```

2. **Replace all `.expect()` calls with error handling**:
```rust
// Instead of:
.expect("Failed to acquire write lock on sources")

// Use:
.map_err(|_| "Internal error: Source cache corrupted".to_string())?
```

3. **Modify all public methods to return Result types**:
```rust
pub fn add_source(&mut self, path: &str, text: &str) -> Result<(), String>
pub fn add_file(&mut self, path: &str, data: &[u8]) -> Result<(), String>
pub fn compile(&mut self) -> Result<CompileOutput, String>
```

#### TypeScript Side (`src/worker.ts`, `src/index.ts`)

1. **Update Worker message handling**:
```typescript
// src/worker.ts:89
try {
    const result = compiler.compile();
    postMessage("compiled", {
        svg: result.svg ?? "",
        diagnostics: result.diagnostics,
        internalError: result.internal_error, // NEW
    });
} catch (err) {
    postMessage("compile_error", {
        error: err instanceof Error ? err.message : String(err),
        diagnostics: [],
        internalError: true, // NEW: Flag for unrecoverable errors
    });
}
```

2. **Update CompileResult interface**:
```typescript
// src/index.ts:33-37
export interface CompileResult {
  success: boolean;
  svg?: string;
  diagnostics: WasmDiagnostic[];
  internalError?: string; // NEW
  recoverable: boolean; // NEW: false if compiler instance must be recreated
}
```

3. **Handle unrecoverable errors in TypstCompiler**:
```typescript
// src/index.ts:141-161
private async handleMessage(e: MessageEvent) {
    const data = e.data as WorkerToMainMessage;

    switch (data.kind) {
        case "compiled":
            if (data.payload.internalError) {
                // Mark compiler as needing recreation
                this.needsRecreation = true;
            }
            // ... existing code
        case "compile_error":
            if (!data.payload.recoverable) {
                this.dispose();
            }
            // ... existing code
    }
}
```

### Protocol/API Implications

- **Breaking Change**: `CompileOutput` structure changes
- **Worker Contract**: New message field for internal errors
- **Public API**: `CompileResult` gains new optional fields
- **Behavior Change**: Some errors now require compiler recreation instead of retry

### Implementation Notes

1. **Error Categories**:
   - `InternalError::LockPoisoned` - Cache corruption, requires recreation
   - `InternalError::OutOfMemory` - Memory limit hit, may recover
   - `InternalError::InvalidState` - Compiler in unexpected state

2. **Migration Path**:
   ```typescript
   // Old code continues to work (backward compatible)
   const result = await compiler.compile({...});
   if (!result.success) {
       // Still works
   }
   
   // New code can check for unrecoverable errors
   if (result.internalError && !result.recoverable) {
       compiler = new TypstCompiler({...}); // Recreate
   }
   ```

3. **Testing Requirements**:
   - Force lock poisoning in tests (spawn thread that panics with lock held)
   - Verify error propagation from Rust to TypeScript
   - Test compiler recreation flow

---

## Issue 4: Silent Font Loading Failures

**Status**: High Priority  
**Category**: Rust Error Propagation  
**Impact**: Invalid fonts fail silently, no debugging info  
**Complexity**: Low-Medium (requires method signature change)

### Current State

In `src/lib.rs`:

```rust
// Lines 65-71
pub fn add_font(&mut self, data: &[u8]) {
    let bytes = Bytes::new(data.to_vec());
    if let Some(font) = Font::iter(bytes).next() {
        self.fonts.push(font);
        self.font_book = LazyHash::new(FontBook::from_fonts(&self.fonts));
    }
    // Silent return if font parsing fails
}
```

The method returns `()` and silently ignores invalid font data. There's no way to know:
- If the font was actually loaded
- Why it failed (invalid format, corrupted data, unsupported features)
- Which fonts succeeded vs failed

### Why This Matters

1. **Debugging Nightmare**: Users see missing glyphs with no indication fonts failed to load
2. **Partial Failures**: Some fonts may load, others fail, leading to inconsistent rendering
3. **No Validation**: Cannot provide early feedback on font issues
4. **Silent Data Loss**: Font loading errors are completely swallowed

### Required Changes

#### Rust Side (`src/lib.rs`)

1. **Change return type to Result**:
```rust
pub fn add_font(&mut self, data: &[u8]) -> Result<String, String> {
    let bytes = Bytes::new(data.to_vec());
    match Font::iter(bytes).next() {
        Some(font) => {
            let font_name = font.name().unwrap_or("Unknown").to_string();
            self.fonts.push(font);
            self.font_book = LazyHash::new(FontBook::from_fonts(&self.fonts));
            Ok(font_name)
        }
        None => Err("Failed to parse font data: Invalid or unsupported font format".to_string())
    }
}
```

2. **Add font validation method**:
```rust
pub fn validate_font(data: &[u8]) -> Result<(), String> {
    let bytes = Bytes::new(data.to_vec());
    if Font::iter(bytes).next().is_some() {
        Ok(())
    } else {
        Err("Invalid font data".to_string())
    }
}
```

#### TypeScript Side (`src/index.ts`, `src/worker.ts`)

1. **Update loadFonts to handle failures**:
```typescript
// src/index.ts:94-108
private async loadFonts(): Promise<FontLoadResult[]> {
    const results: FontLoadResult[] = [];
    for (const font of this.fonts) {
        try {
            const data = await font.load();
            this.worker.postMessage({
                kind: "load_font",
                payload: { 
                    data,
                    fontName: font.name, // For correlation
                },
            } as MainToWorkerMessage);
            
            // Wait for acknowledgment
            const result = await this.waitForFontLoad();
            results.push({
                font: font.name,
                success: result.success,
                error: result.error,
            });
        } catch (err) {
            results.push({
                font: font.name,
                success: false,
                error: err instanceof Error ? err.message : String(err),
            });
            if (this.debug) {
                console.error(`[TypstCompiler] Failed to load font "${font.name}":`, err);
            }
        }
    }
    return results;
}
```

2. **Add FontLoadResult interface**:
```typescript
// src/index.ts
export interface FontLoadResult {
  font: string;
  success: boolean;
  error?: string;
}

export interface TypstCompilerOptions {
  wasmUrl: string;
  debug?: boolean;
  fonts?: Font[];
  onFontLoad?: (result: FontLoadResult) => void; // NEW: Optional callback for each font
}
```

3. **Update Worker to return font load results**:
```typescript
// src/worker.ts:103-113
case "load_font":
    if (!compiler) {
        postMessage("font_error", {
            fontName: data.payload.fontName,
            error: "Compiler not initialised"
        });
        return;
    }
    try {
        const fontName = compiler.add_font(data.payload.data);
        postMessage("font_loaded", {
            fontName: fontName ?? data.payload.fontName,
            success: true,
        });
    } catch (err) {
        postMessage("font_error", {
            fontName: data.payload.fontName,
            error: err instanceof Error ? err.message : String(err),
        });
    }
    break;
```

#### TypeScript Types (`src/wasm/typst_wasm.d.ts`)

The generated types will need to be updated or manually patched:

```typescript
// Add to WasmDiagnostic or create new type
export interface FontLoadResult {
    fontName: string;
    success: boolean;
    error?: string;
}
```

### Protocol/API Implications

- **Breaking Change**: `add_font` now returns `Result<String, String>` instead of `()`
- **New Worker Messages**: `font_loaded` and `font_error` message types added
- **Public API**: New optional callback in options for font loading progress
- **Behavior Change**: Font loading is now observable and debuggable

### Implementation Notes

1. **Partial Success Strategy**:
   - By default, compilation should proceed with successfully loaded fonts
   - If all fonts fail, compilation should probably fail (configurable?)
   - Warning diagnostics should be added for missing fonts

2. **Error Context**:
   ```rust
   // Instead of generic error, provide specific reasons
   Err(format!(
       "Failed to parse font '{}': {}. Font may be corrupted or in an unsupported format.",
       font_name,
       parse_error_details
   ))
   ```

3. **Font Validation Before Compilation**:
   ```typescript
   // Add validation method to public API
   async validateFonts(fonts: Font[]): Promise<FontLoadResult[]> {
       // Load and validate each font without adding to compiler
       // Returns detailed diagnostics
   }
   ```

4. **Testing Requirements**:
   - Test with invalid/corrupted font data
   - Test with valid but unsupported fonts (e.g., bitmap fonts)
   - Test partial success scenarios
   - Verify error messages are helpful

---

## Issue 5: Main File Not Validated

**Status**: High Priority  
**Category**: Rust Error Propagation  
**Impact**: Panic instead of graceful error when main not set  
**Complexity**: Medium (requires World trait error handling change)

### Current State

In `src/lib.rs`:

```rust
// Lines 138-141
fn main(&self) -> FileId {
    self.main_id
        .expect("main() called before set_main() - this is a bug in the compiler usage")
}
```

This is required by Typst's `World` trait. When `compile()` is called without `set_main()` being called first, it panics with an unhelpful message.

### Why This Matters

1. **Panic on User Error**: If a user forgets to specify mainPath, the whole worker crashes
2. **Poor Developer Experience**: Error message is cryptic for end users
3. **No Validation**: Can't catch this error early in the API layer
4. **Recovery Impossible**: Worker must be recreated after panic

### Required Changes

#### Rust Side (`src/lib.rs`)

1. **Add internal error state**:
```rust
pub struct TypstCompiler {
    library: LazyHash<Library>,
    fonts: Vec<Font>,
    font_book: LazyHash<FontBook>,
    sources: RwLock<HashMap<FileId, Source>>,
    files: RwLock<HashMap<FileId, Bytes>>,
    main_id: Option<FileId>,
    last_error: RwLock<Option<String>>, // NEW: Store validation errors
}
```

2. **Implement fallible main()**:
```rust
fn main(&self) -> FileId {
    match self.main_id {
        Some(id) => id,
        None => {
            // This is still called by Typst internals, but we can track the error
            let error_msg = "Compilation failed: No main file specified. Call compiler.set_main(path) before compiling.";
            *self.last_error.write().expect("lock poisoned") = Some(error_msg.to_string());
            
            // Return a dummy FileId that will trigger a FileError::NotFound
            // This is a hack but allows error propagation
            FileId::new(None, VirtualPath::new("__main_not_set__"))
        }
    }
}
```

3. **Validate before compile**:
```rust
pub fn compile(&mut self) -> Result<CompileOutput, String> {
    // Pre-validation
    if self.main_id.is_none() {
        return Err("No main file specified. Call set_main() before compile().".to_string());
    }
    
    // Existing compile logic...
}
```

4. **Alternative: Custom error type**:
```rust
#[derive(Debug)]
pub enum CompilerError {
    NoMainFile,
    InvalidSource { path: String, reason: String },
    LockPoisoned,
}

impl std::fmt::Display for CompilerError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            CompilerError::NoMainFile => write!(f, "No main file specified"),
            CompilerError::InvalidSource { path, reason } => {
                write!(f, "Invalid source '{}': {}", path, reason)
            }
            CompilerError::LockPoisoned => write!(f, "Internal error: Cache corrupted"),
        }
    }
}
```

#### TypeScript Side (`src/index.ts`, `src/worker.ts`)

1. **Add validation to compile() method**:
```typescript
// src/index.ts:114
async compile(options: { 
    mainPath: string; 
    files?: Record<string, Uint8Array>;
    mainSource?: string; // NEW: Alternative to files for simple cases
}): Promise<CompileResult> {
    if (this.disposed) {
        throw new Error("Compiler has been disposed");
    }
    
    // NEW: Validate inputs before sending to worker
    if (!options.mainPath) {
        throw new Error("mainPath is required");
    }
    
    if (options.files && !(options.mainPath in options.files)) {
        throw new Error(`mainPath "${options.mainPath}" not found in files`);
    }
    
    await this.ready();
    // ... rest of implementation
}
```

2. **Handle compilation errors in worker**:
```typescript
// src/worker.ts:77-102
case "compile":
    if (!compiler) {
        postMessage("compile_error", { 
            error: "Compiler not initialised",
            errorCode: "NOT_INITIALIZED"
        });
        return;
    }
    
    try {
        // Set main file
        if (!data.payload.mainPath) {
            postMessage("compile_error", {
                error: "mainPath is required",
                errorCode: "MISSING_MAIN_PATH"
            });
            return;
        }
        
        compiler.set_main(data.payload.mainPath);
        
        // Add files
        if (!data.payload.files || Object.keys(data.payload.files).length === 0) {
            postMessage("compile_error", {
                error: "At least one file is required",
                errorCode: "NO_FILES"
            });
            return;
        }
        
        // Compile
        const result = compiler.compile();
        
        if (result.internal_error) {
            postMessage("compile_error", {
                error: result.internal_error,
                errorCode: "INTERNAL_ERROR",
                recoverable: false,
            });
        } else {
            postMessage("compiled", {
                svg: result.svg ?? "",
                diagnostics: result.diagnostics,
            });
        }
    } catch (err) {
        // ... existing error handling
    }
    break;
```

3. **Add error codes to CompileResult**:
```typescript
// src/index.ts:33-43
export interface CompileResult {
  success: boolean;
  svg?: string;
  diagnostics: WasmDiagnostic[];
  error?: string;
  errorCode?: CompileErrorCode;
  recoverable?: boolean;
}

export type CompileErrorCode = 
  | "NOT_INITIALIZED"
  | "MISSING_MAIN_PATH"
  | "NO_FILES"
  | "INTERNAL_ERROR"
  | "LOCK_POISONED"
  | "COMPILATION_FAILED";
```

### Protocol/API Implications

- **Breaking Change**: `compile()` now returns `Result<CompileOutput, String>` in Rust
- **Public API**: New validation errors thrown before Worker communication
- **Worker Contract**: New error code field for programmatic error handling
- **Behavior Change**: Invalid inputs are caught early, before WASM is invoked

### Implementation Notes

1. **Validation Strategy**:
   - TypeScript layer: Basic input validation (mainPath exists, files provided)
   - Rust layer: Deep validation (mainPath in sources, all referenced files resolvable)
   - Worker layer: Pre-compile validation to avoid panics

2. **Error Recovery**:
   ```typescript
   try {
       const result = await compiler.compile({ mainPath: "", files: {} });
   } catch (err) {
       if (err instanceof CompilerValidationError) {
           // Fix inputs and retry
           await compiler.compile({ mainPath: "main.typ", files: { "main.typ": data } });
       }
   }
   ```

3. **Testing Requirements**:
   - Test compile() without calling set_main() first
   - Test with empty mainPath
   - Test with mainPath not in files
   - Test with null/undefined files
   - Verify graceful error messages (no panics)

---

## Issue 8: Worker Message Type Discrimination Uses `any`

**Status**: High Priority  
**Category**: TypeScript Type Safety  
**Impact**: Loss of type safety on error handling path  
**Complexity**: Low (purely TypeScript types)

### Current State

In `src/index.ts`:

```typescript
// Lines 52-53
private compileResolver: ((result: CompileResult) => void) | null = null;
private compileRejecter: ((err: any) => void) | null = null;  // <-- Problem: 'any' type
```

In `src/worker.ts`:

```typescript
// Lines 97-100
catch (err) {
    console.error(err);
    postMessage("compile_error", {
        error: JSON.stringify(err),  // Loses type info
        diagnostics: [],
    });
}
```

The `any` type allows anything to be passed as an error, losing:
- Type checking at compile time
- IntelliSense/autocomplete in IDEs
- Documentation of what errors can occur

### Why This Matters

1. **No Type Safety**: Any value can be passed as an error
2. **Poor DX**: Developers don't know what error properties to expect
3. **Runtime Surprises**: `JSON.stringify()` on Error objects produces `{}`
4. **Inconsistent Handling**: Some errors have `.message`, others don't

### Required Changes

#### TypeScript Types

1. **Define structured error interface**:
```typescript
// src/index.ts or new file src/errors.ts

export interface CompileError {
  message: string;
  code: CompileErrorCode;
  recoverable: boolean;
  cause?: Error;
  diagnostics?: WasmDiagnostic[];
  stack?: string;
}

export type CompileErrorCode =
  | "COMPILATION_FAILED"
  | "WORKER_ERROR"
  | "INTERNAL_ERROR"
  | "NOT_INITIALIZED"
  | "MISSING_MAIN_PATH"
  | "NO_FILES"
  | "DISPOSED"
  | "TIMEOUT";
```

2. **Update CompileResult to use proper error type**:
```typescript
// src/index.ts:33-50
export interface CompileResult {
  success: boolean;
  svg?: string;
  diagnostics: WasmDiagnostic[];
  error?: CompileError;
}
```

3. **Update compiler promise handlers**:
```typescript
// src/index.ts:52-57
private compileResolver: ((result: CompileResult) => void) | null = null;
private compileRejecter: ((error: CompileError) => void) | null = null;

// src/index.ts:124-135
return new Promise((resolve, reject) => {
    this.compileResolver = resolve;
    this.compileRejecter = (error: CompileError) => {
        // Create proper error instance
        const err = new Error(error.message);
        (err as any).code = error.code;
        (err as any).recoverable = error.recoverable;
        (err as any).diagnostics = error.diagnostics;
        reject(err);
    };
    // ...
});
```

4. **Update Worker error messages**:
```typescript
// src/worker.ts
export type WorkerToMainMessage =
  | {
      kind: "compiled";
      payload: {
        svg: string;
        diagnostics: WasmDiagnostic[];
      };
    }
  | {
      kind: "compile_error";
      payload: {
        error: CompileError;  // Structured instead of string
      };
    }
  // ... other messages
```

5. **Create error factory functions**:
```typescript
// src/errors.ts
export function createCompileError(
  message: string,
  code: CompileErrorCode,
  options?: {
    recoverable?: boolean;
    cause?: Error;
    diagnostics?: WasmDiagnostic[];
  }
): CompileError {
  return {
    message,
    code,
    recoverable: options?.recoverable ?? true,
    cause: options?.cause,
    diagnostics: options?.diagnostics,
    stack: options?.cause?.stack,
  };
}

// Usage in worker
postMessage("compile_error", {
    error: createCompileError(
        "Compiler not initialized",
        "NOT_INITIALIZED",
        { recoverable: false }
    )
});
```

6. **Update error serialization in Worker**:
```typescript
// src/worker.ts:95-102
catch (err) {
    console.error("[Worker] Compilation failed:", err);
    
    let compileError: CompileError;
    
    if (err instanceof Error) {
        compileError = createCompileError(
            err.message,
            "COMPILATION_FAILED",
            { 
                recoverable: true,
                cause: err,
            }
        );
    } else {
        compileError = createCompileError(
            String(err),
            "WORKER_ERROR",
            { recoverable: true }
        );
    }
    
    postMessage("compile_error", { error: compileError });
}
```

### Protocol/API Implications

- **Breaking Change**: `compile_error` message payload changes from `{ error: string, diagnostics: [] }` to `{ error: CompileError }`
- **Public API**: `compile()` now rejects with proper Error instances
- **Type Safety**: Full compile-time checking of error handling
- **Better DX**: Error codes enable programmatic error handling

### Implementation Notes

1. **Backward Compatibility**:
   ```typescript
   // Can still access error.message
   try {
       await compiler.compile({...});
   } catch (err) {
       console.error(err.message); // Works as before
       
       // New: Can check error code
       if ((err as any).code === "NOT_INITIALIZED") {
           // Handle specific error
       }
   }
   ```

2. **Error Categories**:
   - **Recoverable**: Temporary issues, retry may succeed (network timeout)
   - **Unrecoverable**: Requires recreation or user action (lock poisoned, disposed)
   - **Validation**: Input errors, fix and retry (missing main file)

3. **Testing Requirements**:
   - Verify type checking catches misuse
   - Test error serialization round-trip
   - Ensure stack traces preserved when available
   - Test with various error types (Error, string, object, null)

---

## Issue 15: Package Fetch No Retry Logic

**Status**: High Priority  
**Category**: Network Resilience  
**Impact**: Transient network failures crash compilation  
**Complexity**: Medium (requires retry strategy + configuration)

### Current State

In `src/package-manager.ts`:

```typescript
// Lines 47-51
const url = `https://packages.typst.org/${spec.namespace}/${spec.name}-${spec.version}.tar.gz`;
const response = await fetch(url);
if (!response.ok) {
    throw new Error(`Failed to fetch package: ${url}`);
}
```

Single attempt with immediate failure on:
- Network timeouts
- 5xx server errors (temporary)
- DNS resolution failures
- Connection reset

### Why This Matters

1. **Flaky Networks**: Mobile/wifi connections have transient failures
2. **CDN Issues**: packages.typst.org may have temporary outages
3. **Rate Limiting**: May hit rate limits, need backoff
4. **Poor UX**: Single failure forces user to restart entire compilation

### Required Changes

#### TypeScript Package Manager (`src/package-manager.ts`)

1. **Add retry configuration**:
```typescript
// src/package-manager.ts

export interface PackageManagerOptions {
  maxRetries?: number;
  retryDelay?: number; // Base delay in ms
  maxRetryDelay?: number; // Cap on exponential backoff
  retryMultiplier?: number; // Exponential multiplier
  retryableStatusCodes?: number[]; // Which HTTP status codes to retry
}

export class PackageManager {
  private cache: CacheStorage;
  private loadedPackages = new Set<string>();
  private options: Required<PackageManagerOptions>;
  
  constructor(options: PackageManagerOptions = {}) {
    this.cache = createCacheStorage();
    this.options = {
      maxRetries: options.maxRetries ?? 3,
      retryDelay: options.retryDelay ?? 1000,
      maxRetryDelay: options.maxRetryDelay ?? 30000,
      retryMultiplier: options.retryMultiplier ?? 2,
      retryableStatusCodes: options.retryableStatusCodes ?? [408, 429, 500, 502, 503, 504],
    };
  }
}
```

2. **Implement fetch with retry**:
```typescript
// src/package-manager.ts

private async fetchWithRetry(url: string, attempt: number = 0): Promise<Response> {
    try {
        const response = await fetch(url);
        
        // Success or non-retryable error
        if (response.ok || !this.options.retryableStatusCodes.includes(response.status)) {
            return response;
        }
        
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    } catch (err) {
        const isRetryable = this.isRetryableError(err);
        
        if (!isRetryable || attempt >= this.options.maxRetries) {
            throw new PackageFetchError(
                `Failed to fetch package after ${attempt + 1} attempts`,
                { 
                    url, 
                    attempts: attempt + 1,
                    lastError: err instanceof Error ? err.message : String(err),
                }
            );
        }
        
        // Calculate delay with exponential backoff
        const delay = Math.min(
            this.options.retryDelay * Math.pow(this.options.retryMultiplier, attempt),
            this.options.maxRetryDelay
        );
        
        // Add jitter to prevent thundering herd
        const jitter = Math.random() * 1000;
        const totalDelay = delay + jitter;
        
        console.log(`[PackageManager] Retrying fetch in ${totalDelay}ms (attempt ${attempt + 2}/${this.options.maxRetries + 1})`);
        await new Promise(resolve => setTimeout(resolve, totalDelay));
        
        return this.fetchWithRetry(url, attempt + 1);
    }
}

private isRetryableError(err: unknown): boolean {
    if (!(err instanceof Error)) return false;
    
    const retryableMessages = [
        'timeout',
        'network',
        'connection',
        'reset',
        'econnrefused',
        'etimedout',
        'econnreset',
    ];
    
    const msg = err.message.toLowerCase();
    return retryableMessages.some(pattern => msg.includes(pattern));
}
```

3. **Update loadPackage to use retry**:
```typescript
// src/package-manager.ts:43-66
private async loadPackage(spec: PackageSpec): Promise<void> {
    const packageKey = this.getPackageKey(spec);
    
    try {
        const url = `https://packages.typst.org/${spec.namespace}/${spec.name}-${spec.version}.tar.gz`;
        const response = await this.fetchWithRetry(url);
        
        // Use nanotar to decompress AND parse in one step
        const tarData = new Uint8Array(await response.arrayBuffer());
        const files = await parseTarGzip(tarData);
        
        // Store all files in cache
        for (const file of files) {
            if (file.type === "file") {
                const cacheKey = this.getFileCacheKey(spec, file.name);
                await this.cache.set(cacheKey, file.data);
            }
        }
        
        this.loadedPackages.add(packageKey);
    } catch (err) {
        // Clean up any partial cache entries
        await this.cleanupPartialPackage(spec);
        throw err;
    }
}

private async cleanupPartialPackage(spec: PackageSpec): Promise<void> {
    // Remove any cached files for this package to prevent corruption
    // Implementation depends on cache interface
}
```

4. **Add PackageFetchError class**:
```typescript
// src/package-manager.ts or src/errors.ts

export class PackageFetchError extends Error {
  readonly url: string;
  readonly attempts: number;
  readonly lastError: string;
  readonly code: string;
  
  constructor(
    message: string,
    details: { url: string; attempts: number; lastError: string }
  ) {
    super(message);
    this.name = 'PackageFetchError';
    this.url = details.url;
    this.attempts = details.attempts;
    this.lastError = details.lastError;
    this.code = 'PACKAGE_FETCH_FAILED';
  }
}
```

5. **Add timeout to fetch**:
```typescript
// src/package-manager.ts

private async fetchWithTimeout(url: string, timeoutMs: number = 30000): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    
    try {
        const response = await fetch(url, { signal: controller.signal });
        return response;
    } catch (err) {
        if (err instanceof Error && err.name === 'AbortError') {
            throw new Error(`Request timeout after ${timeoutMs}ms`);
        }
        throw err;
    } finally {
        clearTimeout(timeout);
    }
}
```

6. **Expose options in public API**:
```typescript
// src/index.ts

export interface TypstCompilerOptions {
  wasmUrl: string;
  debug?: boolean;
  fonts?: Font[];
  packageManager?: PackageManagerOptions; // NEW
}

// Constructor usage
constructor(options: TypstCompilerOptions) {
    // ... existing code
    this.packageManager = new PackageManager(options.packageManager);
}
```

### Protocol/API Implications

- **New Public API**: PackageManagerOptions added to TypstCompilerOptions
- **New Error Type**: PackageFetchError provides detailed failure info
- **Behavior Change**: Failed fetches now retry automatically with backoff
- **Configuration**: Users can customize retry behavior

### Implementation Notes

1. **Default Behavior**:
   - 3 retries maximum
   - 1s initial delay, doubling each retry
   - 30s max delay between retries
   - 30s timeout per request

2. **Retryable Conditions**:
   - HTTP 408, 429, 500, 502, 503, 504
   - Network errors (timeout, reset, refused)
   - DNS failures
   - Non-retryable: 400, 401, 403, 404 (client errors)

3. **Cancellation Support**:
   ```typescript
   // Allow users to cancel ongoing fetches
   const controller = new AbortController();
   const compiler = new TypstCompiler({
       packageManager: { abortSignal: controller.signal }
   });
   
   // Cancel all in-flight package fetches
   controller.abort();
   ```

4. **Testing Requirements**:
   - Test with simulated network failures
   - Verify exponential backoff timing
   - Test non-retryable errors (404 should fail fast)
   - Test cancellation
   - Verify partial package cleanup

---

## Issue 16: Compile Errors Don't Include Stack Traces

**Status**: High Priority  
**Category**: Debugging & Observability  
**Impact**: Rust panics become opaque, impossible to debug  
**Complexity**: Medium (requires Rust panic hook + protocol change)

### Current State

In `src/worker.ts`:

```typescript
// Lines 95-102
catch (err) {
    console.error(err);
    postMessage("compile_error", {
        error: JSON.stringify(err),  // Problem: Loses stack trace
        diagnostics: [],
    });
}
```

Rust panics in the WASM module are caught as generic objects. `JSON.stringify(err)` on a Rust panic produces `{}` or `null`, losing all context.

### Why This Matters

1. **Debugging Nightmare**: "Script error" in console with no stack trace
2. **Production Issues**: Can't diagnose crashes in deployed applications
3. **Development Friction**: No line numbers or context for Rust errors
4. **Silent Failures**: Errors appear empty when logged

### Required Changes

#### Rust Side (`src/lib.rs`)

1. **Set up panic hook**:
```rust
// Add to src/lib.rs

use std::panic;

#[wasm_bindgen(start)]
pub fn init_panic_hook() {
    panic::set_hook(Box::new(|info| {
        // Capture panic info
        let message = if let Some(s) = info.payload().downcast_ref::<&str>() {
            s.to_string()
        } else if let Some(s) = info.payload().downcast_ref::<String>() {
            s.clone()
        } else {
            "Unknown panic".to_string()
        };
        
        let location = info.location()
            .map(|loc| format!("{}:{}", loc.file(), loc.line()))
            .unwrap_or_else(|| "unknown location".to_string());
        
        // Store in a global for retrieval
        LAST_PANIC.with(|cell| {
            *cell.borrow_mut() = Some(PanicInfo {
                message,
                location,
                backtrace: capture_backtrace(),
            });
        });
        
        // Log to console via web-sys
        web_sys::console::error_1(&format!("Rust panic: {} at {}", message, location).into());
    }));
}

thread_local! {
    static LAST_PANIC: std::cell::RefCell<Option<PanicInfo>> = std::cell::RefCell::new(None);
}

#[derive(Clone, Debug)]
struct PanicInfo {
    message: String,
    location: String,
    backtrace: Vec<String>,
}

fn capture_backtrace() -> Vec<String> {
    // In WASM, full backtraces are limited but we can capture what we can
    // This requires std::backtrace feature which may not be available in all WASM targets
    vec![] // Placeholder - implement based on target capabilities
}

#[wasm_bindgen]
pub fn get_last_panic() -> Option<JsValue> {
    LAST_PANIC.with(|cell| {
        cell.borrow().as_ref().map(|info| {
            serde_wasm_bindgen::to_value(info).unwrap()
        })
    })
}

#[wasm_bindgen]
pub fn clear_last_panic() {
    LAST_PANIC.with(|cell| {
        *cell.borrow_mut() = None;
    });
}
```

2. **Modify compile to check for panics**:
```rust
// src/lib.rs:96-118
pub fn compile(&mut self) -> CompileOutput {
    // Clear any previous panic
    clear_last_panic();
    
    // Use catch_unwind to capture panics
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        typst::compile(self)
    }));
    
    match result {
        Ok(compilation_result) => {
            // Normal result handling...
            let diagnostics = format_diagnostics(self, &compilation_result);
            // ... rest of logic
        }
        Err(_) => {
            // A panic occurred
            let panic_info = get_last_panic();
            CompileOutput {
                success: false,
                svg: None,
                diagnostics: vec![],
                internal_error: Some(format!(
                    "Internal compiler error: {}",
                    panic_info.as_ref()
                        .and_then(|p: &JsValue| p.as_string())
                        .unwrap_or_else(|| "Unknown error".to_string())
                )),
                panic_info: panic_info.map(|p| serde_wasm_bindgen::from_value(p).unwrap()),
            }
        }
    }
}
```

3. **Update CompileOutput to include panic info**:
```rust
#[derive(Tsify, Serialize, Deserialize)]
#[tsify(into_wasm_abi, from_wasm_abi)]
pub struct CompileOutput {
    pub success: bool,
    pub svg: Option<String>,
    pub diagnostics: Vec<WasmDiagnostic>,
    pub internal_error: Option<String>,
    pub panic_info: Option<WasmPanicInfo>, // NEW
}

#[derive(Tsify, Serialize, Deserialize)]
#[tsify(into_wasm_abi, from_wasm_abi)]
pub struct WasmPanicInfo {
    pub message: String,
    pub location: String,
    pub backtrace: Vec<String>,
}
```

#### TypeScript Side (`src/worker.ts`, `src/index.ts`)

1. **Update Worker to extract full error info**:
```typescript
// src/worker.ts:77-102
case "compile":
    if (!compiler) {
        postMessage("compile_error", {
            error: createCompileError(
                "Compiler not initialized",
                "NOT_INITIALIZED",
                { recoverable: false }
            ),
        });
        return;
    }
    
    try {
        compiler.set_main(data.payload.mainPath);
        
        for (const [path, fileData] of Object.entries(data.payload.files)) {
            compiler.add_file(path, fileData);
        }
        
        const result = compiler.compile();
        
        if (result.panic_info) {
            // A panic occurred
            postMessage("compile_error", {
                error: createCompileError(
                    `Internal compiler error: ${result.panic_info.message}`,
                    "INTERNAL_ERROR",
                    {
                        recoverable: false,
                        cause: new Error(result.panic_info.message),
                        stack: [
                            `at ${result.panic_info.location}`,
                            ...result.panic_info.backtrace,
                        ].join('\n'),
                    }
                ),
            });
        } else if (!result.success) {
            postMessage("compile_error", {
                error: createCompileError(
                    "Compilation failed",
                    "COMPILATION_FAILED",
                    {
                        recoverable: true,
                        diagnostics: result.diagnostics,
                    }
                ),
            });
        } else {
            postMessage("compiled", {
                svg: result.svg ?? "",
                diagnostics: result.diagnostics,
            });
        }
    } catch (err) {
        // This catches non-panic errors (e.g., JS errors)
        console.error("[Worker] Unexpected error:", err);
        
        postMessage("compile_error", {
            error: createCompileError(
                err instanceof Error ? err.message : String(err),
                "WORKER_ERROR",
                {
                    recoverable: true,
                    cause: err instanceof Error ? err : undefined,
                    stack: err instanceof Error ? err.stack : undefined,
                }
            ),
        });
    }
    break;
```

2. **Update CompileError interface**:
```typescript
// src/errors.ts
export interface CompileError {
  message: string;
  code: CompileErrorCode;
  recoverable: boolean;
  cause?: Error;
  diagnostics?: WasmDiagnostic[];
  stack?: string;  // Full stack trace
  rustLocation?: string; // NEW: Rust file:line where error occurred
  rustBacktrace?: string[]; // NEW: Rust backtrace if available
}
```

3. **Preserve stack traces in error handling**:
```typescript
// src/index.ts:124-135
return new Promise((resolve, reject) => {
    this.compileResolver = resolve;
    this.compileRejecter = (error: CompileError) => {
        const err = new Error(error.message);
        err.name = 'CompileError';
        
        // Preserve all error metadata
        (err as any).code = error.code;
        (err as any).recoverable = error.recoverable;
        (err as any).diagnostics = error.diagnostics;
        (err as any).rustLocation = error.rustLocation;
        (err as any).rustBacktrace = error.rustBacktrace;
        
        // Build combined stack trace
        if (error.stack) {
            err.stack = `${err.message}\n${error.stack}`;
        }
        
        reject(err);
    };
    // ...
});
```

4. **Add error formatting utilities**:
```typescript
// src/errors.ts

export function formatCompileError(err: CompileError): string {
    let output = `[${err.code}] ${err.message}`;
    
    if (err.rustLocation) {
        output += `\n  at ${err.rustLocation}`;
    }
    
    if (err.rustBacktrace && err.rustBacktrace.length > 0) {
        output += '\n\nRust backtrace:';
        err.rustBacktrace.forEach((frame, i) => {
            output += `\n  ${i}: ${frame}`;
        });
    }
    
    if (err.stack) {
        output += `\n\nJavaScript stack:\n${err.stack}`;
    }
    
    if (err.diagnostics && err.diagnostics.length > 0) {
        output += '\n\nTypst diagnostics:\n';
        err.diagnostics.forEach(diag => {
            output += diag.formatted + '\n';
        });
    }
    
    return output;
}
```

### Protocol/API Implications

- **Breaking Change**: `compile_error` payload gains new structured fields
- **Rust API**: New functions `get_last_panic()`, `clear_last_panic()`
- **CompileOutput**: New optional `panic_info` field
- **Better Debugging**: Full stack traces and Rust locations now available

### Implementation Notes

1. **WASM Panic Handling Limitations**:
   - Full backtraces in WASM are challenging
   - `std::backtrace` may not be available in wasm32-unknown-unknown target
   - Focus on getting file:line location from panic hook

2. **Build Configuration**:
   ```toml
   # Cargo.toml
   [profile.release]
   panic = "unwind"  # Required for catch_unwind
   
   [profile.release.wasm-opt]
   # Keep debug symbols for better stack traces
   ```

3. **Development vs Production**:
   ```typescript
   // In debug mode, include full backtraces
   const compiler = new TypstCompiler({
       debug: true, // Enables full panic info
   });
   
   // In production, just include message and location
   ```

4. **Testing Requirements**:
   - Force Rust panic in test (e.g., divide by zero)
   - Verify panic info is captured
   - Test that subsequent compilations work after panic
   - Verify stack trace quality in different scenarios

---

## Summary: Implementation Order

### Phase 1: Foundation (Start Here)
1. **Issue 8** - Define structured error types (CompileError interface)
2. **Issue 16** - Add Rust panic hook and capture infrastructure

### Phase 2: Rust Error Propagation
3. **Issue 3** - Replace RwLock `.expect()` with error handling
4. **Issue 5** - Validate main file before compile, return proper errors
5. **Issue 4** - Make add_font return Result with error details

### Phase 3: TypeScript Integration
6. **Issue 16 (cont)** - Wire up panic info to CompileError
7. **Issue 15** - Add retry logic to PackageManager

### Dependencies
- Issue 8 (types) → All other issues (use the types)
- Issue 16 (panic hook) → Issue 3, 5, 4 (capture their errors)
- Issue 3, 4, 5 (Rust changes) → TypeScript message handling updates

### Testing Strategy
1. Unit test each Rust error path individually
2. Integration test full error propagation chain
3. Test panic recovery (can compiler be reused after panic?)
4. Test network retry logic with simulated failures
5. Verify error messages are helpful and actionable
