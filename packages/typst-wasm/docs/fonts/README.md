# Font System Architecture

## Overview

The Font System provides fonts to the Typst WASM compiler through a tree-shakeable, lazy-loading architecture. Fonts are imported as URLs and loaded on-demand via `fetch()`.

## Why URL Imports?

### Comparison of Approaches

| Approach | Bundle Size | Loading | Tree-shaking | Complexity |
|----------|-------------|---------|--------------|------------|
| **Base64 inline** | +33% larger | Instant | ✅ Yes | Simple |
| **Uint8Array inline** | Raw size | Instant | ✅ Yes | Requires custom loader |
| **URL imports** | URLs only (small) | Lazy | ✅ Yes | Standard ES modules |
| **CDN URLs** | Zero | Network | ✅ Yes | External dependency |

**Winner: URL imports**
- Smallest bundle (just URLs, not font data)
- Lazy loading (fetch when needed)
- Browser handles HTTP caching
- Standard ES module behavior
- Works with all bundlers

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                        Font System                          │
│                                                             │
│  ┌─────────────────┐      ┌─────────────────────────────┐   │
│  │   Font Exports  │      │      tsdown (bundler)       │   │
│  │   (src/fonts)   │─────▶│                             │   │
│  │                 │      │  ┌─────────────────────┐    │   │
│  │  • URL imports  │      │  │   Asset Loader      │    │   │
│  │  • Lazy loaders │      │  │                     │    │   │
│  │  • Presets      │      │  │  .otf → dist/fonts/ │    │   │
│  └─────────────────┘      │  │  returns URL        │    │   │
│                           │  └─────────────────────┘    │   │
└───────────────────────────┼─────────────────────────────┘   │
                            │                                   │
                            │ fetch()                           │
                            ▼                                   │
┌─────────────────────────────────────────────────────────────┐
│                      Runtime                                │
│                                                             │
│  User Code:                                                 │
│  ```typescript                                              │
│  import { defaultFonts } from 'typst-wasm/fonts';          │
│  const compiler = new TypstCompiler(..., {                 │
│    fonts: defaultFonts  // Array of Font objects           │
│  });                                                        │
│  ```                                                        │
│                                                             │
│  Later, during compile:                                     │
│  font.load() → fetch(url) → Uint8Array → WASM              │
└─────────────────────────────────────────────────────────────┘
```

## Font Interface

```typescript
interface Font {
  name: string;                    // Display name
  weight: number;                  // 400, 700, etc.
  style: 'normal' | 'italic';     // Font style
  load: () => Promise<Uint8Array>; // Lazy loader
}
```

## Font Sources

### 1. Built-in Fonts (Auto-fetched at build time)

**Source**: [typst/typst-assets](https://github.com/typst/typst-assets)

**Included Fonts**:
- New Computer Modern (Regular, Italic, Bold)
- New Computer Modern Math (Regular, Bold)

**Why these?**
- Typst's default font family
- Excellent math support
- Open source (GUST license)
- ~2.5MB total (reasonable bundle size)

**Fetch Process**:
```
scripts/fetch-fonts.ts
    ↓
Download from GitHub (typst-assets)
    ↓
Save to src/fonts/files/
    ↓
Generate src/fonts/index.ts
```

### 2. Custom Fonts (User-provided)

```typescript
const myFont: Font = {
  name: "My Custom Font",
  weight: 400,
  style: 'normal',
  load: async () => {
    const response = await fetch('./my-font.otf');
    return new Uint8Array(await response.arrayBuffer());
  }
};

const compiler = new TypstCompiler(wasmUrl, workerUrl, {
  fonts: [...defaultFonts, myFont]
});
```

## Build-Time Font Fetching

### Script: `scripts/fetch-fonts.ts`

```typescript
const FONTS = [
  {
    name: 'newComputerModern',
    files: [
      { id: 'NewComputerModern-Regular', weight: 400, style: 'normal' },
      { id: 'NewComputerModern-Italic', weight: 400, style: 'italic' },
      { id: 'NewComputerModern-Bold', weight: 700, style: 'normal' },
    ]
  },
  {
    name: 'newComputerModernMath',
    files: [
      { id: 'NewCMMath-Regular', weight: 400, style: 'normal' },
      { id: 'NewCMMath-Bold', weight: 700, style: 'normal' },
    ]
  }
];

