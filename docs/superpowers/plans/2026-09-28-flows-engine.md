# Flows Engine (Stage 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a campaign run a short branching conversation (question → tappable options or a typed reply → tailored link) instead of sending the link straight away, with Jev picking the branch when the person types instead of tapping.

**Architecture:** A `Flow` is attached to an existing campaign (`Automation`) and takes over at the exact moment the campaign would otherwise reveal the link. Triggers, public replies, opening DM, follow gate, rate limits and dedupe all stay as they are. The engine is a pure function (`advance`) over a validated JSON flow definition; a thin runtime around it sends messages and stores one `ConversationState` row per person per account. Button taps come back as `flow:` postbacks; typed replies are classified by Jev (OpenRouter `/api/alpha/decisions`, `choice` question) and fall back to a "send everything" step when unsure.

**Tech Stack:** Next.js 16 / TypeScript, Prisma 7 + PostgreSQL, BullMQ worker (`lib/queue/dm-worker.ts`), Zod 4, Vitest, Jev via OpenRouter (`typesafe/jev-1.13`).

**Spec:** `docs/superpowers/specs/2026-09-27-flows-and-ai-replies-design.md` (Stage 2 section). Deviation from the spec, agreed here: steps are stored as validated JSON on `Flow.definition` instead of a `FlowStep` table. Nothing queries individual steps, and the JSON is what the config import and the future form both edit, so a table would only add joins.

## Global Constraints

- Instagram button templates: max **3** buttons per message, button title max **20** characters, text max **640** characters when buttons are present (`lib/instagram/send-messages.ts:34,72-73`).
- Meta's 24-hour messaging window: a `ConversationState` expires 24 h after the person's last inbound event; an expired state is treated as absent.
- Jev never writes message text. It only picks one of the step's option keys (or `other`).
- Act on Jev only at confidence ≥ `FLOW_MIN_CONFIDENCE` (default `0.6`); otherwise take the fallback step. Hugh's decision for unclear replies: **send everything** (the fallback step delivers the link).
- All contact-tracking writes stay best-effort (`lib/contacts/record.ts`); a tracking failure never blocks a send.
- No send behaviour changes for campaigns without a flow. Every existing test in `__tests__/` must keep passing.
- Deploy: Railway's GitHub app is not installed; after pushing, deploy with `railway up --service web --detach --yes` and `railway up --service worker --detach --yes` from the repo root. Keep `main` fast-forwarded to `hugh/flows` (`git push origin hugh/flows:main`).
- Secrets: `OPENROUTER_API_KEY` is pasted into Railway (web + worker) by Hugh. Claude never handles it.

## Review Focus

