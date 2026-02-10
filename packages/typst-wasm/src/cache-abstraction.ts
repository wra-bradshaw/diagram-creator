export interface CacheStorage {
  get(key: string): Promise<Uint8Array | undefined>;
  set(key: string, value: Uint8Array | undefined): Promise<void>;
}

class BrowserCacheStorage implements CacheStorage {
  private cache: Cache | null = null;
  private ready: Promise<void>;

  constructor() {
    this.ready = this.init();
  }

  private async init(): Promise<void> {
    if (typeof caches !== "undefined") {
      try {
        this.cache = await caches.open("typst-packages");
      } catch {
        // Cache API not available, will remain null
      }
    }
  }

  async get(key: string): Promise<Uint8Array | undefined> {
    await this.ready;
    if (!this.cache) return undefined;

    try {
      const response = await this.cache.match(key);
      if (!response) return undefined;
      return new Uint8Array(await response.arrayBuffer());
    } catch {
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
    } catch {
      // Silently fail if cache write fails (e.g., quota exceeded)
    }
  }
}

class MemoryCacheStorage implements CacheStorage {
  private cache = new Map<string, Uint8Array>();

  async get(key: string): Promise<Uint8Array | undefined> {
    return this.cache.get(key);
  }

  async set(key: string, value: Uint8Array): Promise<void> {
    this.cache.set(key, value);
  }
}

export function createCacheStorage(): CacheStorage {
  if (typeof caches !== "undefined") {
    return new BrowserCacheStorage();
  }
  return new MemoryCacheStorage();
}
