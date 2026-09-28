import { describe, expect, it } from "vitest";
import {
  decodeFlowPostback,
  encodeFlowPostback,
  FlowDefinitionError,
  validateFlowDefinition,
} from "../lib/flows/definition";

const valid = {
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
      fallbackNext: "any_link",
    },
    { key: "owner_link", message: "Owner version 👇", deliverLink: true },
    { key: "starter_link", message: "Starter version 👇", deliverLink: true },
    { key: "any_link", message: "Either way, here you go 👇", deliverLink: true },
  ],
};

describe("validateFlowDefinition", () => {
  it("accepts a well-formed definition", () => {
    expect(validateFlowDefinition(valid).entryStepKey).toBe("who");
  });

  it("rejects a dangling next reference with a readable message", () => {
    const bad = JSON.parse(JSON.stringify(valid));
    bad.steps[0].options[0].next = "nowhere";
    expect(() => validateFlowDefinition(bad)).toThrow(FlowDefinitionError);
    expect(() => validateFlowDefinition(bad)).toThrow(/nowhere/);
  });

  it("rejects more than 3 options", () => {
    const bad = JSON.parse(JSON.stringify(valid));
    bad.steps[0].options.push(
      { key: "c", label: "C", next: "any_link" },
      { key: "d", label: "D", next: "any_link" }
    );
    expect(() => validateFlowDefinition(bad)).toThrow(/3/);
  });

  it("rejects a button label longer than 20 characters", () => {
    const bad = JSON.parse(JSON.stringify(valid));
    bad.steps[0].options[0].label = "This label is far too long";
    expect(() => validateFlowDefinition(bad)).toThrow(/20/);
  });

  it("rejects a message over 640 characters when the step has buttons", () => {
    const bad = JSON.parse(JSON.stringify(valid));
    bad.steps[0].message = "x".repeat(641);
    expect(() => validateFlowDefinition(bad)).toThrow(/640/);
  });

  it("rejects duplicate step keys and an unknown entry step", () => {
    const dup = JSON.parse(JSON.stringify(valid));
    dup.steps.push({ key: "who", message: "again" });
    expect(() => validateFlowDefinition(dup)).toThrow(/duplicate/i);
    const noEntry = { ...valid, entryStepKey: "missing" };
    expect(() => validateFlowDefinition(noEntry)).toThrow(/missing/);
  });

  it("rejects a fallback step that asks another question", () => {
    const bad = JSON.parse(JSON.stringify(valid));
    bad.fallbackStepKey = "who";
    expect(() => validateFlowDefinition(bad)).toThrow(/fallback/i);
  });
});

describe("postback codec", () => {
  it("round-trips", () => {
    const p = encodeFlowPostback("flow_1", "who", "owner");
    expect(p).toBe("flow:flow_1:who:owner");
    expect(decodeFlowPostback(p)).toEqual({ flowId: "flow_1", stepKey: "who", optionKey: "owner" });
  });

  it("returns null for non-flow payloads", () => {
    expect(decodeFlowPostback("reveal:auto_1")).toBeNull();
    expect(decodeFlowPostback("flow:only_two")).toBeNull();
  });
});
