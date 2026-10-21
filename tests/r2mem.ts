/**
 * An in-memory stand-in for a Workers R2 bucket (the parts functions/_vkx.ts
 * uses: head / get / put / delete / list with customMetadata). Used by the
 * tests and by the dev mock (scripts/vkx-dev.mjs). `fail` makes every call
 * throw, as an unreachable bucket would.
 */
import type { R2BucketLike, R2ObjectBodyLike, R2ObjectLike, R2PutOptionsLike } from '../functions/_vkx';

interface Stored {
  bytes: Uint8Array;
  meta: Record<string, string>;
  type?: string;
  uploaded: Date;
}

export class MemBucket implements R2BucketLike {
  readonly objects = new Map<string, Stored>();
  fail = false;
  private check(): void {
    if (this.fail) throw new Error('R2 unavailable');
  }
  private view(key: string, s: Stored): R2ObjectLike {
    return { key, size: s.bytes.length, uploaded: s.uploaded, customMetadata: { ...s.meta }, httpMetadata: s.type ? { contentType: s.type } : {} };
  }
  async head(key: string): Promise<R2ObjectLike | null> {
    this.check();
    const s = this.objects.get(key);
    return s ? this.view(key, s) : null;
  }
  async get(key: string): Promise<R2ObjectBodyLike | null> {
    this.check();
    const s = this.objects.get(key);
    if (!s) return null;
    const bytes = s.bytes.slice();
    return { ...this.view(key, s), arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer };
  }
  async put(key: string, value: ArrayBuffer | Uint8Array, opts: R2PutOptionsLike = {}): Promise<R2ObjectLike | null> {
    this.check();
    const bytes = value instanceof Uint8Array ? value.slice() : new Uint8Array(value.slice(0));
    const s: Stored = { bytes, meta: { ...(opts.customMetadata ?? {}) }, type: opts.httpMetadata?.contentType, uploaded: new Date() };
    this.objects.set(key, s);
    return this.view(key, s);
  }
  async delete(keys: string | string[]): Promise<void> {
    this.check();
    for (const k of Array.isArray(keys) ? keys : [keys]) this.objects.delete(k);
  }
  async list(opts: { prefix?: string; cursor?: string; limit?: number; include?: string[] } = {}): Promise<{ objects: R2ObjectLike[]; truncated: boolean; cursor?: string }> {
    this.check();
    const keys = [...this.objects.keys()].filter((k) => k.startsWith(opts.prefix ?? '')).sort();
    const start = opts.cursor ? Number(opts.cursor) : 0;
    const limit = opts.limit ?? 1000;
    const page = keys.slice(start, start + limit);
    const withMeta = opts.include?.includes('customMetadata');
    const objects = page.map((k) => {
      const v = this.view(k, this.objects.get(k)!);
      return withMeta ? v : { ...v, customMetadata: undefined };
    });
    const truncated = start + limit < keys.length;
    return { objects, truncated, ...(truncated ? { cursor: String(start + limit) } : {}) };
  }
}
