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

See `flows/guide-qualifier.json` for a complete example.

## Import a flow

From the dashboard (signed in as owner/admin), open the browser console and run:

```js
const file = /* paste the contents of flows/<name>.json here */;
await fetch('/api/flows', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ automationId: '<campaign id>', name: file.name, definition: file.definition }),
}).then(r => r.json());
```

Re-posting the same `automationId` replaces the flow. `GET /api/flows` lists
the workspace's flows.
