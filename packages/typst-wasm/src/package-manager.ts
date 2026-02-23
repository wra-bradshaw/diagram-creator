import { Effect } from "effect";
import { parseTarGzip } from "nanotar";
import { createCacheStorage } from "./cache-abstraction";

interface PackageSpec {
  namespace: string;
  name: string;
  version: string;
  filePath: string;
}

export class PackageManager {
  private cache: ReturnType<typeof createCacheStorage>;
  private loadedPackages = new Set<string>();

  constructor(memoryCacheCapacity: number) {
    this.cache = createCacheStorage(memoryCacheCapacity);
  }

  async getFile(spec: string): Promise<Uint8Array> {
    const parsed = this.parseSpec(spec);
    const cacheKey = this.getCacheKey(parsed);

    const cached = await Effect.runPromise(this.cache.get(cacheKey));
    if (cached) {
      return cached;
    }

    const packageKey = this.getPackageKey(parsed);
    if (!this.loadedPackages.has(packageKey)) {
      await this.loadPackage(parsed);
    }

    const file = await Effect.runPromise(this.cache.get(cacheKey));
    if (!file) {
      throw new Error(`File not found in package: ${parsed.filePath}`);
    }
    return file;
  }

  private async loadPackage(spec: PackageSpec): Promise<void> {
    const packageKey = this.getPackageKey(spec);

    const url = `https://packages.typst.org/${spec.namespace}/${spec.name}-${spec.version}.tar.gz`;
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Failed to fetch package: ${url}`);
    }

    const tarData = new Uint8Array(await response.arrayBuffer());
    const files = await parseTarGzip(tarData);

    for (const file of files) {
      if (file.type === "file" && file.data) {
        const cacheKey = this.getFileCacheKey(spec, file.name);
        await Effect.runPromise(this.cache.set(cacheKey, file.data));
      }
    }

    this.loadedPackages.add(packageKey);
  }

  private parseSpec(spec: string): PackageSpec {
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

    if (namespace.startsWith("-") || namespace.endsWith("-")) {
      throw new Error(`Invalid package namespace: "${namespace}" cannot start or end with hyphen`);
    }

    if (name.startsWith("_") || name.endsWith("_")) {
      throw new Error(`Invalid package name: "${name}" cannot start or end with underscore`);
    }

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