async function main() {
  // 1. Download each font from typst-assets
  for (const font of FONTS) {
    for (const file of font.files) {
      const url = `${TYPST_ASSETS_URL}/${file.id}.otf`;
      const data = await fetch(url).then(r => r.arrayBuffer());
      await writeFile(`src/fonts/files/${file.id}.otf`, data);
    }
  }
  
  // 2. Generate index.ts with URL imports
  await generateIndexFile();
}
```

### Generated File: `src/fonts/index.ts`

```typescript
// Auto-generated by fetch-fonts.ts
// Do not edit manually

import newComputerModern_normal_400_url from './files/NewComputerModern-Regular.otf';
import newComputerModern_italic_400_url from './files/NewComputerModern-Italic.otf';
import newComputerModern_normal_700_url from './files/NewComputerModern-Bold.otf';
// ... more imports

export interface Font {
  name: string;
  weight: number;
  style: 'normal' | 'italic';
  load: () => Promise<Uint8Array>;
}

export const newComputerModern: Font[] = [
  {
    name: "New Computer Modern",
    weight: 400,
    style: "normal",
    load: async () => {
      const response = await fetch(newComputerModern_normal_400_url);
      return new Uint8Array(await response.arrayBuffer());
    }
  },
  // ... more variants
];

// Convenience exports
export const newComputerModernRegular = newComputerModern.find(
  f => f.weight === 400 && f.style === 'normal'
)!;

// Default preset
export const defaultFonts = [
  newComputerModernRegular,
  // ... other essential fonts
];
```

## tsdown Configuration

### Asset Handling

```typescript
// tsdown.config.ts
export default defineConfig({
  entry: [
    "./src/index.ts",
    "./src/worker.ts",
    "./src/fonts/index.ts"  // Separate entry for fonts
  ],
  
  // Tell tsdown how to handle font files
  loader: {
    '.otf': 'asset',    // Copy to dist, import returns URL
    '.woff2': 'asset',
  },
  
  // Where to put font files
  outputOptions: {
    assetFileNames: 'fonts/[name][extname]',  // dist/fonts/font.otf
  },
});
```

### What Happens

1. **Import**: `import url from './font.otf'`
2. **Bundler**: Copies `font.otf` to `dist/fonts/`
3. **Transform**: Import becomes `const url = "fonts/font.otf"`
4. **Runtime**: `fetch(url)` loads from `dist/fonts/font.otf`

## User API

### Option 1: Default Preset (Recommended)

```typescript
import { TypstCompiler } from 'typst-wasm';
import { defaultFonts } from 'typst-wasm/fonts';

const compiler = new TypstCompiler(wasmUrl, workerUrl, {
  fonts: defaultFonts
});
```

**Includes**: New Computer Modern family (regular, italic, bold, math)

### Option 2: Selective Import

```typescript
import { 
  newComputerModern, 
  newComputerModernMath 
} from 'typst-wasm/fonts';

const compiler = new TypstCompiler(wasmUrl, workerUrl, {
  fonts: [
    newComputerModern.find(f => f.weight === 700)!,  // Bold only
    newComputerModernMath[0],  // Regular math
  ]
});
```

### Option 3: Custom Fonts

```typescript
import { defaultFonts } from 'typst-wasm/fonts';

const customFont: Font = {
  name: "Inter",
  weight: 400,
  style: 'normal',
  load: async () => {
    const response = await fetch('/fonts/Inter-Regular.otf');
    return new Uint8Array(await response.arrayBuffer());
  }
};

const compiler = new TypstCompiler(wasmUrl, workerUrl, {
  fonts: [...defaultFonts, customFont]
});
```

## Font Loading Timing

### Eager Loading (Current Implementation)

```typescript
// In TypstCompiler constructor
if (options.fonts) {
  this.fonts = options.fonts;
  // Load all fonts immediately
  this.loadFonts();
}

