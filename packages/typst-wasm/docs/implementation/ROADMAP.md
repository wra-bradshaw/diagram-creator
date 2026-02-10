# Implementation Roadmap

## Current Status

### ✅ Completed

#### Protocol & Communication

- [x] SharedArrayBuffer protocol with Atomics
- [x] Status tracking (Pending/Success/Error)
- [x] Buffer size tracking
- [x] Atomics.notify() for waking worker
- [x] Rust Result type for error handling

#### Package System

- [x] PackageManager with nanotar integration
- [x] Cache abstraction (Cache API + Memory fallback)
- [x] Two-layer caching (memory tracking + persistent cache)
- [x] nanotar for decompression and parsing
- [x] Removed fflate dependency

#### Build System

- [x] Unified build script architecture
- [x] tsdown configuration with asset handling
- [x] Basic font structure planned

### 🚧 In Progress / Planned

#### Font System

- [ ] Font fetching script (download from typst-assets)
- [ ] Font index.ts generation
- [ ] Font loading in TypstCompiler
- [ ] Worker protocol extension for fonts
- [ ] THIRD_PARTY_NOTICES.md

#### Testing & Validation

- [ ] Unit tests for protocol
- [ ] Integration tests for packages
- [ ] Font loading tests
- [ ] End-to-end compilation tests

#### Documentation

- [x] Architecture overview
- [x] Protocol documentation
- [x] Package system documentation
- [x] Font system documentation
- [x] Build system documentation
- [ ] API reference
- [ ] Usage examples

## Implementation Phases

### Phase 1: Foundation (✅ Complete)

**Goal**: Working protocol and package fetching

**Tasks**:

1. ✅ Implement SharedArrayBuffer protocol
2. ✅ Fix Atomics synchronization
3. ✅ Integrate nanotar for packages
4. ✅ Remove fflate dependency
5. ✅ Create cache abstraction

**Deliverable**: `test_sanity.js` compiles without hanging

### Phase 2: Font System (Current)

**Goal**: Working font loading

**Tasks**:

1. Create font fetching script

   ```typescript
   // scripts/fetch-fonts.ts
   - Download from typst-assets
   - Save to src/fonts/files/
   - Generate src/fonts/index.ts
   ```

2. Update tsdown config

   ```typescript
   // tsdown.config.ts
   - Add fonts entry point
   - Configure asset loader for .otf
   - Set assetFileNames
   ```

3. Extend TypstCompiler

   ```typescript
   // src/index.ts
   - Add fonts option to constructor
   - Load fonts before compilation
   - Send to worker via message
   ```

4. Extend worker protocol

   ```typescript
   // src/worker.ts
   - Add 'load_font' message handler
   - Call compiler.add_font()
   ```

5. Add licensing
   - Create THIRD_PARTY_NOTICES.md
   - Include font attributions

**Deliverable**: Compilation with math support works

## Detailed Implementation Plan

### Font Fetching Script

**File**: `scripts/fetch-fonts.ts`

