# Easy Issues (Isolated Fixes)

This document contains the high-priority issues that can be fixed independently without requiring protocol or API changes. These are isolated fixes that can be implemented one at a time.

---

## Issue 9: Missing await in Worker Error Handler

**Status**: High Priority  
**File**: `src/worker.ts` (lines 79-80)  
**Effort**: 1 line change  
**Risk**: Low

### Problem
The `postMessage` call in the error handler isn't awaited, which could theoretically cause race conditions if the message queue is busy:

```typescript
case "compile":
  if (!compiler) {
    postMessage("compile_error", { error: "Compiler not initialised", diagnostics: [] });
    return;  // No await on postMessage
  }
```

### Fix
Change to synchronous return or ensure proper ordering:

```typescript
case "compile":
  if (!compiler) {
    // postMessage is synchronous in Web Workers, but be explicit
    self.postMessage({
      kind: "compile_error",
      payload: { error: "Compiler not initialised", diagnostics: [] }
    });
    return;
  }
```

### Verification
- Check that error messages arrive before worker continues
- Test with rapid successive compile calls

---

## Issue 11: Package Manager Memory Leak

**Status**: High Priority  
**File**: `src/package-manager.ts` (line 13)  
**Effort**: 5 lines + documentation  
**Risk**: Low

### Problem
The `loadedPackages` Set grows indefinitely and is never cleared:

```typescript
export class PackageManager {
  private cache: CacheStorage;
  private loadedPackages = new Set<string>();  // Never cleaned up
```

In long-running applications (e.g., a web IDE), this accumulates package references over time.

### Fix
Add cleanup method and optional size limit:

```typescript
export interface PackageManagerOptions {
  maxLoadedPackages?: number;  // LRU cache size limit
}

export class PackageManager {
  private cache: CacheStorage;
  private loadedPackages = new Set<string>();
  private packageAccessOrder: string[] = [];  // For LRU
  private options: PackageManagerOptions;

  constructor(options: PackageManagerOptions = {}) {
    this.cache = createCacheStorage();
    this.options = {
      maxLoadedPackages: options.maxLoadedPackages ?? 100,
    };
  }

  /**
   * Clear all loaded package tracking and optionally clear the cache
   */
  clear(keepCache: boolean = true): void {
    this.loadedPackages.clear();
    this.packageAccessOrder = [];
    
    if (!keepCache) {
      // Note: Would need to add clear() method to CacheStorage interface
    }
  }

  private async loadPackage(spec: PackageSpec): Promise<void> {
    // ... existing code ...
    
    this.loadedPackages.add(packageKey);
    this.trackPackageAccess(packageKey);
    
    // Enforce size limit
    if (this.loadedPackages.size > this.options.maxLoadedPackages!) {
      this.evictOldestPackage();
    }
  }

  private trackPackageAccess(packageKey: string): void {
    // Remove from current position if exists
    const index = this.packageAccessOrder.indexOf(packageKey);
    if (index > -1) {
      this.packageAccessOrder.splice(index, 1);
    }
    // Add to end (most recent)
    this.packageAccessOrder.push(packageKey);
  }

  private evictOldestPackage(): void {
    const oldest = this.packageAccessOrder.shift();
    if (oldest) {
      this.loadedPackages.delete(oldest);
    }
  }
}
```

### Verification
- Test that loadedPackages size stays bounded
- Verify LRU eviction removes oldest packages
- Ensure evicted packages can be reloaded

---

## Issue 12: No File Size Limits

**Status**: High Priority  
**File**: `src/protocol.ts` (lines 40-42)  
**Effort**: 3 lines + error message  
**Risk**: Low

### Problem
No maximum size check before growing SharedArrayBuffer:

```typescript
setBuffer(buf: Uint8Array) {
  const needed = buf.byteLength;
  const current = this.dataBuf.byteLength;

  if (needed > current) {
    this.dataBuf.grow(needed);  // Can exceed MAX_SAB_SIZE!
  }
```

MAX_SAB_SIZE is defined (4GB) but never enforced.

### Fix
Add size validation:

```typescript
const INITIAL_SAB_SIZE = 1024 * 1024; // 1MB
const MAX_SAB_SIZE = 4 * 1024 * 1024 * 1024; // 4GB (corrected from "64GB" comment)

export class SharedMemoryCommunication {
  setBuffer(buf: Uint8Array) {
    const needed = buf.byteLength;
    const current = this.dataBuf.byteLength;

    // NEW: Validate against maximum size
    if (needed > MAX_SAB_SIZE) {
      throw new Error(
        `File too large: ${needed} bytes. Maximum allowed: ${MAX_SAB_SIZE} bytes (4GB).`
      );
    }

    if (needed > current) {
      this.dataBuf.grow(needed);
    }

    const bufView = new Uint8Array(this.dataBuf);
    bufView.set(buf);

    const sizeView = new Int32Array(this.sizeBuf);
    Atomics.store(sizeView, 0, needed);
  }
}
```

