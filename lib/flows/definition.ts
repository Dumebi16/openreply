import { z } from "zod";

const KEY = /^[a-z0-9_]+$/;

export class FlowDefinitionError extends Error {}

const optionSchema = z.object({
  key: z.string().regex(KEY, "option key: lowercase letters, digits, underscores"),
  label: z.string().min(1).max(20, "button label must be 20 characters or fewer"),
  next: z.string().min(1),
});

const stepSchema = z.object({
  key: z.string().regex(KEY, "step key: lowercase letters, digits, underscores"),
  message: z.string().min(1).max(1000),
  options: z
    .array(optionSchema)
    .min(1)
    .max(3, "a step can have at most 3 buttons")
    .optional(),
  /**
   * Send the campaign's tracked link(s) with this message. `true` = every
   * link as buttons, "primary" = first link only, "secondary" = second only.
   */
  deliverLink: z.union([z.boolean(), z.literal("primary"), z.literal("secondary")]).optional(),
  fallbackNext: z.string().min(1).optional(),
});

export const flowDefinitionSchema = z.object({
  entryStepKey: z.string().min(1),
  fallbackStepKey: z.string().min(1),
  steps: z.array(stepSchema).min(1).max(30),
});

export type FlowOption = z.infer<typeof optionSchema>;
export type FlowStep = z.infer<typeof stepSchema>;
export type FlowDefinition = z.infer<typeof flowDefinitionSchema>;

export function stepByKey(def: FlowDefinition, key: string): FlowStep | undefined {
  return def.steps.find((s) => s.key === key);
}

/** A step with no options never waits for a reply. */
export function isTerminal(step: FlowStep): boolean {
  return !step.options || step.options.length === 0;
}

export function validateFlowDefinition(input: unknown): FlowDefinition {
  const parsed = flowDefinitionSchema.safeParse(input);
  if (!parsed.success) {
    throw new FlowDefinitionError(
      parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")
    );
  }
  const def = parsed.data;
  const keys = new Set<string>();
  for (const step of def.steps) {
    if (keys.has(step.key)) throw new FlowDefinitionError(`duplicate step key "${step.key}"`);
    keys.add(step.key);
  }
  const mustExist = (ref: string, where: string) => {
    if (!keys.has(ref)) throw new FlowDefinitionError(`${where} points to unknown step "${ref}"`);
  };
  mustExist(def.entryStepKey, "entryStepKey");
  mustExist(def.fallbackStepKey, "fallbackStepKey");
  for (const step of def.steps) {
    // Both button questions and link deliveries go out as button templates,
    // which Instagram caps at 640 characters of text.
    if ((step.options || step.deliverLink) && step.message.length > 640) {
      throw new FlowDefinitionError(
        `step "${step.key}": message must be 640 characters or fewer when it has buttons or delivers the link`
      );
    }
    const optionKeys = new Set<string>();
    for (const opt of step.options ?? []) {
      if (optionKeys.has(opt.key)) {
        throw new FlowDefinitionError(`step "${step.key}": duplicate option key "${opt.key}"`);
      }
      optionKeys.add(opt.key);
      if (opt.key === "other") {
        throw new FlowDefinitionError(`step "${step.key}": "other" is reserved for the fallback`);
      }
      mustExist(opt.next, `step "${step.key}" option "${opt.key}"`);
    }
    if (step.fallbackNext) mustExist(step.fallbackNext, `step "${step.key}" fallbackNext`);
  }
  const fallback = stepByKey(def, def.fallbackStepKey)!;
  if (!isTerminal(fallback)) {
    throw new FlowDefinitionError(`fallback step "${fallback.key}" must not ask another question`);
  }
  return def;
}

export const FLOW_POSTBACK_PREFIX = "flow:";

export function encodeFlowPostback(flowId: string, stepKey: string, optionKey: string): string {
  return `${FLOW_POSTBACK_PREFIX}${flowId}:${stepKey}:${optionKey}`;
}

export function decodeFlowPostback(
  payload: string
): { flowId: string; stepKey: string; optionKey: string } | null {
  if (!payload.startsWith(FLOW_POSTBACK_PREFIX)) return null;
  const parts = payload.slice(FLOW_POSTBACK_PREFIX.length).split(":");
  if (parts.length !== 3 || parts.some((p) => !p)) return null;
  const [flowId, stepKey, optionKey] = parts;
  return { flowId, stepKey, optionKey };
}
