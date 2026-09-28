import { describe, expect, it, vi } from "vitest";
import { classifyReply } from "../lib/flows/classify";

const options = [
  { key: "owner", label: "Running a business" },
  { key: "starter", label: "Just starting" },
];

function fetchReturning(body: unknown, status = 200): typeof fetch {
  return vi.fn(async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
}

describe("classifyReply", () => {
  it("returns Jev's choice and confidence", async () => {
    const fetchImpl = fetchReturning({ answers: { pick: { type: "choice", choice: "owner", probabilities: { owner: 0.9, starter: 0.1, other: 0 }, confidence: 0.9 } } });
    const r = await classifyReply({ text: "I run a bakery", question: "Owner or starter?", options, fetchImpl, apiKey: "test" });
    expect(r).toEqual({ optionKey: "owner", confidence: 0.9 });
    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe("https://openrouter.ai/api/alpha/decisions");
    const sent = JSON.parse((init as RequestInit).body as string);
    expect(sent.state).toBe("I run a bakery");
    expect(sent.questions.pick.criteria).toEqual({
      owner: "Running a business",
      starter: "Just starting",
      other: "None of these, unclear, or a different topic",
    });
    expect((init as RequestInit).headers).toMatchObject({ Authorization: "Bearer test" });
  });

  it("returns null when there is no API key", async () => {
    const fetchImpl = fetchReturning({});
    const r = await classifyReply({ text: "x", question: "q", options, fetchImpl, apiKey: null });
    expect(r).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("returns null on a non-2xx response, a network error, or a malformed body", async () => {
    expect(await classifyReply({ text: "x", question: "q", options, apiKey: "k", fetchImpl: fetchReturning({ error: "nope" }, 500) })).toBeNull();
    const throwing = vi.fn(async () => { throw new Error("ECONNRESET"); }) as unknown as typeof fetch;
    expect(await classifyReply({ text: "x", question: "q", options, apiKey: "k", fetchImpl: throwing })).toBeNull();
    expect(await classifyReply({ text: "x", question: "q", options, apiKey: "k", fetchImpl: fetchReturning({ answers: {} }) })).toBeNull();
  });

  it("returns null when Jev names an option that does not exist", async () => {
    const fetchImpl = fetchReturning({ answers: { pick: { type: "choice", choice: "banana", probabilities: {}, confidence: 0.99 } } });
    expect(await classifyReply({ text: "x", question: "q", options, apiKey: "k", fetchImpl })).toBeNull();
  });

  it("passes 'other' through so the engine can fall back", async () => {
    const fetchImpl = fetchReturning({ answers: { pick: { type: "choice", choice: "other", probabilities: {}, confidence: 0.8 } } });
    expect(await classifyReply({ text: "x", question: "q", options, apiKey: "k", fetchImpl })).toEqual({ optionKey: "other", confidence: 0.8 });
  });
});