1. **A stale button tap** (person taps an option from an *earlier* step, or after the state expired): expected → treated as that step's option if the step still exists, otherwise the flow restarts from its entry step; never a crash, never a duplicate guide. Test in Task 3 (`advance` with mismatched `stepKey`) and Task 6 (expired state on postback).
2. **A typed reply while no flow is active** (ordinary DM keyword campaign): expected → existing keyword behaviour, untouched. Test in Task 6 (`handleFlowReply` returns `false` with no state) and Task 7 (worker still runs keyword matching).
3. **Jev unreachable / no key / malformed answer**: expected → classifier returns `null`, engine takes the fallback step, person still gets the link. Tests in Task 4 (fetch throws, non-JSON, missing key) and Task 3 (`classified: null`).
4. **Flow definition with a dangling `next`** or 4 options: expected → rejected at import with a readable error, never saved. Test in Task 2.
5. **Two taps in quick succession** (double-tap the same button): expected → the person may receive the link twice (same as OpenReply's existing reveal button, which re-sends on every tap by design) but `GuideDelivery` stays one row and no crash. Test in Task 6 (`recordGuideDelivery` repeat keeps a single row — already covered by `__tests__/contact-tracking.test.ts`) and Task 3 (a tap on a terminal step falls back rather than throwing).

---

## File Structure

| File | Responsibility |
| --- | --- |
| `prisma/schema.prisma` (modify) | `Flow` (definition JSON, attached 1:1 to an `Automation`) and `ConversationState` (one row per person per account). |
| `lib/flows/definition.ts` (create) | Zod schema + TypeScript types for a flow definition; `validateFlowDefinition`; postback payload encode/decode. |
| `lib/flows/engine.ts` (create) | Pure `enter()` / `advance()`; no I/O. |
| `lib/flows/classify.ts` (create) | `classifyReply()` — Jev via OpenRouter, returns `{optionKey, confidence} \| null`. |
| `lib/flows/state.ts` (create) | Load / save / clear `ConversationState`, 24 h expiry. |
| `lib/flows/runtime.ts` (create) | `startFlow`, `handleFlowPostback`, `handleFlowReply`, `sendStepMessage`, `deliverFlowLink`. Talks to Instagram + DB; wraps the engine. |
| `lib/meta/client.ts` (modify) | `sendDirectMessageWithPostbackButtons`, `sendPrivateReplyWithPostbackButtons` (META provider, up to 3 postback buttons). |
| `lib/instagram/send-messages.ts` (modify) | Provider-neutral versions of the two helpers above (META + ZERNIO). |
| `lib/queue/dm-worker.ts` (modify) | Three hooks: `flow:` postbacks, active-state DM replies, and flow interception at the reveal points. |
| `lib/env.ts` (modify) | Optional `OPENROUTER_API_KEY`, `JEV_MODEL`, `FLOW_MIN_CONFIDENCE` accessors. |
| `app/api/flows/route.ts` (create) | `GET` list flows, `POST` upsert a flow for a campaign (owner/admin). |
| `flows/guide-qualifier.json` (create) | The first real flow (Hugh's "guide" campaign). |
| `docs/flows.md` (create) | How to write and import a flow. |
| `__tests__/flow-definition.test.ts`, `flow-engine.test.ts`, `flow-classify.test.ts`, `flow-runtime.test.ts` (create); `__tests__/dm-worker.test.ts` (modify) | Tests. |

---

### Task 1: Schema — `Flow` and `ConversationState`

**Files:**
- Modify: `prisma/schema.prisma` (Automation model relations at lines 218-219; append new models at end of file)
- Test: none (schema); verified by `prisma migrate dev` + `prisma generate` + `tsc`

**Interfaces:**
- Produces: Prisma models `Flow { id, workspaceId, automationId (unique), name, isActive, definition Json, createdAt, updatedAt }` and `ConversationState { id, instagramAccountId, igUserId, flowId, currentStepKey, expiresAt, createdAt, updatedAt }` with `@@unique([instagramAccountId, igUserId])`; `Automation.flow Flow?`.

- [ ] **Step 1: Add the relation on Automation**

In `prisma/schema.prisma`, inside `model Automation`, directly after the line `  guideDeliveries  GuideDelivery[]` (line 219), add:

```prisma
  flow             Flow?
```

- [ ] **Step 2: Append the two models at the end of the file**

```prisma

// ---------------------------------------------------------------------------
// Flows (Stage 2). A Flow is attached 1:1 to a campaign and takes over at the
// moment the campaign would otherwise reveal the link. Steps live in
// `definition` as JSON validated by lib/flows/definition.ts.
// ---------------------------------------------------------------------------

model Flow {
  id           String   @id @default(cuid())
  workspaceId  String
  automationId String   @unique
  name         String
  isActive     Boolean  @default(true)
  /// Validated FlowDefinition (see lib/flows/definition.ts).
  definition   Json
  createdAt    DateTime @default(now())
  updatedAt    DateTime @updatedAt

  workspace  Workspace  @relation(fields: [workspaceId], references: [id], onDelete: Cascade)
  automation Automation @relation(fields: [automationId], references: [id], onDelete: Cascade)
  states     ConversationState[]

  @@index([workspaceId])
}

/// Where one person is inside one flow. One row per person per account;
/// expiresAt enforces Meta's 24-hour messaging window.
model ConversationState {
  id                 String   @id @default(cuid())
  instagramAccountId String
  /// Instagram-scoped user id (same value as Contact.igUserId).
  igUserId           String
  flowId             String
  currentStepKey     String
  expiresAt          DateTime
  createdAt          DateTime @default(now())
  updatedAt          DateTime @updatedAt

  flow Flow @relation(fields: [flowId], references: [id], onDelete: Cascade)

  @@unique([instagramAccountId, igUserId])
  @@index([flowId])
  @@index([expiresAt])
}
```

Also add `  flows             Flow[]` to `model Workspace` directly after `  linkClicks        LinkClick[]` (line 85).

- [ ] **Step 3: Create the migration and regenerate the client**

Run (local Postgres on port 5433 must be up: `docker compose up -d`):

```bash
npx prisma migrate dev --name flows_engine
npx prisma generate
npx tsc --noEmit -p tsconfig.json
```

Expected: a new folder `prisma/migrations/<timestamp>_flows_engine/migration.sql` containing `CREATE TABLE "Flow"` and `CREATE TABLE "ConversationState"`; `tsc` prints nothing.

- [ ] **Step 4: Run the existing suite**

Run: `npx vitest run`
Expected: `27 passed | 1 skipped` (unchanged).

- [ ] **Step 5: Commit**

```bash
git add prisma/schema.prisma prisma/migrations
git commit -m "feat(flows): Flow and ConversationState models"
```

---

### Task 2: Flow definition schema + postback payload codec

**Files:**
- Create: `lib/flows/definition.ts`
- Test: `__tests__/flow-definition.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type FlowOption = { key: string; label: string; next: string };
  export type FlowStep = { key: string; message: string; options?: FlowOption[]; deliverLink?: boolean; fallbackNext?: string };
  export type FlowDefinition = { entryStepKey: string; fallbackStepKey: string; steps: FlowStep[] };
  export const flowDefinitionSchema: z.ZodType<FlowDefinition>;
  export function validateFlowDefinition(input: unknown): FlowDefinition; // throws FlowDefinitionError with a readable message
  export class FlowDefinitionError extends Error {}
  export function stepByKey(def: FlowDefinition, key: string): FlowStep | undefined;
  export function encodeFlowPostback(flowId: string, stepKey: string, optionKey: string): string; // "flow:<flowId>:<stepKey>:<optionKey>"
  export function decodeFlowPostback(payload: string): { flowId: string; stepKey: string; optionKey: string } | null;
  export const FLOW_POSTBACK_PREFIX = "flow:";
  ```
- Rules encoded in the schema: 1–3 options per step; option `label` 1–20 chars; `message` 1–640 chars if the step has options, else 1–1000; step keys and option keys match `/^[a-z0-9_]+$/`; every `next`, `fallbackNext`, `entryStepKey`, `fallbackStepKey` must name an existing step; a step with no options is terminal; the `fallbackStepKey` step must be terminal or deliver the link.

- [ ] **Step 1: Write the failing tests**

`__tests__/flow-definition.test.ts`:

```ts
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
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run __tests__/flow-definition.test.ts`
Expected: FAIL — cannot resolve `../lib/flows/definition`.

- [ ] **Step 3: Implement `lib/flows/definition.ts`**

```ts
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
  options: z.array(optionSchema).min(1).max(3, "a step can have at most 3 buttons").optional(),
  deliverLink: z.boolean().optional(),
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
    if (step.options && step.message.length > 640) {
      throw new FlowDefinitionError(`step "${step.key}": message must be 640 characters or fewer when it has buttons`);
    }
    const optionKeys = new Set<string>();
    for (const opt of step.options ?? []) {
      if (optionKeys.has(opt.key)) throw new FlowDefinitionError(`step "${step.key}": duplicate option key "${opt.key}"`);
      optionKeys.add(opt.key);
      if (opt.key === "other") throw new FlowDefinitionError(`step "${step.key}": "other" is reserved for the fallback`);
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
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run __tests__/flow-definition.test.ts`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/flows/definition.ts __tests__/flow-definition.test.ts
git commit -m "feat(flows): definition schema, validation and postback codec"
```

---

### Task 3: Pure engine — `enter` and `advance`

**Files:**
- Create: `lib/flows/engine.ts`
- Test: `__tests__/flow-engine.test.ts`

**Interfaces:**
- Consumes: `FlowDefinition`, `FlowStep`, `stepByKey`, `isTerminal` from Task 2.
- Produces:
  ```ts
  export type FlowInput =
    | { kind: "postback"; stepKey: string; optionKey: string }
    | { kind: "text"; text: string; classified: { optionKey: string; confidence: number } | null };
  export type FlowAction =
    | { type: "send_step"; step: FlowStep }      // ask a question (buttons) or plain message
    | { type: "deliver_link"; step: FlowStep };  // send the campaign link with step.message
  export type FlowResult = { nextStepKey: string | null; actions: FlowAction[] }; // null = conversation over
  export function enter(def: FlowDefinition): FlowResult;
  export function advance(args: { def: FlowDefinition; currentStepKey: string; input: FlowInput; minConfidence: number }): FlowResult;
  ```
- Behaviour: an action for a step with options leaves `nextStepKey = step.key` (waiting). A terminal step yields `nextStepKey = null`. `deliver_link` when `step.deliverLink`, otherwise `send_step`. A postback whose `stepKey` names a real step is answered from *that* step (stale taps still work); an unknown `stepKey` or `optionKey` → fallback. Text: use `classified.optionKey` only if `confidence >= minConfidence` and the option exists; otherwise `step.fallbackNext ?? def.fallbackStepKey`.

- [ ] **Step 1: Write the failing tests**

`__tests__/flow-engine.test.ts`:

```ts
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
    // person is (somehow) recorded on a later step but taps an old "who" button
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
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run __tests__/flow-engine.test.ts`
Expected: FAIL — cannot resolve `../lib/flows/engine`.

- [ ] **Step 3: Implement `lib/flows/engine.ts`**

```ts
import { isTerminal, stepByKey, type FlowDefinition, type FlowStep } from "./definition";

export type FlowInput =
  | { kind: "postback"; stepKey: string; optionKey: string }
  | { kind: "text"; text: string; classified: { optionKey: string; confidence: number } | null };

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
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run __tests__/flow-engine.test.ts`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/flows/engine.ts __tests__/flow-engine.test.ts
git commit -m "feat(flows): pure enter/advance engine"
```

---

### Task 4: Jev classifier + env accessors

**Files:**
- Create: `lib/flows/classify.ts`
- Modify: `lib/env.ts` (append accessors after `getMetaGraphApiVersion`, line ~49)
- Test: `__tests__/flow-classify.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // lib/env.ts
  export function getOpenRouterApiKey(): string | null;     // OPENROUTER_API_KEY or null
  export function getJevModel(): string;                    // JEV_MODEL, default "typesafe/jev-1.13"
  export function getFlowMinConfidence(): number;           // FLOW_MIN_CONFIDENCE, default 0.6, clamped 0..1
  // lib/flows/classify.ts
  export type ClassifiedReply = { optionKey: string; confidence: number };
  export async function classifyReply(args: {
    text: string;
    question: string;                                   // the step's message
    options: { key: string; label: string }[];
    fetchImpl?: typeof fetch;                           // for tests
    apiKey?: string | null;                             // defaults to getOpenRouterApiKey()
    timeoutMs?: number;                                 // default 4000
  }): Promise<ClassifiedReply | null>;
  ```
- Request body sent to `https://openrouter.ai/api/alpha/decisions`:
  `{ model, state: text, questions: { pick: { type: "choice", instructions, criteria: { <key>: <label>, ..., other: "None of these, unclear, or a different topic" } } } }`
- Response shape (verified live 2026-09-28): `{ answers: { pick: { type: "choice", choice: "owner", probabilities: {...}, confidence: 1 } }, usage: { cost } }`.

- [ ] **Step 1: Write the failing tests**

`__tests__/flow-classify.test.ts`:

```ts
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
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run __tests__/flow-classify.test.ts`
Expected: FAIL — cannot resolve `../lib/flows/classify`.

- [ ] **Step 3: Add env accessors to `lib/env.ts`**

Append after `getMetaGraphApiVersion` (do not touch `serverEnvSchema`; these are all optional):

```ts
/** OpenRouter key used for Jev flow-reply classification. Optional: without it,
 *  typed replies always take the flow's fallback step. */
export function getOpenRouterApiKey(): string | null {
  const key = process.env.OPENROUTER_API_KEY?.trim();
  return key ? key : null;
}

export function getJevModel(): string {
  return process.env.JEV_MODEL?.trim() || "typesafe/jev-1.13";
}

/** Minimum Jev confidence to act on a classified reply (0..1, default 0.6). */
export function getFlowMinConfidence(): number {
  const raw = Number(process.env.FLOW_MIN_CONFIDENCE);
  if (!Number.isFinite(raw)) return 0.6;
  return Math.min(1, Math.max(0, raw));
}
```

- [ ] **Step 4: Implement `lib/flows/classify.ts`**

```ts
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
    console.warn("[Flows] Jev classification failed (falling back):", error instanceof Error ? error.message : String(error));
    return null;
  } finally {
    clearTimeout(timer);
  }
}
```

- [ ] **Step 5: Run tests + type check**

Run: `npx vitest run __tests__/flow-classify.test.ts && npx tsc --noEmit -p tsconfig.json`
Expected: all PASS; tsc silent.

- [ ] **Step 6: Commit**

```bash
git add lib/flows/classify.ts lib/env.ts __tests__/flow-classify.test.ts
git commit -m "feat(flows): Jev reply classifier via OpenRouter"
```

---

### Task 5: Multi-button send helpers (Meta + Zernio)

**Files:**
- Modify: `lib/meta/client.ts` (add two functions after `sendDirectMessageWithButton`, ~line 250)
- Modify: `lib/instagram/send-messages.ts` (add two exported functions after `sendDirectMessageWithButton`, ~line 165)
- Test: `__tests__/flow-send-buttons.test.ts`

**Interfaces:**
- Produces (provider-neutral, in `lib/instagram/send-messages.ts`, re-exported by `lib/instagram/provider.ts` automatically via `export * from "./send-messages"`):
  ```ts
  export type PostbackButton = { title: string; payload: string };
  export async function sendDirectMessageWithPostbackButtons(args: { context: InstagramContext; instagramAccountId: string; userId: string; text: string; buttons: PostbackButton[] }): Promise<{ recipient_id?: string; message_id: string }>;
  export async function sendPrivateReplyWithPostbackButtons(args: { context: InstagramContext; instagramAccountId: string; commentId: string; text: string; buttons: PostbackButton[]; postId?: string }): Promise<{ recipient_id?: string; message_id: string }>;
  ```
  Both cap at 3 buttons and 20-char titles.

- [ ] **Step 1: Write the failing test**

`__tests__/flow-send-buttons.test.ts` (Zernio path is testable without network by mocking `zernioRequest`; Meta path by mocking `fetch`):

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockZernioRequest } = vi.hoisted(() => ({ mockZernioRequest: vi.fn() }));
vi.mock("@/lib/zernio/client", async (orig) => ({
  ...(await orig<typeof import("@/lib/zernio/client")>()),
  zernioRequest: mockZernioRequest,
}));

import {
  sendDirectMessageWithPostbackButtons,
  sendPrivateReplyWithPostbackButtons,
} from "../lib/instagram/send-messages";

const zernioContext = { provider: "ZERNIO", apiKey: "k", accountId: "acc_1", operationId: "op" } as never;
const metaContext = { provider: "META", accessToken: "tok" } as never;

beforeEach(() => {
  vi.clearAllMocks();
  mockZernioRequest.mockResolvedValue({ messageId: "m_1" });
});

describe("postback button sends (Zernio)", () => {
  it("sends up to 3 postback buttons with titles cut to 20 chars", async () => {
    await sendDirectMessageWithPostbackButtons({
      context: zernioContext, instagramAccountId: "ig_1", userId: "u_1", text: "Pick one",
      buttons: [
        { title: "A very long button title indeed", payload: "flow:f:s:a" },
        { title: "B", payload: "flow:f:s:b" },
        { title: "C", payload: "flow:f:s:c" },
        { title: "D", payload: "flow:f:s:d" },
      ],
    });
    const body = mockZernioRequest.mock.calls[0][0].body;
    expect(body.buttons).toHaveLength(3);
    expect(body.buttons[0]).toEqual({ type: "postback", title: "A very long button t", payload: "flow:f:s:a" });
    expect(mockZernioRequest.mock.calls[0][0].path).toBe("/inbox/conversations/u_1/messages");
  });

  it("private reply targets the comment", async () => {
    await sendPrivateReplyWithPostbackButtons({
      context: zernioContext, instagramAccountId: "ig_1", commentId: "c_9", postId: "p_9", text: "Pick",
      buttons: [{ title: "A", payload: "flow:f:s:a" }],
    });
    expect(mockZernioRequest.mock.calls[0][0].path).toBe("/inbox/comments/p_9/c_9/private-reply");
  });
});

describe("postback button sends (Meta)", () => {
  it("posts a button template with all buttons", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ recipient_id: "u_1", message_id: "m_1" }), { status: 200 })
    );
    await sendDirectMessageWithPostbackButtons({
      context: metaContext, instagramAccountId: "ig_1", userId: "u_1", text: "Pick",
      buttons: [{ title: "A", payload: "flow:f:s:a" }, { title: "B", payload: "flow:f:s:b" }],
    });
    const body = JSON.parse(fetchSpy.mock.calls[0][1]!.body as string);
    expect(body.message.attachment.payload.buttons).toEqual([
      { type: "postback", title: "A", payload: "flow:f:s:a" },
      { type: "postback", title: "B", payload: "flow:f:s:b" },
    ]);
    fetchSpy.mockRestore();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run __tests__/flow-send-buttons.test.ts`
Expected: FAIL — `sendDirectMessageWithPostbackButtons` is not exported.

- [ ] **Step 3: Add the Meta-side functions in `lib/meta/client.ts`**

Insert directly after `sendDirectMessageWithButton` (which ends around line 262). Mirror its request exactly; for the private reply, mirror the `recipient` shape used by `sendPrivateReplyWithButton` at line 177 (`recipient: { comment_id: commentId }`) and its error handling helper.

```ts
export type PostbackButtonSpec = { title: string; payload: string };