### Verification
- Test with 5GB buffer (should throw)
- Test with exactly 4GB (edge case)
- Test normal sized files still work

---

## Issue 14: Silent Cache Failures

**Status**: High Priority  
**File**: `src/cache-abstraction.ts` (lines 28-34, 36-49)  
**Effort**: 6 lines  
**Risk**: Low

### Problem
All cache failures are silently swallowed:

```typescript
async get(key: string): Promise<Uint8Array | undefined> {
  await this.ready;
  if (!this.cache) return undefined;

  try {
    const response = await this.cache.match(key);
    if (!response) return undefined;
    return new Uint8Array(await response.arrayBuffer());
  } catch {
    return undefined;  // Silent failure!
  }
}
```

Can't diagnose cache quota exceeded, corrupted storage, etc.

### Fix
Add debug logging (respect debug flag from parent):

```typescript
export interface CacheStorageOptions {
  debug?: boolean;
  name?: string;
}

class BrowserCacheStorage implements CacheStorage {
  private cache: Cache | null = null;
  private ready: Promise<void>;
  private debug: boolean;
  private name: string;

  constructor(options: CacheStorageOptions = {}) {
    this.debug = options.debug ?? false;
    this.name = options.name ?? "typst-packages";
    this.ready = this.init();
  }

  private async init(): Promise<void> {
    if (typeof caches !== "undefined") {
      try {
        this.cache = await caches.open(this.name);
        this.log("Cache initialized successfully");
      } catch (err) {
        this.logError("Failed to open cache:", err);
      }
    }
  }

  async get(key: string): Promise<Uint8Array | undefined> {
    await this.ready;
    if (!this.cache) return undefined;

    try {
      const response = await this.cache.match(key);
      if (!response) {
        this.log(`Cache miss: ${key}`);
        return undefined;
      }
      this.log(`Cache hit: ${key}`);
      return new Uint8Array(await response.arrayBuffer());
    } catch (err) {
      this.logError(`Cache read failed for ${key}:`, err);
      return undefined;
    }
  }

  async set(key: string, value: Uint8Array): Promise<void> {
    await this.ready;
    if (!this.cache) return;

    try {
      const response = new Response(value.buffer as ArrayBuffer, {
        headers: { "Content-Type": "application/octet-stream" },
      });
      await this.cache.put(key, response);
      this.log(`Cache write: ${key} (${value.byteLength} bytes)`);
    } catch (err) {
      this.logError(`Cache write failed for ${key}:`, err);
      // Silently fail but at least log it
    }
  }

  private log(...args: any[]): void {
    if (this.debug) {
      console.log(`[Cache:${this.name}]`, ...args);
    }
  }

  private logError(...args: any[]): void {
    if (this.debug) {
      console.error(`[Cache:${this.name}]`, ...args);
    }
  }
}

// Update factory function to accept options
export function createCacheStorage(options?: CacheStorageOptions): CacheStorage {
  if (typeof caches !== "undefined") {
    return new BrowserCacheStorage(options);
  }
  return new MemoryCacheStorage();
}
```

Also update PackageManager to pass debug flag:

```typescript
constructor(options: PackageManagerOptions = {}) {
  this.cache = createCacheStorage({
    debug: options.debug,
    name: "typst-packages"
  });
  // ...
}
```

### Verification
- Enable debug mode, verify logs appear
- Test cache failures (simulate quota exceeded)
- Ensure production (debug=false) has no logs

---

## Issue 17: SharedArrayBuffer No Timeout

**Status**: High Priority  
**File**: `src/worker.ts` (line 52)  
**Effort**: 5 lines  
**Risk**: Medium (critical path)

### Problem
`Atomics.wait()` can wait indefinitely if main thread fails to respond:

```typescript
globalThis.web_fetch = (path) => {
  if (!sharedMemoryCommunication) {
    throw new Error("Communication buffer not initialized");
  }

  sharedMemoryCommunication.setStatus(SharedMemoryCommunicationStatus.Pending);
  postMessage("web_fetch", { path });

  Atomics.wait(
    new Int32Array(sharedMemoryCommunication.statusBuf), 
    0, 
    SharedMemoryCommunicationStatus.Pending
  );  // Can wait forever!

  const status = sharedMemoryCommunication.getStatus();
  // ...
};
```

### Fix
Add timeout with error handling:

