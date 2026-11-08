import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const config = {
  root,
  dataDir: path.join(root, "data"),
  storeDir: path.join(root, "data", "store"),
  cacheDir: path.join(root, "data", "cache"),
  port: Number(process.env.PORT ?? 8787),
  meta: {
    apiKey: process.env.META_API_KEY ?? "",
    baseUrl: process.env.META_BASE_URL ?? "https://api.meta.ai/v1",
    model: process.env.META_MODEL ?? "muse-spark-1.3",
    // Image-capable model used to read chartplotter screenshots (defaults to the main model).
    visionModel: process.env.META_VISION_MODEL ?? process.env.META_MODEL ?? "muse-spark-1.3",
  },
  // Optional on-board model: any OpenAI-compatible local server (llama.cpp, Ollama, vLLM).
  local: {
    baseUrl: process.env.LOCAL_MODEL_URL ?? "",
    model: process.env.LOCAL_MODEL ?? "llama3.1:8b",
    visionModel: process.env.LOCAL_VISION_MODEL ?? process.env.LOCAL_MODEL ?? "llama3.2-vision",
  },
  modelProvider: (process.env.MODEL_PROVIDER ?? "meta") as "meta" | "local",
  subq: {
    apiKey: process.env.SUBQ_API_KEY ?? "",
    baseUrl: process.env.SUBQ_BASE_URL ?? "https://api.subq.ai/v1",
    model: process.env.SUBQ_MODEL ?? "subq-snap-1.1",
  },
  weather: {
    forecastUrl: "https://api.open-meteo.com/v1/forecast",
    marineUrl: "https://marine-api.open-meteo.com/v1/marine",
    staleAfterMinutes: 6 * 60,
  },
};