function postbackButtons(buttons: PostbackButtonSpec[]) {
  return buttons
    .slice(0, 3)
    .map(({ title, payload }) => ({ type: "postback", title: title.slice(0, 20), payload }));
}

/** Direct message with up to three postback buttons (flow questions). */
export async function sendDirectMessageWithPostbackButtons(
  accessToken: string,
  instagramAccountId: string,
  userId: string,
  text: string,
  buttons: PostbackButtonSpec[]
): Promise<{ recipient_id: string; message_id: string }> {
  const response = await fetch(`${instagramGraphBase()}/${instagramAccountId}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
    body: JSON.stringify({
      recipient: { id: userId },
      message: {
        attachment: {
          type: "template",
          payload: { template_type: "button", text: text.slice(0, 640), buttons: postbackButtons(buttons) },
        },
      },
    }),
  });
  return handleSendResponse(response); // use the same response/error handler sendDirectMessageWithButton uses
}

/** Private reply to a comment with up to three postback buttons. */
export async function sendPrivateReplyWithPostbackButtons(
  accessToken: string,
  instagramAccountId: string,
  commentId: string,
  text: string,
  buttons: PostbackButtonSpec[]
): Promise<{ recipient_id: string; message_id: string }> {
  const response = await fetch(`${instagramGraphBase()}/${instagramAccountId}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
    body: JSON.stringify({
      recipient: { comment_id: commentId },
      message: {
        attachment: {
          type: "template",
          payload: { template_type: "button", text: text.slice(0, 640), buttons: postbackButtons(buttons) },
        },
      },
    }),
  });
  return handleSendResponse(response);
}
```

Note for the implementer: `sendDirectMessageWithButton` at line 220 does not literally call a `handleSendResponse` helper; read lines 247-262 and reuse whatever it does with `response` (status check + `MetaApiError` throw + `response.json()`). If that logic is inline, extract it into a private `handleSendResponse(response: Response)` function and use it from all three places.

- [ ] **Step 4: Add the provider-neutral functions in `lib/instagram/send-messages.ts`**

Insert after `sendDirectMessageWithButton` (ends ~line 165):

```ts
export type PostbackButton = { title: string; payload: string };

function postbackButtonList(buttons: PostbackButton[]): Button[] {
  return buttons
    .slice(0, 3)
    .map(({ title, payload }) => ({ type: "postback", title: title.slice(0, 20), payload }));
}

export async function sendDirectMessageWithPostbackButtons({
  context,
  instagramAccountId,
  userId,
  text,
  buttons,
}: {
  context: InstagramContext;
  instagramAccountId: string;
  userId: string;
  text: string;
  buttons: PostbackButton[];
}) {
  if (context.provider === "META")
    return meta.sendDirectMessageWithPostbackButtons(context.accessToken, instagramAccountId, userId, text, buttons);
  return sendZernioMessage({ context, recipientId: userId, text, buttons: postbackButtonList(buttons) });
}

export async function sendPrivateReplyWithPostbackButtons({
  context,
  instagramAccountId,
  commentId,
  text,
  buttons,
  postId,
}: {
  context: InstagramContext;
  instagramAccountId: string;
  commentId: string;
  text: string;
  buttons: PostbackButton[];
  postId?: string;
}) {
  if (context.provider === "META")
    return meta.sendPrivateReplyWithPostbackButtons(context.accessToken, instagramAccountId, commentId, text, buttons);
  return sendZernioMessage({ context, commentId, postId, text, buttons: postbackButtonList(buttons) });
}
```

- [ ] **Step 5: Run tests + type check + full suite**

Run: `npx vitest run __tests__/flow-send-buttons.test.ts && npx tsc --noEmit -p tsconfig.json && npx vitest run`
Expected: new tests PASS; tsc silent; full suite still green.

- [ ] **Step 6: Commit**

```bash
git add lib/meta/client.ts lib/instagram/send-messages.ts __tests__/flow-send-buttons.test.ts
git commit -m "feat(flows): multi-button postback sends for Meta and Zernio"
```

---

### Task 6: Conversation state + runtime (start, postback, typed reply)

**Files:**
- Create: `lib/flows/state.ts`
- Create: `lib/flows/runtime.ts`
- Test: `__tests__/flow-runtime.test.ts`

**Interfaces:**
- Consumes: Task 2 (`decodeFlowPostback`, `encodeFlowPostback`, `validateFlowDefinition`, `stepByKey`), Task 3 (`enter`, `advance`), Task 4 (`classifyReply`, `getFlowMinConfidence`), Task 5 (`sendDirectMessageWithPostbackButtons`, `sendPrivateReplyWithPostbackButtons`), existing `sendDirectMessage`, `sendDirectMessageWithLinkButton`, `renderMessageWithoutLink`, `recordContactEvent`, `recordGuideDelivery`.
- Produces:
  ```ts
  // lib/flows/state.ts
  export const CONVERSATION_TTL_MS = 24 * 60 * 60 * 1000;
  export async function loadActiveState(instagramAccountId: string, igUserId: string): Promise<{ id: string; flowId: string; currentStepKey: string } | null>; // null if none or expired (expired rows are deleted)
  export async function saveState(args: { instagramAccountId: string; igUserId: string; flowId: string; currentStepKey: string | null }): Promise<void>; // null = clear
  // lib/flows/runtime.ts
  export type FlowAutomation = { id: string; workspaceId: string; instagramAccountId: string; dmMessage: string; linkButtonLabel: string | null; trackedLinks: { slug: string; label: string | null; destinationUrl: string }[]; instagramAccount: { instagramId: string }; flow: { id: string; isActive: boolean; definition: unknown } | null };
  export function hasActiveFlow(automation: FlowAutomation): boolean;
  export async function startFlow(args: { accessToken: InstagramContext; automation: FlowAutomation; userId: string; commenterName: string | null; via: { kind: "dm" } | { kind: "private_reply"; commentId: string; postId?: string } }): Promise<void>;
  export async function handleFlowPostback(args: { accessToken: InstagramContext; automation: FlowAutomation; userId: string; commenterName: string | null; payload: string }): Promise<boolean>; // false if payload is not a flow payload for this automation's flow
  export async function handleFlowReply(args: { instagramAccountId: string /* DB id */; instagramId: string /* IG id */; senderId: string; text: string; createContext: (automation: FlowAutomation) => Promise<InstagramContext>; }): Promise<boolean>; // false if no active state
  ```
- Link delivery reuses the campaign's tracked links: `deliverFlowLink` sends `step.message` (with `{username}` rendered) plus the tracked-link buttons built exactly like `buildLinkButtons` in the worker (`buildTrackedUrl(link.slug, undefined, userId)` for click attribution), falling back to inline text on template rejection, and records `DM_SENT` + `GUIDE_DELIVERED` via `recordContactEvent` / `recordGuideDelivery`.

- [ ] **Step 1: Write the failing tests**

`__tests__/flow-runtime.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockPrisma, mockSends, mockClassify, mockContacts } = vi.hoisted(() => ({
  mockPrisma: {
    conversationState: { findUnique: vi.fn(), upsert: vi.fn(), delete: vi.fn(), deleteMany: vi.fn() },
    automation: { findFirst: vi.fn() },
  },
  mockSends: {
    sendDirectMessageWithPostbackButtons: vi.fn(),
    sendPrivateReplyWithPostbackButtons: vi.fn(),
    sendDirectMessage: vi.fn(),
    sendDirectMessageWithLinkButton: vi.fn(),
  },
  mockClassify: vi.fn(),
  mockContacts: { recordContactEvent: vi.fn(), recordGuideDelivery: vi.fn() },
}));

