import { parseTarGzip } from "nanotar";
import { createCacheStorage, type CacheStorage } from "./cache-abstraction";

interface PackageSpec {
  namespace: string;
  name: string;
  version: string;
  filePath: string;
}

export class PackageManager {
  private cache: CacheStorage;
  private loadedPackages = new Set<string>();

  constructor() {
    this.cache = createCacheStorage();
  }

  async getFile(spec: string): Promise<Uint8Array> {
    const parsed = this.parseSpec(spec);
    const cacheKey = this.getCacheKey(parsed);

    // Check cache first
    const cached = await this.cache.get(cacheKey);
    if (cached) {
      return cached;
    }

    // Load package if not already loaded
    const packageKey = this.getPackageKey(parsed);
    if (!this.loadedPackages.has(packageKey)) {
      await this.loadPackage(parsed);
    }

    // Return file from cache
    const file = await this.cache.get(cacheKey);
    if (!file) {
      throw new Error(`File not found in package: ${parsed.filePath}`);
    }
    return file;
  }

  private async loadPackage(spec: PackageSpec): Promise<void> {
    const packageKey = this.getPackageKey(spec);

    // Fetch tar.gz
    const url = `https://packages.typst.org/${spec.namespace}/${spec.name}-${spec.version}.tar.gz`;
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Failed to fetch package: ${url}`);
    }

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
  }

  private parseSpec(spec: string): PackageSpec {
    const match = spec.match(/^@([^/]+)\/([^:]+):([^/]+)\/(.+)$/);
    if (!match) {
      throw new Error(`Invalid package spec: ${spec}`);
    }
    const [, namespace, name, version, filePath] = match;
    return { namespace, name, version, filePath };
  }

  private getCacheKey(spec: PackageSpec): string {
    return this.getFileCacheKey(spec, spec.filePath);
  }

  private getFileCacheKey(spec: PackageSpec, filePath: string): string {
    return `@${spec.namespace}/${spec.name}:${spec.version}/${filePath}`;
  }

  private getPackageKey(spec: PackageSpec): string {
    return `@${spec.namespace}/${spec.name}:${spec.version}`;
  }
}
