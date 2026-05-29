// Local sentence-embedding pipeline. Runs on-device via @xenova/transformers,
// no API key, no per-use cost. 384-dim, mean-pooled, L2-normalized — so dot
// product equals cosine similarity downstream.
//
// We keep the extractor in a singleton promise so the model is loaded once
// per Node process (slow first call, fast thereafter). The model itself
// downloads on first run; cached by @xenova in ~/.cache.

export const EMBED_MODEL = "Xenova/bge-small-en-v1.5";
export const EMBED_DIM = 384;

type Extractor = (
  input: string | string[],
  opts: { pooling: "mean"; normalize: boolean }
) => Promise<{ tolist(): number[][] }>;

let extractorPromise: Promise<Extractor> | null = null;

async function getExtractor(): Promise<Extractor> {
  if (!extractorPromise) {
    const mod = await import("@xenova/transformers");
    mod.env.allowRemoteModels = true;
    // Default cache lands in node_modules, which the prod container can't
    // write (image is built with root-owned node_modules but run as a
    // non-root user). Point it at the bind-mounted data dir instead — that's
    // both writable AND persistent across container restarts, so the model
    // only downloads once per host.
    const cacheRoot =
      process.env.TRANSFORMERS_CACHE ||
      (process.env.DATA_DIR
        ? `${process.env.DATA_DIR}/transformers-cache`
        : "/tmp/transformers-cache");
    mod.env.cacheDir = cacheRoot;
    extractorPromise = mod.pipeline(
      "feature-extraction",
      EMBED_MODEL
    ) as unknown as Promise<Extractor>;
  }
  return extractorPromise;
}

export async function embedTexts(
  texts: string[],
  opts?: { batchSize?: number; onProgress?: (done: number, total: number) => void }
): Promise<Float32Array[]> {
  const extractor = await getExtractor();
  const batchSize = opts?.batchSize ?? 32;
  const out: Float32Array[] = [];
  for (let i = 0; i < texts.length; i += batchSize) {
    const batch = texts.slice(i, i + batchSize);
    const res = await extractor(batch, { pooling: "mean", normalize: true });
    const rows = res.tolist();
    for (const r of rows) out.push(Float32Array.from(r));
    opts?.onProgress?.(Math.min(i + batchSize, texts.length), texts.length);
  }
  return out;
}

export async function embedOne(text: string): Promise<Float32Array> {
  const [v] = await embedTexts([text]);
  return v;
}

// Pre-normalized vectors → dot product is cosine similarity.
export function cosine(a: Float32Array, b: Float32Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

// Convert a Float32Array to a Buffer for SQLite BLOB storage.
export function vectorToBlob(v: Float32Array): Buffer {
  const buf = Buffer.alloc(v.length * 4);
  for (let i = 0; i < v.length; i++) buf.writeFloatLE(v[i], i * 4);
  return buf;
}

export function blobToVector(buf: Buffer, dim = EMBED_DIM): Float32Array {
  const v = new Float32Array(dim);
  for (let i = 0; i < dim; i++) v[i] = buf.readFloatLE(i * 4);
  return v;
}