vi.mock("@/lib/db/client", () => ({ prisma: mockPrisma }));
vi.mock("@/lib/instagram/provider", async (orig) => ({
  ...(await orig<typeof import("@/lib/instagram/provider")>()),
  ...mockSends,
}));
vi.mock("@/lib/flows/classify", () => ({ classifyReply: mockClassify }));
vi.mock("@/lib/contacts/record", () => mockContacts);

import { loadActiveState, saveState } from "../lib/flows/state";
import { handleFlowPostback, handleFlowReply, startFlow } from "../lib/flows/runtime";

const definition = {
  entryStepKey: "who",
  fallbackStepKey: "any_link",
  steps: [
    { key: "who", message: "Owner or starter, {username}?", options: [
      { key: "owner", label: "Running a business", next: "owner_link" },
      { key: "starter", label: "Just starting", next: "starter_link" },
    ] },
    { key: "owner_link", message: "Owner 👇", deliverLink: true },
    { key: "starter_link", message: "Starter 👇", deliverLink: true },
    { key: "any_link", message: "Either way 👇", deliverLink: true },
  ],
};

const automation = {
  id: "auto_1", workspaceId: "ws_1", instagramAccountId: "acct_1",
  dmMessage: "unused", linkButtonLabel: "Get The Free Guide",
  trackedLinks: [{ slug: "abc", label: null, destinationUrl: "https://g.test/x" }],
  instagramAccount: { instagramId: "ig_1" },
  flow: { id: "flow_1", isActive: true, definition },
};
const ctx = { provider: "ZERNIO", apiKey: "k", accountId: "a" } as never;

beforeEach(() => {
  vi.clearAllMocks();
  process.env.NEXTAUTH_URL = "https://x.test";
  mockPrisma.conversationState.upsert.mockResolvedValue({});
  mockPrisma.conversationState.deleteMany.mockResolvedValue({ count: 0 });
  mockSends.sendDirectMessageWithPostbackButtons.mockResolvedValue({ message_id: "m" });
  mockSends.sendPrivateReplyWithPostbackButtons.mockResolvedValue({ message_id: "m" });
  mockSends.sendDirectMessageWithLinkButton.mockResolvedValue({ message_id: "m" });
});

describe("state", () => {
  it("treats an expired row as absent and deletes it", async () => {
    mockPrisma.conversationState.findUnique.mockResolvedValue({ id: "s1", flowId: "flow_1", currentStepKey: "who", expiresAt: new Date(Date.now() - 1000) });
    expect(await loadActiveState("acct_1", "u_1")).toBeNull();
    expect(mockPrisma.conversationState.deleteMany).toHaveBeenCalledWith({ where: { id: "s1" } });
  });

  it("saveState with null clears the row", async () => {
    await saveState({ instagramAccountId: "acct_1", igUserId: "u_1", flowId: "flow_1", currentStepKey: null });
    expect(mockPrisma.conversationState.deleteMany).toHaveBeenCalledWith({ where: { instagramAccountId: "acct_1", igUserId: "u_1" } });
    expect(mockPrisma.conversationState.upsert).not.toHaveBeenCalled();
  });
});

describe("startFlow", () => {
  it("sends the entry question as a DM with flow postback buttons and saves state", async () => {
    await startFlow({ accessToken: ctx, automation, userId: "u_1", commenterName: "jane", via: { kind: "dm" } });
    expect(mockSends.sendDirectMessageWithPostbackButtons).toHaveBeenCalledWith({
      context: ctx, instagramAccountId: "ig_1", userId: "u_1",
      text: "Owner or starter, jane?",
      buttons: [
        { title: "Running a business", payload: "flow:flow_1:who:owner" },
        { title: "Just starting", payload: "flow:flow_1:who:starter" },
      ],
    });
    const upsert = mockPrisma.conversationState.upsert.mock.calls[0][0];
    expect(upsert.create).toMatchObject({ instagramAccountId: "acct_1", igUserId: "u_1", flowId: "flow_1", currentStepKey: "who" });
    expect(upsert.create.expiresAt.getTime()).toBeGreaterThan(Date.now() + 23 * 60 * 60 * 1000);
    expect(mockContacts.recordContactEvent).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ type: "DM_SENT", meta: expect.objectContaining({ via: "flow_step", step: "who" }) }));
  });

  it("uses a private reply when started from a comment", async () => {
    await startFlow({ accessToken: ctx, automation, userId: "u_1", commenterName: null, via: { kind: "private_reply", commentId: "c_1", postId: "p_1" } });
    expect(mockSends.sendPrivateReplyWithPostbackButtons).toHaveBeenCalledWith(expect.objectContaining({ commentId: "c_1", postId: "p_1" }));
    expect(mockSends.sendDirectMessageWithPostbackButtons).not.toHaveBeenCalled();
  });
});

describe("handleFlowPostback", () => {
  it("ignores non-flow payloads", async () => {
    expect(await handleFlowPostback({ accessToken: ctx, automation, userId: "u_1", commenterName: null, payload: "reveal:auto_1" })).toBe(false);
  });

  it("delivers the tailored link with the campaign's tracked buttons and clears state", async () => {
    const ok = await handleFlowPostback({ accessToken: ctx, automation, userId: "u_1", commenterName: "jane", payload: "flow:flow_1:who:owner" });
    expect(ok).toBe(true);
    expect(mockSends.sendDirectMessageWithLinkButton).toHaveBeenCalledWith({
      context: ctx, instagramAccountId: "ig_1", userId: "u_1",
      text: "Owner 👇",
      buttons: [{ title: "Get The Free Guide", url: "https://x.test/r/abc?c=u_1" }],
    });
    expect(mockContacts.recordGuideDelivery).toHaveBeenCalledWith(expect.objectContaining({ igUserId: "u_1" }), { automationId: "auto_1" });
    expect(mockPrisma.conversationState.deleteMany).toHaveBeenCalledWith({ where: { instagramAccountId: "acct_1", igUserId: "u_1" } });
  });

  it("ignores a tap for a different flow id", async () => {
    expect(await handleFlowPostback({ accessToken: ctx, automation, userId: "u_1", commenterName: null, payload: "flow:other_flow:who:owner" })).toBe(false);
    expect(mockSends.sendDirectMessageWithLinkButton).not.toHaveBeenCalled();
  });
});

