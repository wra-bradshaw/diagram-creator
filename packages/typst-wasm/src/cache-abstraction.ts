import { Context, Effect } from "effect";
import { LRUCache } from "./lru-cache";

export interface CacheStorage {
  get(key: string): Effect.Effect<Uint8Array | null>;
  set(key: string, value: Uint8Array): Effect.Effect<void>;
}

export class CacheStorageService extends Context.Tag("CacheStorageService")<CacheStorageService, CacheStorage>() {}

const MAX_IN_MEMORY_CACHE_SIZE = 128 as const;

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
      } catch (err) {
        console.warn("[Cache] Failed to open cache storage:", err);
      }
    }
  }

  get(key: string): Effect.Effect<Uint8Array | null> {
    return Effect.gen(this, function* () {
      yield* Effect.promise(() => this.ready).pipe(Effect.orElseSucceed(() => undefined));
      if (!this.cache) return null;

      const result = yield* Effect.promise(async () => {
        try {
          const response = await this.cache!.match(key);
          if (!response) return null;
          return new Uint8Array(await response.arrayBuffer());
        } catch {
          return null;
        }
      });
      return result;
    });
  }

  set(key: string, value: Uint8Array): Effect.Effect<void> {
    return Effect.gen(this, function* () {
      yield* Effect.promise(() => this.ready).pipe(Effect.orElseSucceed(() => undefined));
      if (!this.cache) return;

      yield* Effect.promise(async () => {
        try {
          const response = new Response(value.buffer as ArrayBuffer, {
            headers: { "Content-Type": "application/octet-stream" },
          });
          await this.cache!.put(key, response);
        } catch {
          // Silently ignore cache write failures
        }
      });
    });
  }
}

class MemoryCacheStorage implements CacheStorage {
  private cache: LRUCache<string, Uint8Array>;

  constructor(capacity: number) {
    this.cache = new LRUCache(capacity);
  }

  get(key: string): Effect.Effect<Uint8Array | null> {
    return Effect.sync(() => this.cache.get(key) ?? null);
  }

  set(key: string, value: Uint8Array): Effect.Effect<void> {
    return Effect.sync(() => this.cache.put(key, value));
  }
}

export function createCacheStorage(memoryCacheCapacity: number): CacheStorage {
  if (typeof caches !== "undefined") {
    return new BrowserCacheStorage();
  }
  return new MemoryCacheStorage(memoryCacheCapacity);
}
