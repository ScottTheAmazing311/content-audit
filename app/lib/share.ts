import { compressToEncodedURIComponent, decompressFromEncodedURIComponent } from 'lz-string';

export function encodeResults(results: unknown): string {
  return compressToEncodedURIComponent(JSON.stringify(results));
}

export function decodeResults<T = unknown>(encoded: string): T | null {
  try {
    const json = decompressFromEncodedURIComponent(encoded);
    if (!json) return null;
    return JSON.parse(json) as T;
  } catch {
    return null;
  }
}
