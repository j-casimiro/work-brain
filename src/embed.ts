// Local embeddings: @huggingface/tokenizers (pure JS) + onnxruntime-web (WASM).
// Native onnxruntime-node segfaults on this laptop's Windows build, so no native inference code is used.
// Model files are downloaded once into modelsDir; after that, nothing (and no note text) leaves the laptop.
import fs from "node:fs";
import path from "node:path";
import { Tokenizer } from "@huggingface/tokenizers";
import * as ort from "onnxruntime-web";
import { config } from "./config.js";

const FILES = ["tokenizer.json", "tokenizer_config.json", "onnx/model_quantized.onnx"];
const MAX_TOKENS = 512; // BERT position limit; longer chunks are truncated
// bge models are trained with this instruction on the query side only.
const QUERY_PREFIX = "Represent this sentence for searching relevant passages: ";

async function ensureFiles(dir: string) {
  for (const f of FILES) {
    const dest = path.join(dir, ...f.split("/"));
    if (fs.existsSync(dest)) continue;
    const url = `https://huggingface.co/${config.embedModel}/resolve/main/${f}`;
    console.error(`downloading ${url}`);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`download failed ${res.status}: ${url}`);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(`${dest}.part`, Buffer.from(await res.arrayBuffer()));
    fs.renameSync(`${dest}.part`, dest);
  }
}

interface Model { tokenizer: Tokenizer; session: ort.InferenceSession }
let model: Promise<Model> | undefined;

const load = () => (model ??= (async () => {
  const dir = path.join(config.modelsDir, ...config.embedModel.split("/"));
  await ensureFiles(dir);
  const read = (f: string) => JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
  const tokenizer = new Tokenizer(read("tokenizer.json"), read("tokenizer_config.json"));
  ort.env.logLevel = "error";
  const session = await ort.InferenceSession.create(fs.readFileSync(path.join(dir, "onnx", "model_quantized.onnx")),
                                                    { executionProviders: ["wasm"] });
  return { tokenizer, session };
})());

const int64 = (xs: number[]) => new ort.Tensor("int64", BigInt64Array.from(xs, BigInt), [1, xs.length]);

async function embedOne({ tokenizer, session }: Model, text: string): Promise<Float32Array> {
  let ids = tokenizer.encode(text).ids;
  if (ids.length > MAX_TOKENS) ids = [...ids.slice(0, MAX_TOKENS - 1), ids[ids.length - 1]]; // keep [SEP]
  const feeds: Record<string, ort.Tensor> = { input_ids: int64(ids), attention_mask: int64(ids.map(() => 1)) };
  if (session.inputNames.includes("token_type_ids")) feeds.token_type_ids = int64(ids.map(() => 0));
  const out = (await session.run(feeds))[session.outputNames[0]]; // last_hidden_state [1, seq, dim]
  const dim = out.dims[2];
  if (dim !== config.embedDim) throw new Error(`${config.embedModel} returns ${dim} dims but EMBED_DIM is ${config.embedDim}`);
  const cls = (out.data as Float32Array).slice(0, dim); // bge: CLS pooling
  const norm = Math.hypot(...cls) || 1;
  return cls.map((v) => v / norm); // normalised, so cosine = dot product
}

/** One normalised embedding per text. Runs sequentially: no padding, and the model is small. */
export async function embed(texts: string[]): Promise<Float32Array[]> {
  if (!texts.length) return [];
  const m = await load();
  const out: Float32Array[] = [];
  for (const t of texts) out.push(await embedOne(m, t));
  return out;
}

export const embedQuery = async (q: string) => (await embed([QUERY_PREFIX + q]))[0];
