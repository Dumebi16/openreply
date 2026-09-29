# Runbook (Hugh's deployment)

This fork runs Hugh Anetoh's Instagram comment-to-DM automation for @learnwithdums.
Plain-English copy of this runbook: the Obsidian vault note "OpenReply — Runbook".

## Hosting
- Railway project `openreply` (services `web`, `worker`, `Postgres`, `Redis`), environment `production`.
- Public URL: https://web-production-fa5cf.up.railway.app
- Both app services build this repo's `Dockerfile`. The container start command comes from the
  `START_COMMAND` variable (`web`: `npm run db:migrate && npm run start`, `worker`: `npm run worker`).
  The Dockerfile uses `eval` so `&&` works.
- Railway's GitHub app is NOT installed, so a push does not deploy. Deploy with:
  `railway up --service web --detach --yes` and `railway up --service worker --detach --yes`.
- Keep `main` equal to `hugh/flows` (`git push origin hugh/flows:main`): a Railway settings change
  rebuilds from GitHub `main`.

## Environment variables (identical on web and worker)
`NEXTAUTH_URL`, `NEXTAUTH_SECRET`, `CRON_SECRET`, `ENCRYPTION_KEY`, `DATABASE_URL` (`${{Postgres.DATABASE_URL}}`),
`REDIS_URL` (`${{Redis.REDIS_URL}}`), `EMAIL_FROM`, `ALLOWED_EMAILS`, `META_GRAPH_API_VERSION`, `NODE_ENV`,
`RESEND_API_KEY` (login emails), `OPENROUTER_API_KEY` (Jev for flow replies; optional, without it
typed replies take the fallback), optional `JEV_MODEL` (default `typesafe/jev-1.13`),
optional `FLOW_MIN_CONFIDENCE` (default 0.6). The worker references the web service's secrets
(`${{web.RESEND_API_KEY}}`). Direct-Meta variables are unset: Instagram is connected via Zernio.

## Instagram connection
Zernio provider (Settings → Zernio): unrestricted read/write key with Inbox access, profile "Hugh",
account `learnwithdums`. Facebook comment bots stay in Zernio; this app is Instagram only.
Any Zernio Instagram automation on the same keyword must be switched off (double replies).

## Local
`docker compose up -d` (Postgres on 5433 via the untracked override, Redis 6379), `npm run dev`,
`npx tsx --env-file=.env worker/dm-worker.ts`, `npx vitest run`, `npx tsc --noEmit -p tsconfig.json`.

## Hugh's additions to upstream
- Contact tracking: `Contact`, `ContactEvent`, `GuideDelivery`, `LinkClick.contactId`; tracked links carry
  `?c=<igUserId>`; helpers in `lib/contacts/record.ts`; best-effort, never blocks a send.
- Flows engine: `lib/flows/*` (definition, engine, classify, state, runtime), `Flow` + `ConversationState`
  models, `/api/flows`, worker hooks in `lib/queue/dm-worker.ts`. See `docs/flows.md` and
  `docs/superpowers/{specs,plans}`.
- Flow sends reserve a workspace DM and write `DmLog` rows (`commentId` = `flow:<step>:<igUserId>`).
- Zernio route guard accepts the public origin behind a reverse proxy (`lib/zernio/route-handler.ts`).
- Multi-button postback sends for Meta and Zernio (`sendDirectMessageWithPostbackButtons`,
  `sendPrivateReplyWithPostbackButtons`).

## Live campaigns (2026-09-29)
- "Free business email guide (comment GUIDE)": keywords guide/guied, any post, flow `flows/guide-qualifier.json`,
  links: Gumroad free-business-email (primary), Cal.com free-30-min-consult (secondary).
- "Watch skill guide (comment FULL/WORD)": keywords full/fulll/ful/word/wrod/wrd, any post, DM trigger on,
  flow `flows/watch-skill-qualifier.json`, links: Gumroad watch-any-video (primary), Cal.com (secondary).

## Known deferred minors
Zero-link campaigns start flows differently by trigger; typed-reply path has no `{username}`;
concurrent `ConversationState` upsert race; no FK on `ConversationState.instagramAccountId`;
flow import is console-only until a dashboard form exists (Stage 3).
