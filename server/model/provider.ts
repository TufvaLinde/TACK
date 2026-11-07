import { config } from "../config.js";
import { netFetch, OfflineError } from "../net.js";

// Model-provider abstraction. The hosted Meta Model API is used today; an on-board
// Llama served by any OpenAI-compatible local server (llama.cpp, Ollama, vLLM) can
// replace it by setting MODEL_PROVIDER=local and LOCAL_MODEL_URL.

export interface ChatMessage {
  role: "developer" | "system" | "user" | "assistant";
  content: string;
}

export interface JsonSchemaSpec {
  name: string;
  schema: Record<string, unknown>;
}

export interface ModelProvider {
  readonly name: string;
  readonly model: string;
  readonly configured: boolean;
  /** true if the provider runs on the boat (usable without internet) */
  readonly local: boolean;
  complete(messages: ChatMessage[], opts?: { json?: JsonSchemaSpec; maxTokens?: number; effort?: string }): Promise<string>;
}

export class ModelError extends Error {
  constructor(msg: string, readonly status?: number) {
    super(msg);
    this.name = "ModelError";
  }
}

/** Shared implementation for OpenAI-style /chat/completions endpoints. */
class ChatCompletionsProvider implements ModelProvider {
  constructor(
    readonly name: string,
    readonly model: string,
    private baseUrl: string,
    private apiKey: string,
    readonly local: boolean,
  ) {}

  get configured() {
    return this.local ? !!this.baseUrl : !!this.apiKey;
  }

  async complete(messages: ChatMessage[], opts: { json?: JsonSchemaSpec; maxTokens?: number; effort?: string } = {}) {
    if (!this.configured) throw new ModelError(`${this.name} is not configured`);
    const body: Record<string, unknown> = {
      model: this.model,
      messages: this.local ? messages.map((m) => (m.role === "developer" ? { ...m, role: "system" } : m)) : messages,
      max_completion_tokens: opts.maxTokens ?? 4000,
    };
    if (!this.local) body.reasoning_effort = opts.effort ?? "low";
    if (opts.json) body.response_format = { type: "json_schema", json_schema: { name: opts.json.name, strict: true, schema: opts.json.schema } };

    const doFetch = () =>
      this.local
        ? fetch(`${this.baseUrl}/chat/completions`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(120_000) })
        : netFetch(`${this.baseUrl}/chat/completions`, {
            method: "POST",
            headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
            body: JSON.stringify(body),
            timeoutMs: 120_000,
          });

    let res = await doFetch();
    if (res.status === 429 || res.status >= 500) {
      await new Promise((r) => setTimeout(r, 1500));
      res = await doFetch();
    }
    const text = await res.text();
    if (!res.ok) {
      let msg = text.slice(0, 300);
      try { msg = JSON.parse(text).error?.message ?? msg; } catch { /* keep raw */ }
      throw new ModelError(`${this.name} HTTP ${res.status}: ${msg}`, res.status);
    }
    const j = JSON.parse(text);
    const content = j.choices?.[0]?.message?.content;
    if (typeof content !== "string") throw new ModelError(`${this.name}: response had no message content`);
    return content;
  }
}

export const metaProvider = new ChatCompletionsProvider("Meta Model API", config.meta.model, config.meta.baseUrl, config.meta.apiKey, false);
export const localProvider = new ChatCompletionsProvider("On-board Llama (OpenAI-compatible)", config.local.model, config.local.baseUrl, "", true);

let lastError: string | null = null;

/** Primary provider, falling back to the on-board model when the hosted one is unreachable. */
export const model = {
  get primary(): ModelProvider {
    return config.modelProvider === "local" ? localProvider : metaProvider;
  },
  get lastError() {
    return lastError;
  },
  async completeJson<T>(messages: ChatMessage[], schema: JsonSchemaSpec, opts: { maxTokens?: number; effort?: string } = {}): Promise<{ data: T; via: string }> {
    const text = await this.complete(messages, { ...opts, json: schema });
    try {
      return { data: JSON.parse(text.text) as T, via: text.via };
    } catch {
      throw new ModelError(`${text.via} returned invalid JSON`);
    }
  },
  async complete(messages: ChatMessage[], opts: { json?: JsonSchemaSpec; maxTokens?: number; effort?: string } = {}): Promise<{ text: string; via: string }> {
    const chain = [this.primary, ...(this.primary === localProvider ? [] : [localProvider])].filter((p) => p.configured);
    if (!chain.length) throw new ModelError("No language model configured (set META_API_KEY or LOCAL_MODEL_URL)");
    let err: Error | null = null;
    for (const p of chain) {
      try {
        const text = await p.complete(messages, opts);
        lastError = null;
        return { text, via: p.model };
      } catch (e) {
        err = e as Error;
        lastError = err.message;
        if (!(e instanceof OfflineError)) break; // only fall through on connectivity loss
      }
    }
    throw err!;
  },
};

export const isOffline = (e: unknown) => e instanceof OfflineError;