private async loadFonts() {
  for (const font of this.fonts) {
    const data = await font.load();
    this.worker.postMessage({
      kind: 'load_font',
      payload: { data }
    });
  }
}
```

**Pros**:
- All fonts ready before compilation
- Simple implementation
- No mid-compile delays

**Cons**:
- Loads fonts even if not used
- Slower initial startup

### Lazy Loading (Alternative)

```typescript
// Only load when Typst requests a font
private async onFontRequest(fontName: string) {
  const font = this.fonts.find(f => f.name === fontName);
  if (font && !font.loaded) {
    const data = await font.load();
    // Send to WASM
  }
}
```

**Pros**:
- Only loads needed fonts
- Faster startup

**Cons**:
- More complex
- Mid-compile delays possible

**Recommendation**: Stick with eager loading for simplicity. Font files are cached by browser anyway.

## Browser Caching

### HTTP Cache

Font files are served via `fetch()`, so browser handles caching:

```
First load:
  fetch(fontUrl) → Network → Cache → Return

Subsequent loads:
  fetch(fontUrl) → Cache hit → Return (no network!)
```

### Cache Headers

If serving from your own server, set:
```
Cache-Control: public, max-age=31536000, immutable
```

Fonts never change (versioned by package), so cache forever.

## Font Licensing

### Included Fonts

**New Computer Modern**
- License: GUST Font License 1.0
- Copyright: © 2003-2024 Donald E. Knuth and GUST project
- Source: https://github.com/typst/typst-assets
- Permits: Bundling, redistribution
- Requires: License and copyright notice

### Attribution

Must include in `THIRD_PARTY_NOTICES.md`:
```
## New Computer Modern

Copyright (c) 2003-2024 Donald E. Knuth and the GUST project
License: GUST Font License 1.0
Source: https://github.com/typst/typst-assets
```

## File Structure

```
src/fonts/
├── fetch-fonts.ts      # Build script (downloads fonts)
├── index.ts            # Generated exports (URL imports)
├── files/              # Font files (gitignored)
│   ├── NewComputerModern-Regular.otf
│   ├── NewComputerModern-Italic.otf
│   ├── NewComputerModern-Bold.otf
│   ├── NewCMMath-Regular.otf
│   └── NewCMMath-Bold.otf
└── README.md           # This file

dist/fonts/            # Output (copied by tsdown)
├── NewComputerModern-Regular.otf
├── NewComputerModern-Italic.otf
├── NewComputerModern-Bold.otf
├── NewCMMath-Regular.otf
└── NewCMMath-Bold.otf
```

## Performance

### Bundle Size Impact

| Component | Size |
|-----------|------|
| Font loader code | ~1KB |
| Font URLs (5 fonts) | ~500B |
| Actual font files | ~2.5MB (not in JS bundle) |
| **Total JS bundle** | **~1.5KB** |

**Tree-shaking**: Only imported fonts are included.

### Load Times

| Scenario | Time | Network |
|----------|------|---------|
| Cold load (no cache) | ~500ms | 5 font files |
| Warm load (cached) | ~50ms | 0 (cache hits) |

## Testing

### Unit Test

```typescript
it("should load font bytes", async () => {
  const font = newComputerModernRegular;
  const data = await font.load();
  
  expect(data).toBeInstanceOf(Uint8Array);
  expect(data.length).toBeGreaterThan(1000);
});
```

### Integration Test

```typescript
it("should compile with fonts", async () => {
  const compiler = new TypstCompiler(wasmUrl, workerUrl, {
    fonts: defaultFonts
  });
  await compiler.ready();
  
  const result = await compiler.compile({
    mainPath: "main.typ",
    files: {
      "main.typ": new TextEncoder().encode(`
        #set text(font: "New Computer Modern")
        Hello, world!
        $x^2 + y^2 = z^2$
      `)
    }
  });
  
  expect(result.success).toBe(true);
});
```

## Related Documentation

- [Main Architecture](../README.md) - System overview
- [Package System](../packages/README.md) - Similar caching strategy
- [Build System](../build/README.md) - Font fetching in build process
- [Implementation Roadmap](../../implementation/ROADMAP.md) - Current status
