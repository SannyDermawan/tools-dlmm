import Anthropic from "@anthropic-ai/sdk";
import type { Config } from "../config/schema.ts";

/** One structured completion: system prompt + user content, answer constrained to a JSON schema. */
export interface LlmRequest {
  system: string;
  user: string;
  /** JSON schema of the answer (objects closed with additionalProperties: false) */
  schema: Record<string, unknown>;
}

export interface LlmResponse {
  text: string;
  servedModel: string;
  inputTokens: number;
  outputTokens: number;
  /** "refusal" when the whole chain declined; the text is then not usable */
  stopReason: string | null;
}

export interface LlmProvider {
  complete(req: LlmRequest): Promise<LlmResponse>;
}

/**
 * Anthropic Messages API through the official SDK: structured outputs (output_config.format),
 * effort from the config, and the server-side refusal fallback (fallbacks: "default") so a
 * classifier decline is retried on the recommended model inside the same call. No sampling
 * parameters: current Claude models reject temperature (consistency comes from the fixed schema
 * and prompt instead).
 */
export class AnthropicProvider implements LlmProvider {
  private readonly client: Anthropic;
  constructor(private readonly c: Config["llm"], apiKey: string | undefined) {
    this.client = new Anthropic({ apiKey: apiKey || undefined, timeout: c.timeout_ms, maxRetries: 2 });
  }

  async complete(req: LlmRequest): Promise<LlmResponse> {
    const res = await this.client.beta.messages.create({
      model: this.c.model,
      max_tokens: this.c.max_tokens,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { effort: this.c.effort, format: { type: "json_schema", schema: req.schema } },
      system: req.system,
      messages: [{ role: "user", content: req.user }],
    });
    let text = "";
    for (const b of res.content) if (b.type === "text") text += b.text;
    return {
      text,
      servedModel: res.model,
      inputTokens: res.usage.input_tokens + (res.usage.cache_read_input_tokens ?? 0) + (res.usage.cache_creation_input_tokens ?? 0),
      outputTokens: res.usage.output_tokens,
      stopReason: res.stop_reason,
    };
  }
}

/**
 * OpenAI-compatible /chat/completions (hosted endpoints or a local model server such as Ollama or
 * llama.cpp): JSON-schema response format and a low temperature.
 */
export class OpenAiCompatibleProvider implements LlmProvider {
  constructor(private readonly c: Config["llm"], private readonly apiKey: string | undefined, private readonly fetchImpl: typeof fetch = fetch) {
    if (!c.base_url) throw new Error("llm.base_url is required for openai_compatible / local providers");
  }

  async complete(req: LlmRequest): Promise<LlmResponse> {
    const url = `${this.c.base_url!.replace(/\/$/, "")}/chat/completions`;
    const res = await this.fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}) },
      signal: AbortSignal.timeout(this.c.timeout_ms),
      body: JSON.stringify({
        model: this.c.model,
        temperature: this.c.temperature,
        max_tokens: this.c.max_tokens,
        response_format: { type: "json_schema", json_schema: { name: "answer", strict: true, schema: req.schema } },
        messages: [
          { role: "system", content: req.system },
          { role: "user", content: req.user },
        ],
      }),
    });
    const j = (await res.json().catch(() => null)) as {
      model?: string; choices?: { message?: { content?: string }; finish_reason?: string }[]; usage?: { prompt_tokens?: number; completion_tokens?: number }; error?: { message?: string };
    } | null;
    if (!res.ok || !j) throw new Error(`HTTP ${res.status}: ${j?.error?.message ?? "no body"}`.slice(0, 300));
    return {
      text: j.choices?.[0]?.message?.content ?? "",
      servedModel: j.model ?? this.c.model,
      inputTokens: j.usage?.prompt_tokens ?? 0,
      outputTokens: j.usage?.completion_tokens ?? 0,
      stopReason: j.choices?.[0]?.finish_reason ?? null,
    };
  }
}

export function providerFromConfig(c: Config["llm"], env = process.env): LlmProvider {
  const key = env[c.api_key_env]?.trim();
  if (c.provider === "anthropic") return new AnthropicProvider(c, key);
  return new OpenAiCompatibleProvider(c, key);
}
