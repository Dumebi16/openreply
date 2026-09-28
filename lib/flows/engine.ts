import { isTerminal, stepByKey, type FlowDefinition, type FlowStep } from "./definition";

export type FlowInput =
  | { kind: "postback"; stepKey: string; optionKey: string }
  | {
      kind: "text";
      text: string;
      classified: { optionKey: string; confidence: number } | null;
    };

export type FlowAction =
  | { type: "send_step"; step: FlowStep }
  | { type: "deliver_link"; step: FlowStep };

export type FlowResult = { nextStepKey: string | null; actions: FlowAction[] };

function actionFor(step: FlowStep): FlowAction {
  return step.deliverLink ? { type: "deliver_link", step } : { type: "send_step", step };
}

function goTo(def: FlowDefinition, key: string): FlowResult {
  const step = stepByKey(def, key) ?? stepByKey(def, def.fallbackStepKey)!;
  return { nextStepKey: isTerminal(step) ? null : step.key, actions: [actionFor(step)] };
}

export function enter(def: FlowDefinition): FlowResult {
  return goTo(def, def.entryStepKey);
}

export function advance({
  def,
  currentStepKey,
  input,
  minConfidence,
}: {
  def: FlowDefinition;
  currentStepKey: string;
  input: FlowInput;
  minConfidence: number;
}): FlowResult {
  // A tap carries the step it was sent from; trust that over the stored
  // pointer so a late tap on an older message still works.
  const stepKey = input.kind === "postback" ? input.stepKey : currentStepKey;
  const step = stepByKey(def, stepKey);
  if (!step || isTerminal(step)) return goTo(def, def.fallbackStepKey);

  let optionKey: string | null = null;
  if (input.kind === "postback") {
    optionKey = input.optionKey;
  } else if (
    input.classified &&
    input.classified.optionKey !== "other" &&
    input.classified.confidence >= minConfidence
  ) {
    optionKey = input.classified.optionKey;
  }

  const option = optionKey ? step.options!.find((o) => o.key === optionKey) : undefined;
  return goTo(def, option ? option.next : step.fallbackNext ?? def.fallbackStepKey);
}