describe("handleFlowReply", () => {
  const createContext = vi.fn(async () => ctx);

  it("returns false when there is no active state (keyword path continues)", async () => {
    mockPrisma.conversationState.findUnique.mockResolvedValue(null);
    expect(await handleFlowReply({ instagramAccountId: "acct_1", instagramId: "ig_1", senderId: "u_1", text: "guide", createContext })).toBe(false);
    expect(mockClassify).not.toHaveBeenCalled();
  });

  it("classifies with Jev and follows the branch", async () => {
    mockPrisma.conversationState.findUnique.mockResolvedValue({ id: "s1", flowId: "flow_1", currentStepKey: "who", expiresAt: new Date(Date.now() + 60_000) });
    mockPrisma.automation.findFirst.mockResolvedValue(automation);
    mockClassify.mockResolvedValue({ optionKey: "starter", confidence: 0.88 });
    expect(await handleFlowReply({ instagramAccountId: "acct_1", instagramId: "ig_1", senderId: "u_1", text: "just thinking about it", createContext })).toBe(true);
    expect(mockClassify).toHaveBeenCalledWith(expect.objectContaining({ text: "just thinking about it", options: [
      { key: "owner", label: "Running a business" }, { key: "starter", label: "Just starting" },
    ] }));
    expect(mockSends.sendDirectMessageWithLinkButton).toHaveBeenCalledWith(expect.objectContaining({ text: "Starter 👇" }));
  });

  it("sends everything when Jev is unsure", async () => {
    mockPrisma.conversationState.findUnique.mockResolvedValue({ id: "s1", flowId: "flow_1", currentStepKey: "who", expiresAt: new Date(Date.now() + 60_000) });
    mockPrisma.automation.findFirst.mockResolvedValue(automation);
    mockClassify.mockResolvedValue(null);
    await handleFlowReply({ instagramAccountId: "acct_1", instagramId: "ig_1", senderId: "u_1", text: "??", createContext });
    expect(mockSends.sendDirectMessageWithLinkButton).toHaveBeenCalledWith(expect.objectContaining({ text: "Either way 👇" }));
  });

  it("clears a state whose flow was deleted or deactivated and returns false", async () => {
    mockPrisma.conversationState.findUnique.mockResolvedValue({ id: "s1", flowId: "flow_1", currentStepKey: "who", expiresAt: new Date(Date.now() + 60_000) });
    mockPrisma.automation.findFirst.mockResolvedValue(null);
    expect(await handleFlowReply({ instagramAccountId: "acct_1", instagramId: "ig_1", senderId: "u_1", text: "hi", createContext })).toBe(false);
    expect(mockPrisma.conversationState.deleteMany).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run __tests__/flow-runtime.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement `lib/flows/state.ts`**

```ts
import { prisma } from "@/lib/db/client";

export const CONVERSATION_TTL_MS = 24 * 60 * 60 * 1000;

export async function loadActiveState(
  instagramAccountId: string,
  igUserId: string
): Promise<{ id: string; flowId: string; currentStepKey: string } | null> {
  const row = await prisma.conversationState.findUnique({
    where: { instagramAccountId_igUserId: { instagramAccountId, igUserId } },
    select: { id: true, flowId: true, currentStepKey: true, expiresAt: true },
  });
  if (!row) return null;
  if (row.expiresAt.getTime() <= Date.now()) {
    await prisma.conversationState.deleteMany({ where: { id: row.id } }).catch(() => {});
    return null;
  }
  return { id: row.id, flowId: row.flowId, currentStepKey: row.currentStepKey };
}

export async function saveState({
  instagramAccountId,
  igUserId,
  flowId,
  currentStepKey,
}: {
  instagramAccountId: string;
  igUserId: string;
  flowId: string;
  currentStepKey: string | null;
}): Promise<void> {
  if (currentStepKey === null) {
    await prisma.conversationState.deleteMany({ where: { instagramAccountId, igUserId } });
    return;
  }
  const expiresAt = new Date(Date.now() + CONVERSATION_TTL_MS);
  await prisma.conversationState.upsert({
    where: { instagramAccountId_igUserId: { instagramAccountId, igUserId } },
    create: { instagramAccountId, igUserId, flowId, currentStepKey, expiresAt },
    update: { flowId, currentStepKey, expiresAt },
  });
}
```

- [ ] **Step 4: Implement `lib/flows/runtime.ts`**

```ts
import { prisma } from "@/lib/db/client";
import { getFlowMinConfidence } from "@/lib/env";
import {
  sendDirectMessage,
  sendDirectMessageWithLinkButton,
  sendDirectMessageWithPostbackButtons,
  sendPrivateReplyWithPostbackButtons,
  type InstagramContext,
} from "@/lib/instagram/provider";
import { recordContactEvent, recordGuideDelivery } from "@/lib/contacts/record";
import { buildTrackedUrl, renderMessageWithoutLink } from "@/lib/tracking/message";
import { classifyReply } from "./classify";
import {
  decodeFlowPostback,
  encodeFlowPostback,
  stepByKey,
  validateFlowDefinition,
  type FlowDefinition,
  type FlowStep,
} from "./definition";
import { advance, enter, type FlowAction, type FlowInput } from "./engine";
import { loadActiveState, saveState } from "./state";

export type FlowAutomation = {
  id: string;
  workspaceId: string;
  instagramAccountId: string;
  dmMessage: string;
  linkButtonLabel: string | null;
  trackedLinks: { slug: string; label: string | null; destinationUrl: string }[];
  instagramAccount: { instagramId: string };
  flow: { id: string; isActive: boolean; definition: unknown } | null;
};

/** Prisma `include` fragment every worker query needs so `flow` is loaded. */
export const FLOW_INCLUDE = { flow: { select: { id: true, isActive: true, definition: true } } } as const;

export function hasActiveFlow(automation: FlowAutomation): boolean {
  return Boolean(automation.flow?.isActive);
}

function definitionOf(automation: FlowAutomation): FlowDefinition {
  return validateFlowDefinition(automation.flow!.definition);
}

function isTemplateRejection(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /template|button|attachment/i.test(message);
}

async function sendStepMessage({
  accessToken,
  automation,
  userId,
  commenterName,
  step,
  via,
}: {
  accessToken: InstagramContext;
  automation: FlowAutomation;
  userId: string;
  commenterName: string | null;
  step: FlowStep;
  via: { kind: "dm" } | { kind: "private_reply"; commentId: string; postId?: string };
}) {
  const text = renderMessageWithoutLink({ message: step.message, commenterName });
  const instagramAccountId = automation.instagramAccount.instagramId;
  const buttons = (step.options ?? []).map((o) => ({
    title: o.label,
    payload: encodeFlowPostback(automation.flow!.id, step.key, o.key),
  }));
  if (buttons.length === 0) {
    await sendDirectMessage({ context: accessToken, instagramAccountId, userId, message: text });
  } else if (via.kind === "private_reply") {
    await sendPrivateReplyWithPostbackButtons({ context: accessToken, instagramAccountId, commentId: via.commentId, postId: via.postId, text, buttons });
  } else {
    await sendDirectMessageWithPostbackButtons({ context: accessToken, instagramAccountId, userId, text, buttons });
  }
  await recordContactEvent(
    { instagramAccountId: automation.instagramAccountId, igUserId: userId, username: commenterName },
    { type: "DM_SENT", automationId: automation.id, meta: { via: "flow_step", step: step.key } }
  );
}

async function deliverFlowLink({
  accessToken,
  automation,
  userId,
  commenterName,
  step,
}: {
  accessToken: InstagramContext;
  automation: FlowAutomation;
  userId: string;
  commenterName: string | null;
  step: FlowStep;
}) {
  const text = renderMessageWithoutLink({ message: step.message, commenterName }) || "Here's your link:";
  const instagramAccountId = automation.instagramAccount.instagramId;
  const buttons = automation.trackedLinks.slice(0, 3).map((link, index) => ({
    url: buildTrackedUrl(link.slug, undefined, userId),
    title: (index === 0 ? automation.linkButtonLabel : link.label) || link.label || "Open link",
  }));
  if (buttons.length === 0) {
    await sendDirectMessage({ context: accessToken, instagramAccountId, userId, message: text });
  } else {
    try {
      await sendDirectMessageWithLinkButton({ context: accessToken, instagramAccountId, userId, text, buttons });
    } catch (error) {
      if (!isTemplateRejection(error)) throw error;
      await sendDirectMessage({ context: accessToken, instagramAccountId, userId, message: `${text}\n${buttons.map((b) => b.url).join("\n")}` });
    }
  }
  const key = { instagramAccountId: automation.instagramAccountId, igUserId: userId, username: commenterName };
  await recordContactEvent(key, { type: "DM_SENT", automationId: automation.id, meta: { via: "flow_link", step: step.key } });
  await recordGuideDelivery(key, { automationId: automation.id });
}

async function runActions({
  actions,
  nextStepKey,
  accessToken,
  automation,
  userId,
  commenterName,
  via,
}: {
  actions: FlowAction[];
  nextStepKey: string | null;
  accessToken: InstagramContext;
  automation: FlowAutomation;
  userId: string;
  commenterName: string | null;
  via: { kind: "dm" } | { kind: "private_reply"; commentId: string; postId?: string };
}) {
  for (const action of actions) {
    if (action.type === "deliver_link") {
      await deliverFlowLink({ accessToken, automation, userId, commenterName, step: action.step });
    } else {
      await sendStepMessage({ accessToken, automation, userId, commenterName, step: action.step, via });
    }
  }
  await saveState({
    instagramAccountId: automation.instagramAccountId,
    igUserId: userId,
    flowId: automation.flow!.id,
    currentStepKey: nextStepKey,
  });
}

/** Begin the flow for this person instead of revealing the link. */
export async function startFlow(args: {
  accessToken: InstagramContext;
  automation: FlowAutomation;
  userId: string;
  commenterName: string | null;
  via: { kind: "dm" } | { kind: "private_reply"; commentId: string; postId?: string };
}): Promise<void> {
  const result = enter(definitionOf(args.automation));
  await runActions({ ...args, ...result });
}

/** A `flow:` button tap. Returns false when the payload is not for this flow. */
export async function handleFlowPostback({
  accessToken,
  automation,
  userId,
  commenterName,
  payload,
}: {
  accessToken: InstagramContext;
  automation: FlowAutomation;
  userId: string;
  commenterName: string | null;
  payload: string;
}): Promise<boolean> {
  const decoded = decodeFlowPostback(payload);
  if (!decoded || !hasActiveFlow(automation) || decoded.flowId !== automation.flow!.id) return false;
  const def = definitionOf(automation);
  const state = await loadActiveState(automation.instagramAccountId, userId);
  const input: FlowInput = { kind: "postback", stepKey: decoded.stepKey, optionKey: decoded.optionKey };
  const result = advance({
    def,
    currentStepKey: state?.currentStepKey ?? decoded.stepKey,
    input,
    minConfidence: getFlowMinConfidence(),
  });
  await recordContactEvent(
    { instagramAccountId: automation.instagramAccountId, igUserId: userId, username: commenterName },
    { type: "BUTTON_TAP", automationId: automation.id, inbound: true, meta: { payload, flow: true } }
  );
  await runActions({ ...result, accessToken, automation, userId, commenterName, via: { kind: "dm" } });
  return true;
}

/**
 * A typed DM while a flow is waiting on this person. Returns false when there
 * is nothing waiting, so the caller continues with ordinary keyword matching.
 */
export async function handleFlowReply({
  instagramAccountId,
  instagramId,
  senderId,
  text,
  createContext,
}: {
  instagramAccountId: string;
  instagramId: string;
  senderId: string;
  text: string;
  createContext: (automation: FlowAutomation) => Promise<InstagramContext>;
}): Promise<boolean> {
  const state = await loadActiveState(instagramAccountId, senderId);
  if (!state) return false;

  const automation = (await prisma.automation.findFirst({
    where: { flow: { id: state.flowId, isActive: true }, isActive: true, instagramAccount: { instagramId } },
    include: {
      instagramAccount: true,
      trackedLinks: { select: { slug: true, label: true, destinationUrl: true }, orderBy: [{ position: "asc" }, { createdAt: "asc" }] },
      ...FLOW_INCLUDE,
    },
  })) as FlowAutomation | null;
  if (!automation) {
    await saveState({ instagramAccountId, igUserId: senderId, flowId: state.flowId, currentStepKey: null });
    return false;
  }

  const def = definitionOf(automation);
  const step = stepByKey(def, state.currentStepKey);
  const classified = step?.options
    ? await classifyReply({ text, question: step.message, options: step.options.map((o) => ({ key: o.key, label: o.label })) })
    : null;
  const result = advance({
    def,
    currentStepKey: state.currentStepKey,
    input: { kind: "text", text, classified },
    minConfidence: getFlowMinConfidence(),
  });
  const accessToken = await createContext(automation);
  await runActions({ ...result, accessToken, automation, userId: senderId, commenterName: null, via: { kind: "dm" } });
  return true;
}
```

Note: `orderBy: [{ position: "asc" }, { createdAt: "asc" }]` must match `TRACKED_LINK_ORDER` in `lib/tracking/link-order.ts`; import and use that constant instead if it is exported.

- [ ] **Step 5: Run tests + type check**

Run: `npx vitest run __tests__/flow-runtime.test.ts && npx tsc --noEmit -p tsconfig.json`
Expected: all PASS; tsc silent. If the `{username}` test fails because `renderMessageWithoutLink` renders "there" for a null name, that is correct behaviour; the test passes `"jane"`.

- [ ] **Step 6: Commit**

```bash
git add lib/flows/state.ts lib/flows/runtime.ts __tests__/flow-runtime.test.ts
git commit -m "feat(flows): conversation state and runtime (start, tap, typed reply)"
```

---

### Task 7: Wire the worker

**Files:**
- Modify: `lib/queue/dm-worker.ts`
  - imports (after the `@/lib/contacts/record` import block)
  - `sendRevealDirectMessage` (~line 142) — intercept when a flow is active; return `{ delivered: "link" | "flow" }`
  - `processComment` link branch (`} else if (automation.trackedLinks.length > 0) {` ~line 630) — flow via private reply
  - `processComment` SENT block (`const linkDelivered = !useOpeningDm && !sendFollowPrompt;`) — no `GUIDE_DELIVERED` when the flow started
  - `processPostback` top (after the `automation` guard `return;`) — `flow:` payloads
  - `processPostback` SENT block — record guide only if `delivered === "link"`
  - `processMessage` (after the DM_IN block) — active state → `handleFlowReply`
  - `processMessage` SENT block — record guide only if `delivered === "link"`
  - every `prisma.automation.findMany/findFirst` `include` in the three processors — add `...FLOW_INCLUDE`
- Test: `__tests__/dm-worker.test.ts` (add a `describe("flows", ...)` block)

**Interfaces:**
- Consumes: Task 6 (`FLOW_INCLUDE`, `hasActiveFlow`, `startFlow`, `handleFlowPostback`, `handleFlowReply`, `FlowAutomation`).

- [ ] **Step 1: Write the failing tests (append to `__tests__/dm-worker.test.ts`)**

Add to the hoisted mocks: `mockPrisma.conversationState = { findUnique: vi.fn(), upsert: vi.fn(), deleteMany: vi.fn() }` and `mockSendDirectMessageWithPostbackButtons: vi.fn()`, `mockSendPrivateReplyWithPostbackButtons: vi.fn()`; add both to the `@/lib/meta/client` / provider mock the same way `mockSendDirectMessageWithButton` is wired (search the file for `sendDirectMessageWithButton:` and add the two new names next to it). Also mock `@/lib/flows/classify` → `{ classifyReply: vi.fn().mockResolvedValue(null) }`.

```ts
describe("flows", () => {
  const flowDefinition = {
    entryStepKey: "who",
    fallbackStepKey: "any_link",
    steps: [
      { key: "who", message: "Owner or starter?", options: [
        { key: "owner", label: "Running a business", next: "owner_link" },
        { key: "starter", label: "Just starting", next: "starter_link" },
      ] },
      { key: "owner_link", message: "Owner 👇", deliverLink: true },
      { key: "starter_link", message: "Starter 👇", deliverLink: true },
      { key: "any_link", message: "Either way 👇", deliverLink: true },
    ],
  };
  const flowAutomation = () => ({
    id: "auto_789", workspaceId: "ws_1", instagramAccountId: "acct_1",
    name: "Guide", keywords: ["guide"], wholeWordMatch: true, matchAnyWord: false, matchAnyPost: true,
    dmMessage: "Here 👇", linkButtonLabel: "Get The Free Guide", isActive: true,
    openingDmEnabled: false, requireFollow: false, publicReplyEnabled: false, publicReplyMessages: [],
    followUpEnabled: false, followUpDelayMinutes: 0,
    trackedLinks: [{ slug: "abc123", label: null, destinationUrl: "https://example.com/x" }],
    instagramAccount: { id: "acct_1", instagramId: "ig_456", accessToken: "enc", provider: "META", workspaceId: "ws_1" },
    workspace: { id: "ws_1" },
    flow: { id: "flow_1", isActive: true, definition: flowDefinition },
  });

  beforeEach(() => {
    mockPrisma.conversationState.findUnique.mockResolvedValue(null);
    mockPrisma.conversationState.upsert.mockResolvedValue({});
    mockPrisma.conversationState.deleteMany.mockResolvedValue({ count: 0 });
    mockSendPrivateReplyWithPostbackButtons.mockResolvedValue({ message_id: "m" });
    mockSendDirectMessageWithPostbackButtons.mockResolvedValue({ message_id: "m" });
  });

  it("a comment on a campaign with a flow gets the question as a private reply, not the link", async () => {
    mockPrisma.automation.findMany.mockResolvedValue([flowAutomation()]);
    mockPrisma.dmLog.findUnique.mockResolvedValue(null);
    mockPrisma.dmLog.upsert.mockResolvedValue({});
    mockPrisma.dmLog.update.mockResolvedValue({});
    mockMatchKeywords.mockReturnValue({ matched: true, matchedKeyword: "guide" });
    const processor = getProcessor();
    await processor(createMockJob());
    expect(mockSendPrivateReplyWithPostbackButtons).toHaveBeenCalledWith(expect.objectContaining({
      commentId: "comment_555",
      buttons: [
        { title: "Running a business", payload: "flow:flow_1:who:owner" },
        { title: "Just starting", payload: "flow:flow_1:who:starter" },
      ],
    }));
    expect(mockSendPrivateReplyWithLinkButton).not.toHaveBeenCalled();
    expect(mockPrisma.conversationState.upsert).toHaveBeenCalled();
  });

  it("a flow button tap delivers the tailored link", async () => {
    mockPrisma.automation.findFirst.mockResolvedValue(flowAutomation());
    mockPrisma.dmLog.findFirst.mockResolvedValue(null);
    const processor = getProcessor();
    await processor(createMockPostbackJob({ instagramAccountId: "ig_456", userId: "commenter_999", payload: "flow:flow_1:who:owner" }));
    expect(mockSendDirectMessageWithLinkButton).toHaveBeenCalledWith(
      "decrypted_token", "ig_456", "commenter_999", "Owner 👇",
      [{ title: "Get The Free Guide", url: "http://localhost:3000/r/abc123?c=commenter_999" }]
    );
    expect(mockPrisma.conversationState.deleteMany).toHaveBeenCalled();
  });

  it("a typed reply with an active state is routed by the flow and skips keyword matching", async () => {
    mockPrisma.conversationState.findUnique.mockResolvedValue({ id: "s1", flowId: "flow_1", currentStepKey: "who", expiresAt: new Date(Date.now() + 60_000) });
    mockPrisma.automation.findMany.mockResolvedValue([flowAutomation()]);
    mockPrisma.automation.findFirst.mockResolvedValue(flowAutomation());
    const processor = getProcessor();
    await processor({ name: "process-message", data: { instagramAccountId: "ig_456", messageId: "mid_1", messageText: "not sure", senderId: "commenter_999" }, id: "msg_1", attemptsMade: 0 });
    // classifier mocked to null → fallback "send everything"
    expect(mockSendDirectMessageWithLinkButton).toHaveBeenCalledWith(expect.anything(), "ig_456", "commenter_999", "Either way 👇", expect.anything());
    expect(mockMatchKeywords).not.toHaveBeenCalled();
  });
});
```

Adjust the exact positional-vs-object argument shape of `mockSendDirectMessageWithLinkButton` to match how the existing tests assert it (search the file for `mockSendDirectMessageWithLinkButton).toHaveBeenCalledWith` and copy that shape).

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run __tests__/dm-worker.test.ts -t flows`
Expected: FAIL — the link is sent instead of the question / postback ignored.

- [ ] **Step 3: Wire imports and `FLOW_INCLUDE`**

At the top of `lib/queue/dm-worker.ts`, after the `@/lib/contacts/record` import:

```ts
import {
  FLOW_INCLUDE,
  handleFlowPostback,
  handleFlowReply,
  hasActiveFlow,
  startFlow,
  type FlowAutomation,
} from "@/lib/flows/runtime";
```

In `processComment`, `processPostback`, `processMessage` and `processFollowUp`, find every `include: {` on `prisma.automation.findMany` / `findFirst` and add `...FLOW_INCLUDE,` as the last entry of that include object.

- [ ] **Step 4: Intercept in `sendRevealDirectMessage`**

Change the `RevealAutomation` type and the function:

```ts
type RevealAutomation = FlowAutomation;

async function sendRevealDirectMessage({
  accessToken,
  automation,
  userId,
  commenterName,
  context,
}: {
  accessToken: InstagramContext;
  automation: RevealAutomation;
  userId: string;
  commenterName: string | null;
  context: string;
}): Promise<{ delivered: "link" | "flow" }> {
  if (hasActiveFlow(automation)) {
    await startFlow({ accessToken, automation, userId, commenterName, via: { kind: "dm" } });
    return { delivered: "flow" };
  }
  // ...existing body unchanged...
  return { delivered: "link" };
}
```

Add `return { delivered: "link" };` at the end of the existing body (after the try/catch), and make the early `return;` in the no-tracked-links branch `return { delivered: "link" };`.

- [ ] **Step 5: `processPostback` — flow payloads and guide recording**

Directly after the guard that ends with `return;\n  }` following `!hasInstagramCredentials(automation.instagramAccount)`, and before `// Duplicate sends are enabled`, insert:

```ts
  if (payload.startsWith("flow:")) {
    let flowContext: InstagramContext;
    try {
      flowContext = await createInstagramContext(automation.instagramAccount, `${job.id}:${automation.id}`);
    } catch {
      return;
    }
    const openingLog = await prisma.dmLog.findFirst({
      where: { automationId: automation.id, commenterId: userId },
      select: { commenterName: true },
    });
    await handleFlowPostback({
      accessToken: flowContext,
      automation: automation as FlowAutomation,
      userId,
      commenterName: openingLog?.commenterName ?? null,
      payload,
    });
    return;
  }
```

But the `automation` lookup at the top of `processPostback` only matches `reveal:`/`followcheck:` payloads (`if (!isFollowCheck && !payload.startsWith("reveal:")) return;` and `automationId = payload.slice(...)`). Change the top of the function to:

```ts
  const flowPayload = decodeFlowPostback(payload);
  const isFollowCheck = payload.startsWith("followcheck:");
  if (!flowPayload && !isFollowCheck && !payload.startsWith("reveal:")) return;
  const automationId = flowPayload
    ? null
    : payload.slice(isFollowCheck ? "followcheck:".length : "reveal:".length);

  const automation = await prisma.automation.findFirst({
    where: flowPayload
      ? { flow: { id: flowPayload.flowId }, isActive: true, ...connectionScope(job.data) }
      : { id: automationId!, isActive: true, ...connectionScope(job.data) },
    include: { /* unchanged */ ...FLOW_INCLUDE },
  });
```

(import `decodeFlowPostback` from `@/lib/flows/definition`.)

Then where the reveal is sent inside `sendPostbackOnce`, capture the result:

```ts
    let revealOutcome: { delivered: "link" | "flow" } = { delivered: "link" };
    const delivered = await sendPostbackOnce({
      operationId,
      send: async () => {
        revealOutcome = await sendRevealDirectMessage({ accessToken, automation, userId, commenterName, context: "postback" });
      },
    });
```

and in the SENT block replace `await recordGuideDelivery(contactKey, { automationId: automation.id });` with:

```ts
    if (revealOutcome.delivered === "link") {
      await recordGuideDelivery(contactKey, { automationId: automation.id });
    }
```

(also change the `DM_SENT` meta `via` to `revealOutcome.delivered === "flow" ? "flow_start" : "reveal"`.)

- [ ] **Step 6: `processMessage` — route active conversations first**

Directly after the DM_IN recording block (ends with `  }\n` after `recordContactEvent(... type: "DM_IN" ...)`), insert:

```ts
  // Someone mid-conversation: the flow answers, keyword campaigns do not.
  if (inboundAccount) {
    const routed = await handleFlowReply({
      instagramAccountId: inboundAccount.id,
      instagramId: instagramAccountId,
      senderId,
      text: messageText,
      createContext: (automation) =>
        createInstagramContext(automation.instagramAccount as Parameters<typeof createInstagramContext>[0], `${job.id}:flow`),
    });
    if (routed) return;
  }
```

`handleFlowReply` loads the automation with `instagramAccount: true`, so the cast is safe; if TypeScript complains, widen `FlowAutomation.instagramAccount` in Task 6 to `InstagramAccount` (the Prisma type) instead of `{ instagramId: string }`.

In the SENT block of `processMessage`, capture the reveal outcome the same way as Step 5:

```ts
      } else {
        revealOutcome = await sendRevealDirectMessage({ ... context: "message trigger" });
```

(declare `let revealOutcome: { delivered: "link" | "flow" } = { delivered: "link" };` above the `try`) and guard `recordGuideDelivery` with `revealOutcome.delivered === "link"`.

- [ ] **Step 7: `processComment` — flow via private reply**

In the link branch (`} else if (automation.trackedLinks.length > 0) {`), wrap the existing button/fallback code:

```ts
      } else if (automation.trackedLinks.length > 0) {
        if (hasActiveFlow(automation as FlowAutomation)) {
          await startFlow({
            accessToken,
            automation: automation as FlowAutomation,
            userId: commenterId,
            commenterName: commenterName ?? null,
            via: { kind: "private_reply", commentId, postId: mediaId },
          });
        } else {
          // ...existing bodyText / buildLinkButtons / sendPrivateReplyWithLinkButton / fallback code, unchanged...
        }
      } else {
```

and in the SENT block change `const linkDelivered = !useOpeningDm && !sendFollowPrompt;` to
`const linkDelivered = !useOpeningDm && !sendFollowPrompt && !hasActiveFlow(automation as FlowAutomation);`.

- [ ] **Step 8: Run the flow tests, then the whole suite and type check**

Run: `npx vitest run __tests__/dm-worker.test.ts -t flows && npx vitest run && npx tsc --noEmit -p tsconfig.json && npx eslint lib/flows lib/queue/dm-worker.ts`
Expected: all PASS; tsc and eslint silent. Existing tests must not change.

- [ ] **Step 9: Commit**

```bash
git add lib/queue/dm-worker.ts __tests__/dm-worker.test.ts
git commit -m "feat(flows): worker hooks — start at reveal, route taps and typed replies"
```

---

### Task 8: Flows API (list + upsert) and the first flow file

**Files:**
- Create: `app/api/flows/route.ts`
- Create: `flows/guide-qualifier.json`
- Create: `docs/flows.md`
- Test: `__tests__/flows-api.test.ts`

**Interfaces:**
- `GET /api/flows` → `{ success: true, data: { flows: { id, automationId, name, isActive, definition }[] } }` for the current workspace.
- `POST /api/flows` body `{ automationId: string; name: string; isActive?: boolean; definition: unknown }` → validates with `validateFlowDefinition`, checks the automation belongs to the workspace, upserts by `automationId`, returns `{ success: true, data: { id } }`. Owners/admins only (`canManageWorkspace`). Invalid definition → `400 { success: false, error: "<readable message>" }`.

- [ ] **Step 1: Write the failing test**

`__tests__/flows-api.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockPrisma, mockContext } = vi.hoisted(() => ({
  mockPrisma: { automation: { findFirst: vi.fn() }, flow: { upsert: vi.fn(), findMany: vi.fn() } },
  mockContext: vi.fn(),
}));
vi.mock("@/lib/db/client", () => ({ prisma: mockPrisma }));
vi.mock("@/lib/workspace-access", async (orig) => ({
  ...(await orig<typeof import("@/lib/workspace-access")>()),
  getCurrentWorkspaceContext: mockContext,
}));

import { GET, POST } from "../app/api/flows/route";

const goodDefinition = {
  entryStepKey: "q", fallbackStepKey: "end",
  steps: [
    { key: "q", message: "Q?", options: [{ key: "a", label: "A", next: "end" }] },
    { key: "end", message: "Done 👇", deliverLink: true },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  mockContext.mockResolvedValue({ workspaceId: "ws_1", role: "OWNER", userId: "u" });
  mockPrisma.automation.findFirst.mockResolvedValue({ id: "auto_1", workspaceId: "ws_1" });
  mockPrisma.flow.upsert.mockResolvedValue({ id: "flow_1" });
});

function post(body: unknown) {
  return POST(new Request("http://x/api/flows", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }) as never);
}

describe("POST /api/flows", () => {
  it("upserts a valid flow for a campaign in the workspace", async () => {
    const res = await post({ automationId: "auto_1", name: "Guide", definition: goodDefinition });
    expect(res.status).toBe(200);
    expect(mockPrisma.flow.upsert).toHaveBeenCalledWith(expect.objectContaining({ where: { automationId: "auto_1" } }));
  });

  it("rejects an invalid definition with the validator's message", async () => {
    const bad = { ...goodDefinition, entryStepKey: "nope" };
    const res = await post({ automationId: "auto_1", name: "Guide", definition: bad });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/nope/);
  });

  it("refuses a campaign from another workspace", async () => {
    mockPrisma.automation.findFirst.mockResolvedValue(null);
    const res = await post({ automationId: "auto_9", name: "X", definition: goodDefinition });
    expect(res.status).toBe(404);
  });

  it("refuses members", async () => {
    mockContext.mockResolvedValue({ workspaceId: "ws_1", role: "MEMBER", userId: "u" });
    const res = await post({ automationId: "auto_1", name: "X", definition: goodDefinition });
    expect(res.status).toBe(403);
  });
});

describe("GET /api/flows", () => {
  it("lists the workspace's flows", async () => {
    mockPrisma.flow.findMany.mockResolvedValue([{ id: "flow_1", automationId: "auto_1", name: "Guide", isActive: true, definition: goodDefinition }]);
    const res = await GET();
    expect((await res.json()).data.flows).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run __tests__/flows-api.test.ts`
Expected: FAIL — route module missing.

- [ ] **Step 3: Implement `app/api/flows/route.ts`**

```ts
import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db/client";
import { FlowDefinitionError, validateFlowDefinition } from "@/lib/flows/definition";
import { canManageWorkspace, getCurrentWorkspaceContext } from "@/lib/workspace-access";

export const dynamic = "force-dynamic";

const bodySchema = z.object({
  automationId: z.string().min(1),
  name: z.string().min(1).max(100),
  isActive: z.boolean().optional().default(true),
  definition: z.unknown(),
});

export async function GET() {
  const context = await getCurrentWorkspaceContext();
  if (!context) return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  const flows = await prisma.flow.findMany({
    where: { workspaceId: context.workspaceId },
    select: { id: true, automationId: true, name: true, isActive: true, definition: true, updatedAt: true },
    orderBy: { updatedAt: "desc" },
  });
  return NextResponse.json({ success: true, data: { flows } });
}

export async function POST(request: Request) {
  const context = await getCurrentWorkspaceContext();
  if (!context) return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  if (!canManageWorkspace(context.role)) {
    return NextResponse.json({ success: false, error: "Only owners and admins can edit flows" }, { status: 403 });
  }
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ success: false, error: "Invalid input" }, { status: 400 });

  let definition;
  try {
    definition = validateFlowDefinition(parsed.data.definition);
  } catch (error) {
    if (error instanceof FlowDefinitionError) return NextResponse.json({ success: false, error: error.message }, { status: 400 });
    throw error;
  }

  const automation = await prisma.automation.findFirst({
    where: { id: parsed.data.automationId, workspaceId: context.workspaceId },
    select: { id: true },
  });
  if (!automation) return NextResponse.json({ success: false, error: "Campaign not found" }, { status: 404 });

  const flow = await prisma.flow.upsert({
    where: { automationId: automation.id },
    create: { workspaceId: context.workspaceId, automationId: automation.id, name: parsed.data.name, isActive: parsed.data.isActive, definition },
    update: { name: parsed.data.name, isActive: parsed.data.isActive, definition },
    select: { id: true },
  });
  return NextResponse.json({ success: true, data: { id: flow.id } });
}
```

- [ ] **Step 4: Write the first flow, `flows/guide-qualifier.json`**

```json
{
  "name": "Guide qualifier",
  "definition": {
    "entryStepKey": "who",
    "fallbackStepKey": "any_link",
    "steps": [
      {
        "key": "who",
        "message": "Quick one before I send it 👇 Are you running a business already, or just getting started?",
        "options": [
          { "key": "owner", "label": "Running a business", "next": "owner_link" },
          { "key": "starter", "label": "Just starting", "next": "starter_link" }
        ]
      },
      {
        "key": "owner_link",
        "message": "Here you go bro 🔥 the full step-by-step to own your business email for basically free. Grab it below 👇\n\nAnd when you're ready to systemise the whole business, the $99 Business Systems Blueprint is the next step: https://agamaco.gumroad.com/l/business-systems-blueprint",
        "deliverLink": true
      },
      {
        "key": "starter_link",
        "message": "Here you go bro 🔥 the full step-by-step to own your business email for basically free. Grab it below 👇\n\nTip: set the email up first, everything else hangs off it.",
        "deliverLink": true
      },
      {
        "key": "any_link",
        "message": "Either way, here you go bro 🔥 the full step-by-step to own your business email for basically free. Grab it below 👇",
        "deliverLink": true
      }
    ]
  }
}
```

The 640-character limit only applies to steps with buttons; the three link steps are sent with URL buttons, whose text is also capped at 640 by the provider layer, so keep each under 640 (all three are).

- [ ] **Step 5: Write `docs/flows.md`**

```markdown
# Flows

A flow attaches to one campaign and replaces "send the link" with a short
conversation. Everything before that point (keyword, public reply, opening DM,
follow gate) is unchanged.

## Shape

- `entryStepKey`: the first step, sent when the campaign would have revealed the link.
- `fallbackStepKey`: where unclear typed replies go. Must not ask a question.
- `steps[]`: each has a `key`, a `message`, and either
  - `options[]` (1–3 buttons, label ≤ 20 chars; `next` names a step), or
  - nothing (a terminal message), optionally `deliverLink: true` to send the
    campaign's tracked link buttons with this message.
- `{username}` in a message is replaced by the person's name when known.

Taps come back as `flow:<flowId>:<step>:<option>` postbacks. Typed replies are
classified by Jev (OpenRouter, `OPENROUTER_API_KEY`); below
`FLOW_MIN_CONFIDENCE` (default 0.6), or with no key, the reply takes the
fallback. A conversation expires 24 h after the person's last message.

## Import a flow

From the dashboard (signed in as owner/admin), open the browser console and run:

```js
await fetch('/api/flows', { method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ automationId: '<campaign id>', ...(await (await fetch('/flows/guide-qualifier.json')).json()) }) }).then(r => r.json())
```

or POST the same JSON with any HTTP client using your session cookie. Re-posting
the same `automationId` replaces the flow.
```

- [ ] **Step 6: Run tests, type check, full suite**

Run: `npx vitest run __tests__/flows-api.test.ts && npx tsc --noEmit -p tsconfig.json && npx vitest run`
Expected: all PASS.

- [ ] **Step 7: Commit**

```bash
git add app/api/flows/route.ts flows/guide-qualifier.json docs/flows.md __tests__/flows-api.test.ts
git commit -m "feat(flows): flows API (list/upsert), first guide-qualifier flow, docs"
```

---

### Task 9: Deploy, import the flow, live test

**Files:** none new. Operational.

- [ ] **Step 1: Push and deploy**

```bash
git push origin hugh/flows && git push origin hugh/flows:main
railway up --service web --detach --yes
railway up --service worker --detach --yes
```

Wait until `railway deployment list --service web --json` and `--service worker` both show the newest deployment `SUCCESS`, then:

```bash
curl -s https://web-production-fa5cf.up.railway.app/api/health
```

Expected: `"status":"ok"` with `worker.healthy: true`. The web start command runs `prisma migrate deploy`, so the `Flow` / `ConversationState` tables are created on deploy; confirm the web deploy log shows `Applying migration ..._flows_engine`.

- [ ] **Step 2: Hugh pastes `OPENROUTER_API_KEY`**

Hugh adds `OPENROUTER_API_KEY` to the Railway **web** service Variables (value from his OpenRouter dashboard), then Claude aliases it to the worker without touching the value:

```bash
railway variable set --service worker 'OPENROUTER_API_KEY=${{web.OPENROUTER_API_KEY}}'
```

Without the key the flow still works; typed replies just always get the "either way" link.

- [ ] **Step 3: Import the flow onto the live campaign**

In Chrome (signed in to OpenReply), from the page console or via `javascript_tool`:

```js
const autos = await fetch('/api/automations').then(r => r.json());
const auto = autos.data.find(a => a.name.startsWith('Free business email guide'));
const file = await fetch('/flows/guide-qualifier.json').then(r => r.json()); // if not served, paste the JSON inline
await fetch('/api/flows', { method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ automationId: auto.id, name: file.name, definition: file.definition }) }).then(r => r.json());
```

Expected: `{ success: true, data: { id: "..." } }`. (`flows/` is not under `public/`, so paste the JSON inline if the fetch 404s.)

- [ ] **Step 4: Live test from a second Instagram account**

1. Comment `guide` on a learnwithdums reel → public reply + opening DM with "Send Me The Link".
2. Tap it → follow gate "Following" (if not following) → tap → **the question with two buttons** appears instead of the link.
3. Tap "Running a business" → owner message + "Get The Free Guide" button. Click it → Gumroad.
4. Comment `guide` again (new comment) → at the question, **type** "just thinking about starting" → starter message + link (Jev routed).
5. Comment again → at the question, type "lol" → "Either way" message + link (fallback).

Check `DM Logs` for SENT rows and the worker log (`railway service logs --service worker`) for `[Flows]` warnings (none expected).

- [ ] **Step 5: Record**

Update memory `openreply-manychat-replacement.md` (flow live, Jev key set or not) and the vault session log (ask Hugh first). Commit nothing further.

---

## Self-review notes

- **Spec coverage:** ConversationState + 24 h expiry (Task 1, 6); pure engine (Task 3); Jev `choice` classification with confidence threshold and `other` (Task 4, 3); hook before keyword matching in `processMessage` and at the reveal points (Task 7); config import (Task 8); tests for engine, classifier and worker (Tasks 3, 4, 7). Stage 3 dashboard form is explicitly not in this plan.
- **Type consistency:** `FlowAutomation.flow.definition` is `unknown` and validated on every use via `validateFlowDefinition`; `sendRevealDirectMessage` now returns `{ delivered }` and both callers were updated (Task 7 steps 5-6). `FLOW_INCLUDE` is spread into every automation query the worker makes so `flow` is always present.
- **Review Focus mapping:** (1) stale tap → Task 3 "answers a stale tap" + Task 6 expired state; (2) no-state typed reply → Task 6 "returns false" + Task 7 third test; (3) Jev failure → Task 4 + Task 3 null/`other`; (4) bad definition → Task 2 + Task 8 API 400; (5) double tap → a second tap re-runs `advance` from the tapped step and re-sends that link (consistent with OpenReply's reveal button); `GuideDelivery` is unique per (contact, automation) so it never duplicates, and Task 3's terminal-step guard prevents a throw.