```typescript
// src/protocol.ts
const DEFAULT_FETCH_TIMEOUT = 30000; // 30 seconds

export class SharedMemoryCommunication {
  // ... existing code ...

  /**
   * Wait for status change with timeout
   * @returns true if status changed, false if timed out
   */
  waitForStatusChange(
    expectedStatus: SharedMemoryCommunicationStatus,
    timeoutMs: number = DEFAULT_FETCH_TIMEOUT
  ): boolean {
    const statusView = new Int32Array(this.statusBuf);
    
    // Atomics.wait returns "ok" | "not-equal" | "timed-out"
    const result = Atomics.wait(statusView, 0, expectedStatus, timeoutMs);
    
    return result === "ok";
  }
}
```

Update worker to use timeout:

```typescript
globalThis.web_fetch = (path) => {
  if (!sharedMemoryCommunication) {
    throw new Error("Communication buffer not initialized");
  }

  sharedMemoryCommunication.setStatus(SharedMemoryCommunicationStatus.Pending);
  postMessage("web_fetch", { path });

  const changed = sharedMemoryCommunication.waitForStatusChange(
    SharedMemoryCommunicationStatus.Pending,
    30000  // 30 second timeout
  );

  if (!changed) {
    // Timeout occurred
    sharedMemoryCommunication.setStatus(SharedMemoryCommunicationStatus.Error);
    throw new Error(`Timeout waiting for fetch response: ${path}`);
  }

  const status = sharedMemoryCommunication.getStatus();
  if (status === SharedMemoryCommunicationStatus.Error) {
    throw new Error(`Failed to fetch: ${path}`);
  }

  return sharedMemoryCommunication.getBuffer();
};
```

### Verification
- Test with simulated slow fetch (>30s)
- Verify timeout error is thrown
- Test successful fetch still works
- Test that worker can continue after timeout

---

## Issue 24: Missing Source Maps

**Status**: High Priority  
**File**: `tsdown.config.ts`  
**Effort**: 1 line  
**Risk**: None

### Problem
No source map configuration makes debugging production builds difficult:

```typescript
export default defineConfig({
  entry: ["./src/index.ts"],
  platform: "neutral",
  // No sourcemap configuration
});
```

### Fix
Add source maps for development:

```typescript
export default defineConfig({
  entry: ["./src/index.ts"],
  platform: "neutral",
  sourcemap: process.env.NODE_ENV !== "production", // Or always true
  // ... rest of config
});
```

Or separate dev/prod configs:

```typescript
const isDev = process.env.NODE_ENV === "development";

export default defineConfig({
  entry: ["./src/index.ts"],
  platform: "neutral",
  sourcemap: isDev,
  plugins: [
    workerPlugins({
      format: "es",
      sourcemap: isDev,  // Also for worker
    }),
  ],
  // ... rest of config
});
```

### Verification
- Run dev build, verify .js.map files generated
- Test that source maps point to original TypeScript
- Ensure production builds exclude source maps

---

## Issue 31: Package Spec Validation Too Permissive

**Status**: High Priority  
**File**: `src/package-manager.ts` (line 69)  
**Effort**: 3 lines  
**Risk**: Low

### Problem
Regex doesn't validate namespace/name constraints:

```typescript
private parseSpec(spec: string): PackageSpec {
  const match = spec.match(/^@([^/]+)\/([^:]+):([^/]+)\/(.+)$/);
  // Accepts invalid chars like spaces, special symbols
}
```

Accepts: `@name space/pack age:1.0/file.typ` (invalid)

### Fix
Add stricter validation:

```typescript
private parseSpec(spec: string): PackageSpec {
  // Stricter regex with character class restrictions
  // namespace: lowercase letters, digits, hyphens
  // name: lowercase letters, digits, hyphens, underscores
  // version: semantic version format
  const match = spec.match(
    /^@([a-z0-9-]+)\/([a-z0-9_-]+):([0-9]+\.[0-9]+\.[0-9]+(?:-[a-zA-Z0-9.-]+)?)\/(.+)$/
  );
  
  if (!match) {
    throw new Error(
      `Invalid package spec: "${spec}". ` +
      `Expected format: @namespace/name:version/path ` +
      `where namespace is lowercase alphanumeric with hyphens, ` +
      `name is lowercase alphanumeric with hyphens/underscores, ` +
      `version is semver (e.g., 0.4.2), and path is the file path.`
    );
  }
  
  const [, namespace, name, version, filePath] = match;
  
  // Additional validation
  if (namespace.startsWith('-') || namespace.endsWith('-')) {
    throw new Error(`Invalid package namespace: "${namespace}" cannot start or end with hyphen`);
  }
  
  if (name.startsWith('_') || name.endsWith('_')) {
    throw new Error(`Invalid package name: "${name}" cannot start or end with underscore`);
  }
  
  return { namespace, name, version, filePath };
}
```

