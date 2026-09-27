# OpenReply for @learnwithdums: Flows + AI-routed replies

Date: 2026-09-27. Owner: Hugh Anetoh. Approved in chat 2026-09-27.

## Purpose

Replace Hugh's ManyChat subscription with a self-hosted OpenReply fork that does
comment-to-DM today and, on top, multi-step branching conversations where an AI
(Jev) reads a typed reply and picks the next step. Instagram account:
`learnwithdums` (personal brand). Not Project Agama's account.

Success: from a second Instagram account, comment the trigger word on a
learnwithdums reel; receive a question DM within a minute; reply by tapping a
button or typing; receive the correct branch's link.

## Decisions (from Hugh)

| Question | Decision |
| --- | --- |
| Account | Personal brand, `learnwithdums` |
| AI job | Understand replies and pick the next step. No free-form AI chat in v1. |
| Hosting | Railway for web app, worker, Postgres, Redis. Code in GitHub `Dumebi16/openreply`. |
| Instagram connection | Zernio provider (existing subscription). No own Meta app review. |
| Out of scope v1 | Drag-and-drop canvas, broadcasts, WhatsApp, Messenger, TikTok, AI free-chat. |

## Stages

### Stage 1: Stock OpenReply live
Fork (done), local boot on Mac, Railway deploy (web + worker + Postgres + Redis),
Resend for magic-link login, Zernio connection with Inbox-capable API key,
import `learnwithdums`, one keyword campaign verified end to end.

### Stage 2: Flows engine
New Prisma models:
- `Flow` — workspaceId, instagramAccountId, name, trigger (keywords, optional
  postId / matchAnyPost, dmTriggerEnabled), isActive, entryStepKey.
- `FlowStep` — flowId, key, message, options[] as JSON `{label, nextStepKey}`,
  fallbackStepKey, isTerminal. Options render as Instagram quick-reply buttons
  where supported.
- `ConversationState` — instagramAccountId, senderId, flowId, currentStepKey,
  expiresAt (last inbound + 24h), updatedAt. Unique on (account, sender).

Engine hook: in `worker` `processMessage`, before keyword matching, look up
ConversationState for (account, sender). If present and unexpired, route to the
flow engine; otherwise fall through to existing behaviour, then check Flow
triggers (DM) — and in `processComment`, check Flow triggers (comment) — to
start a flow: send entry step, create state.

Flow engine is a pure function `advance(flow, step, state, inboundText) ->
{nextStep, actions}` so it is unit-testable without Instagram or a DB.

Branch selection: exact button-payload match first; else Jev `choice` question
over the step's option labels plus `other`; on Jev error/timeout or low
confidence, take `fallbackStepKey`. Jev never writes message text.

Errors: expired state is treated as no state. Send failure logs to DmLog and
leaves state unchanged. Meta's 24h window enforced via expiresAt.

Config import: flows can be created from a JSON/YAML sketch so Hugh can write a
flow in plain text and have it pasted in before the UI exists.

### Stage 3: Flow builder screen
Dashboard form: flow name, trigger, ordered list of steps, each with message and
answer rows ("label → go to step"). List-based, no canvas.

## Human-only steps
Railway signup; Zernio API key creation and paste into OpenReply Settings;
pasting secrets into Railway variables. Claude never enters credentials into
hosted services.

## Cost
Railway ~$5–10/mo; Zernio existing plan (Inbox access to verify); Jev pennies;
Resend free.
