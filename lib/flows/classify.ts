import { getJevModel, getOpenRouterApiKey } from "@/lib/env";

export type ClassifiedReply = { optionKey: string; confidence: number };

const ENDPOINT = "https://openrouter.ai/api/alpha/decisions";
export const OTHER_LABEL = "None of these, unclear, or a different topic";

/**
 * Ask Jev which of the step's options a typed reply means. Never throws:
 * any failure (no key, network, non-2xx, unexpected shape, unknown option)
 * returns null and the engine falls back. Jev only picks; it never writes.
 */
export async function classifyReply({
  text,
  question,
  options,
  fetchImpl = fetch,
  apiKey = getOpenRouterApiKey(),
  timeoutMs = 4000,
}: {
  text: string;
  question: string;
  options: { key: string; label: string }[];
  fetchImpl?: typeof fetch;
  apiKey?: string | null;
  timeoutMs?: number;
}): Promise<ClassifiedReply | null> {
  if (!apiKey || options.length === 0) return null;

  const criteria: Record<string, string> = {};
  for (const o of options) criteria[o.key] = o.label;
  criteria.other = OTHER_LABEL;

  const body = {
    model: getJevModel(),
    state: text.slice(0, 2000),
    questions: {
      pick: {
        type: "choice",
        instructions: `The person was asked: "${question}". Which option does their reply mean?`,
        criteria,
      },
    },
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(ENDPOINT, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!response.ok) return null;
    const json = (await response.json()) as {
      answers?: { pick?: { choice?: unknown; confidence?: unknown } };
    };
    const pick = json.answers?.pick;
    if (!pick || typeof pick.choice !== "string" || typeof pick.confidence !== "number") return null;
    if (!(pick.choice in criteria)) return null;
    return { optionKey: pick.choice, confidence: pick.confidence };
  } catch (error) {
    console.warn(
      "[Flows] Jev classification failed (falling back):",
      error instanceof Error ? error.message : String(error)
    );
    return null;
  } finally {
    clearTimeout(timer);
  }
}
