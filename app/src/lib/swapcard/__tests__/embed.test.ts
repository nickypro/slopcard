import { describe, it, expect } from "vitest";
import { cosine, vectorToBlob, blobToVector } from "@/lib/swapcard/embed";

describe("cosine", () => {
  it("returns 1.0 for identical normalized vectors", () => {
    const v = Float32Array.from([0.6, 0.8]); // already L2-normalized
    expect(cosine(v, v)).toBeCloseTo(1.0, 6);
  });

  it("returns -1.0 for opposite normalized vectors", () => {
    const a = Float32Array.from([0.6, 0.8]);
    const b = Float32Array.from([-0.6, -0.8]);
    expect(cosine(a, b)).toBeCloseTo(-1.0, 6);
  });

  it("returns 0 for orthogonal vectors", () => {
    const a = Float32Array.from([1, 0, 0]);
    const b = Float32Array.from([0, 1, 0]);
    expect(cosine(a, b)).toBeCloseTo(0, 6);
  });

  it("returns 0 for orthogonal vectors in higher dim", () => {
    const a = Float32Array.from([0, 0, 1, 0]);
    const b = Float32Array.from([0, 1, 0, 0]);
    expect(cosine(a, b)).toBeCloseTo(0, 6);
  });

  it("computes a basic dot product correctly (unnormalized inputs)", () => {
    // cosine() is really just a dot product — it does not normalize, since
    // upstream vectors are already normalized. Verify the math is correct.
    const a = Float32Array.from([1, 2, 3]);
    const b = Float32Array.from([4, 5, 6]);
    expect(cosine(a, b)).toBeCloseTo(1 * 4 + 2 * 5 + 3 * 6, 5);
  });
});

describe("vectorToBlob / blobToVector", () => {
  it("round-trips a small Float32Array element-wise", () => {
    const original = Float32Array.from([0.0, 0.5, -0.25, 1.0, -1.0, 3.14]);
    const buf = vectorToBlob(original);
    const back = blobToVector(buf, original.length);
    expect(back.length).toBe(original.length);
    for (let i = 0; i < original.length; i++) {
      // Float32 round-trip should be bit-exact.
      expect(back[i]).toBe(original[i]);
    }
  });

  it("produces a buffer 4 bytes per element", () => {
    const v = Float32Array.from([1, 2, 3, 4, 5]);
    const buf = vectorToBlob(v);
    expect(buf.length).toBe(v.length * 4);
  });

  it("round-trips small / subnormal-ish values", () => {
    const v = Float32Array.from([1e-7, -1e-7, 1e30, -1e30, 0]);
    const buf = vectorToBlob(v);
    const back = blobToVector(buf, v.length);
    for (let i = 0; i < v.length; i++) {
      expect(back[i]).toBe(v[i]);
    }
  });
});
