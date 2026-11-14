/**
 * Server-only client for the Verda-hosted NVIDIA Nemotron 3.5 Super VL endpoint (OpenAI-compatible,
 * served by vLLM). Used ONLY in the proposal / narration layer: search interpretation, seasonal
 * suggestions, recipe planning. Nothing here can approve, reject or place an order — every product
 * the LLM proposes still goes through aimo-api's quote and policyEngine's checks unchanged.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";

const BASE_URL = process.env.VERDA_BASE_URL ?? "https://containers.datacrunch.io/nemotron-3-5-super-vl-b300/v1";
const MODEL = process.env.VERDA_MODEL ?? "nemotron-3.5-super-vl";

export const LLM_LABEL = "NVIDIA Nemotron 3.5 Super VL (Verda)";

/** Key from VERDA_INFERENCE_KEY (e.g. on Vercel), else read from the file named by
 *  VERDA_INFERENCE_KEY_FILE (local dev, e.g. ~/.config/verda/inference-key — shared with opencode). */
function inferenceKey(): string | null {
  if (process.env.VERDA_INFERENCE_KEY) return process.env.VERDA_INFERENCE_KEY.trim();
  const file = process.env.VERDA_INFERENCE_KEY_FILE;
  if (!file) return null;
  try {
    return readFileSync(file.replace(/^~(?=\/)/, homedir()), "utf-8").trim() || null;
  } catch {
    return null;
  }
}

export function llmConfigured(): boolean {
  return inferenceKey() !== null;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/** One chat completion that must return a JSON object. Thinking is off by default: these are
 *  short structured transformations where reasoning tokens add ~5x latency for no quality gain. */
export async function chatJSON<T>(
  messages: ChatMessage[],
  opts: { maxTokens?: number; temperature?: number; thinking?: boolean; timeoutMs?: number } = {}
): Promise<T> {
  const key = inferenceKey();
  if (!key) throw new Error("No Verda key: set VERDA_INFERENCE_KEY or VERDA_INFERENCE_KEY_FILE");

  const controller = new AbortController();
  // Features that chain two calls (recipe plan, seasonal, ai search) must stay well under the
  // route's 60s maxDuration even in the worst case, or Vercel kills the function and serves its
  // own HTML error page instead of JSON — hence the lower default than a single-call route needs.
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 20_000);
  try {
    const res = await fetch(`${BASE_URL}/chat/completions`, {
      method: "POST",
      signal: controller.signal,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: MODEL,
        messages,
        max_tokens: opts.maxTokens ?? 1500,
        temperature: opts.temperature ?? 0.2,
        response_format: { type: "json_object" },
        chat_template_kwargs: { enable_thinking: opts.thinking ?? false }
      })
    });
    if (!res.ok) throw new Error(`LLM request failed: ${res.status} ${(await res.text()).slice(0, 300)}`);
    const data = await res.json();
    const content: string = data.choices?.[0]?.message?.content ?? "";
    return parseJSONLoose<T>(content);
  } finally {
    clearTimeout(timer);
  }
}

/** Route-level safety net: a route's `maxDuration` is a hard platform kill that serves an HTML
 *  error page instead of JSON, which breaks `res.json()` on the client. Racing against a timeout
 *  a few seconds short of that limit lets the route return a normal JSON error instead. */
export async function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer!);
  }
}

function parseJSONLoose<T>(text: string): T {
  const cleaned = text.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
  try {
    return JSON.parse(cleaned) as T;
  } catch {
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start >= 0 && end > start) return JSON.parse(cleaned.slice(start, end + 1)) as T;
    throw new Error(`LLM did not return JSON: ${cleaned.slice(0, 200)}`);
  }
}