### Verification
- Test valid specs pass
- Test invalid specs throw with helpful messages
- Test edge cases (empty namespace, special chars, etc.)

---

## Issue 33: Inconsistent Import Styles

**Status**: High Priority  
**Files**: Various TypeScript files  
**Effort**: 5-10 lines across files  
**Risk**: None

### Problem
Mixed import styles:

```typescript
// src/index.ts
type Font = import("./fonts/index");  // One style
type WasmDiagnostic = import("./wasm");  // Different style (no /index)
```

### Fix
Standardize on explicit `type` imports:

```typescript
// src/index.ts - Change:
import type { Font } from "./fonts/index";  // Good: type import with /index
import type { WasmDiagnostic } from "./wasm";  // Inconsistent

// To:
import type { Font } from "./fonts/index";
import type { WasmDiagnostic } from "./wasm/index";  // Add /index for consistency

// Or create a barrel export in wasm/index.ts that re-exports from typst_wasm
```

Also check:
- `src/worker.ts` imports
- `src/protocol.ts` imports
- `src/package-manager.ts` imports

Add ESLint rule to enforce:

```json
// .eslintrc.json (if you add ESLint)
{
  "rules": {
    "@typescript-eslint/consistent-type-imports": "error"
  }
}
```

### Verification
- All type imports use `import type` syntax
- All imports are consistent (all use /index or none do)
- No import cycles introduced

---

## Issue 34: Mixed Error Handling Patterns

**Status**: High Priority  
**Files**: Various  
**Effort**: Review and update 4-6 locations  
**Risk**: Medium (behavioral changes)

### Problem
Inconsistent error handling:

```typescript
// console.error in some places
console.error(`[TypstCompiler] Failed to load font "${font.name}":`, err);

// Thrown errors in others
throw new Error("Compiler has been disposed");

// postMessage with error payload in others
postMessage("compile_error", { error: "...", diagnostics: [] });
```

### Fix
Standardize on structured error objects (preparation for Issue 8):

Create helper functions first (can be done now):

```typescript
// src/util.ts or src/errors.ts

export interface ErrorContext {
  component: string;
  operation: string;
  recoverable: boolean;
}

export function logError(
  err: unknown,
  context: ErrorContext,
  debug: boolean
): void {
  if (!debug) return;
  
  const message = err instanceof Error ? err.message : String(err);
  console.error(
    `[${context.component}] ${context.operation} failed: ${message}`
  );
}

export function logWarning(
  message: string,
  component: string,
  debug: boolean
): void {
  if (!debug) return;
  console.warn(`[${component}] ${message}`);
}
```

Update all error sites:

```typescript
// src/index.ts:103-106
// OLD:
} catch (err) {
  if (this.debug) {
    console.error(`[TypstCompiler] Failed to load font "${font.name}":`, err);
  }
}

// NEW:
} catch (err) {
  logError(err, {
    component: "TypstCompiler",
    operation: `loadFont(${font.name})`,
    recoverable: true
  }, this.debug);
}

// src/index.ts:114-117
// OLD:
if (this.disposed) {
  throw new Error("Compiler has been disposed");
}

// NEW (use structured error):
if (this.disposed) {
  throw new CompilerError(
    "Compiler has been disposed",
    "DISPOSED",
    { recoverable: false }
  );
}
```

### Verification
- All errors use consistent logging format
- All errors include component context
- Debug flag is respected everywhere

---

## Implementation Order

### Week 1 (Quick Wins)
1. **Issue 24** - Source maps (1 line, zero risk)
2. **Issue 31** - Package spec validation (3 lines, good error messages)
3. **Issue 33** - Import styles (code quality, no runtime changes)

### Week 2 (Medium Effort)
4. **Issue 9** - Missing await (test error handling path)
5. **Issue 12** - File size limits (add safety bounds)
6. **Issue 14** - Cache logging (add debug visibility)

### Week 3 (Higher Impact)
7. **Issue 17** - SAB timeout (critical for reliability)
8. **Issue 11** - Package manager memory limit (long-running apps)
9. **Issue 34** - Error pattern consistency (prep for structural changes)

---

## Testing Checklist

After each fix:
- [ ] Run existing tests to ensure no regressions
- [ ] Add specific test for the fixed issue
- [ ] Verify in both Node.js and browser environments
- [ ] Check debug logs appear only when debug=true
- [ ] Test error messages are helpful and actionable