```typescript
#!/usr/bin/env bun
/**
 * Fetches fonts from typst-assets and generates index.ts
 *
 * Run: bun scripts/fetch-fonts.ts
 * Or: bun run fetch-fonts
 */

import { writeFile, mkdir } from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";

const TYPST_ASSETS_BASE = "https://github.com/typst/typst-assets/raw/main/files/fonts";

// Fonts to include
const FONT_MANIFEST = [
  {
    family: "New Computer Modern",
    prefix: "NewComputerModern",
    variants: [
      { file: "NewComputerModern-Regular", weight: 400, style: "normal" },
      { file: "NewComputerModern-Italic", weight: 400, style: "italic" },
      { file: "NewComputerModern-Bold", weight: 700, style: "normal" },
    ],
  },
  {
    family: "New Computer Modern Math",
    prefix: "NewCMMath",
    variants: [
      { file: "NewCMMath-Regular", weight: 400, style: "normal" },
      { file: "NewCMMath-Bold", weight: 700, style: "normal" },
    ],
  },
];

async function main() {
  const filesDir = join(import.meta.dir, "..", "src", "fonts", "files");

  // Ensure directory exists
  if (!existsSync(filesDir)) {
    await mkdir(filesDir, { recursive: true });
  }

  // Download fonts
  for (const font of FONT_MANIFEST) {
    for (const variant of font.variants) {
      const filename = `${variant.file}.otf`;
      const filepath = join(filesDir, filename);

      if (existsSync(filepath)) {
        console.log(`✓ ${filename} (cached)`);
        continue;
      }

      console.log(`↓ ${filename}...`);
      const url = `${TYPST_ASSETS_BASE}/${filename}`;
      const response = await fetch(url);

      if (!response.ok) {
        throw new Error(`Failed to fetch ${url}: ${response.status}`);
      }

      const data = new Uint8Array(await response.arrayBuffer());
      await writeFile(filepath, data);
    }
  }

  // Generate index.ts
  console.log("Generating src/fonts/index.ts...");
  await generateIndexFile(filesDir);

  console.log("\n✅ Fonts ready!");
}

async function generateIndexFile(filesDir: string) {
  // Generate imports
  const imports = FONT_MANIFEST.flatMap((font) => font.variants.map((v) => `import ${toCamelCase(v.file)}_url from './files/${v.file}.otf';`)).join("\n");

  // Generate exports
  const exports = FONT_MANIFEST.map((font) => {
    const variants = font.variants
      .map(
        (v) => `{
    name: "${font.family}",
    weight: ${v.weight},
    style: "${v.style}" as const,
    load: async () => {
      const response = await fetch(${toCamelCase(v.file)}_url);
      return new Uint8Array(await response.arrayBuffer());
    }
  }`,
      )
      .join(",\n  ");

    return `export const ${toCamelCase(font.prefix)}: Font[] = [\n  ${variants}\n];`;
  }).join("\n\n");

  const content = `// Auto-generated by scripts/fetch-fonts.ts
// Do not edit manually

export interface Font {
  name: string;
  weight: number;
  style: 'normal' | 'italic';
  load: () => Promise<Uint8Array>;
}

${imports}

${exports}
`;

  await writeFile(join(filesDir, "..", "index.ts"), content);
}

function toCamelCase(str: string): string {
  return str.replace(/[-_](.)/g, (_, char) => char.toUpperCase()).replace(/^(.)/, (_, char) => char.toLowerCase());
}

if (import.meta.main) {
  main().catch((err) => {
    console.error("Error:", err);
    process.exit(1);
  });
}
```

### TypstCompiler Font Integration

**File**: `src/index.ts`

```typescript
import type { Font } from "./fonts/index";

export interface TypstCompilerOptions {
  debug?: boolean;
}

export class TypstCompiler {
  constructor(wasmUrl: string, workerUrl: string, options: TypstCompilerOptions = {}) {
    // ... existing init code ...
  }

  async ready(): Promise<void> {
    await this.initPromise;
  }

  async addFont(font: Font) {
    // load font
    const data = await font.load();

    this.worker.postMessage({
      kind: "load_font",
      payload: { data },
    } as MainToWorkerMessage);
  }
}
```

### Worker Font Handler

**File**: `src/worker.ts`

```typescript
export type MainToWorkerMessage =
  | { kind: "init"; ... }
  | { kind: "compile"; ... }
  | { kind: "load_font"; payload: { data: Uint8Array } };  // New

self.onmessage = async (e: MessageEvent) => {
  const data = e.data as MainToWorkerMessage;

  switch (data.kind) {
    case "init":
      // ... existing code ...
      break;

    case "compile":
      // ... existing code ...
      break;

    case "load_font":  // New
      if (compiler) {
        compiler.add_font(data.payload.data);
      }
      break;
  }
};
```
