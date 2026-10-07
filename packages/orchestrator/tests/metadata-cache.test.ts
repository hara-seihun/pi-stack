import { describe, expect, it } from "vitest";
import { MetadataCache } from "../src/threads/metadata-cache.js";

describe("metadata cache", () => {
  it("evicts by byte/count budget and recency, invalidating changed source keys", () => {
    const cache = new MetadataCache<string>(2, 10);
    expect(cache.set("a", "v1", "A", 4)).toBe(true);
    cache.set("b", "v1", "B", 4);
    expect(cache.get("a", "v1")).toBe("A");
    cache.set("c", "v1", "C", 4);
    expect(cache.get("b", "v1")).toBeUndefined();
    expect(cache.byteSize).toBe(8);
    expect(cache.get("a", "v2")).toBeUndefined();
    expect(cache.byteSize).toBe(4);
    expect(cache.set("c", "v2", "large", 11)).toBe(false);
    expect(cache.size).toBe(0);
    cache.set("a", "v3", "A", 0);
    cache.set("b", "v3", "B", 0);
    cache.set("c", "v3", "C", 0);
    expect(cache.size).toBe(2);
    expect(cache.get("a", "v3")).toBeUndefined();
    cache.clear();
    expect(cache.size).toBe(0);
    expect(cache.byteSize).toBe(0);
  });
});
