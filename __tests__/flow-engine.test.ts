import { describe, expect, it } from "vitest";
import { advance, enter } from "../lib/flows/engine";
import { validateFlowDefinition } from "../lib/flows/definition";

const def = validateFlowDefinition({
  entryStepKey: "who",
  fallbackStepKey: "any_link",
  steps: [
    {
      key: "who",
      message: "Running a business already, or just getting started?",
      options: [
        { key: "owner", label: "Running a business", next: "owner_link" },
        { key: "starter", label: "Just starting", next: "starter_link" },
      ],
    },
    { key: "owner_link", message: "Owner 👇", deliverLink: true },
    { key: "starter_link", message: "Starter 👇", deliverLink: true },
    { key: "any_link", message: "Either way 👇", deliverLink: true },
  ],
});

describe("enter", () => {
  it("asks the entry question and waits on it", () => {
    const r = enter(def);
    expect(r.nextStepKey).toBe("who");
    expect(r.actions).toEqual([{ type: "send_step", step: def.steps[0] }]);
  });
});

describe("advance with a button tap", () => {
  it("follows the option to a link step and ends", () => {
    const r = advance({ def, currentStepKey: "who", input: { kind: "postback", stepKey: "who", optionKey: "owner" }, minConfidence: 0.6 });
    expect(r.nextStepKey).toBeNull();
    expect(r.actions).toEqual([{ type: "deliver_link", step: def.steps[1] }]);
  });

  it("answers a stale tap from the step it was sent from", () => {
    const r = advance({ def, currentStepKey: "any_link", input: { kind: "postback", stepKey: "who", optionKey: "starter" }, minConfidence: 0.6 });
    expect(r.actions[0]).toEqual({ type: "deliver_link", step: def.steps[2] });
  });

  it("falls back on an unknown option", () => {
    const r = advance({ def, currentStepKey: "who", input: { kind: "postback", stepKey: "who", optionKey: "nope" }, minConfidence: 0.6 });
    expect(r.actions[0]).toEqual({ type: "deliver_link", step: def.steps[3] });
    expect(r.nextStepKey).toBeNull();
  });
});

describe("advance with a typed reply", () => {
  it("uses the classifier when confident", () => {
    const r = advance({ def, currentStepKey: "who", input: { kind: "text", text: "i run a bakery", classified: { optionKey: "owner", confidence: 0.92 } }, minConfidence: 0.6 });
    expect(r.actions[0]).toEqual({ type: "deliver_link", step: def.steps[1] });
  });

  it("falls back when the classifier is unsure", () => {
    const r = advance({ def, currentStepKey: "who", input: { kind: "text", text: "???", classified: { optionKey: "owner", confidence: 0.41 } }, minConfidence: 0.6 });
    expect(r.actions[0]).toEqual({ type: "deliver_link", step: def.steps[3] });
  });

  it("falls back when the classifier failed (null) or answered 'other'", () => {
    const a = advance({ def, currentStepKey: "who", input: { kind: "text", text: "hi", classified: null }, minConfidence: 0.6 });
    const b = advance({ def, currentStepKey: "who", input: { kind: "text", text: "hi", classified: { optionKey: "other", confidence: 0.99 } }, minConfidence: 0.6 });
    expect(a.actions[0].step.key).toBe("any_link");
    expect(b.actions[0].step.key).toBe("any_link");
  });

  it("prefers the step's own fallbackNext over the flow fallback", () => {
    const local = validateFlowDefinition({
      ...def,
      steps: def.steps.map((s) => (s.key === "who" ? { ...s, fallbackNext: "starter_link" } : s)),
    });
    const r = advance({ def: local, currentStepKey: "who", input: { kind: "text", text: "?", classified: null }, minConfidence: 0.6 });
    expect(r.actions[0].step.key).toBe("starter_link");
  });
});

describe("multi-step chains", () => {
  it("keeps waiting when the next step asks another question", () => {
    const chain = validateFlowDefinition({
      entryStepKey: "a",
      fallbackStepKey: "end",
      steps: [
        { key: "a", message: "A?", options: [{ key: "yes", label: "Yes", next: "b" }] },
        { key: "b", message: "B?", options: [{ key: "yes", label: "Yes", next: "end" }] },
        { key: "end", message: "Done 👇", deliverLink: true },
      ],
    });
    const r = advance({ def: chain, currentStepKey: "a", input: { kind: "postback", stepKey: "a", optionKey: "yes" }, minConfidence: 0.6 });
    expect(r.nextStepKey).toBe("b");
    expect(r.actions).toEqual([{ type: "send_step", step: chain.steps[1] }]);
  });
});
