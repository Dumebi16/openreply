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
import { TRACKED_LINK_ORDER } from "@/lib/tracking/link-order";
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

export type FlowVia =
  | { kind: "dm" }
  | { kind: "private_reply"; commentId: string; postId?: string };

/** Prisma `include` fragment every worker query needs so `flow` is loaded. */
export const FLOW_INCLUDE = {
  flow: { select: { id: true, isActive: true, definition: true } },
} as const;

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
  via: FlowVia;
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
    await sendPrivateReplyWithPostbackButtons({
      context: accessToken,
      instagramAccountId,
      commentId: via.commentId,
      postId: via.postId,
      text,
      buttons,
    });
  } else {
    await sendDirectMessageWithPostbackButtons({
      context: accessToken,
      instagramAccountId,
      userId,
      text,
      buttons,
    });
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
  const text =
    renderMessageWithoutLink({ message: step.message, commenterName }) || "Here's your link:";
  const instagramAccountId = automation.instagramAccount.instagramId;
  const buttons = automation.trackedLinks.slice(0, 3).map((link, index) => ({
    url: buildTrackedUrl(link.slug, undefined, userId),
    title: (index === 0 ? automation.linkButtonLabel : link.label) || link.label || "Open link",
  }));
  if (buttons.length === 0) {
    await sendDirectMessage({ context: accessToken, instagramAccountId, userId, message: text });
  } else {
    try {
      await sendDirectMessageWithLinkButton({
        context: accessToken,
        instagramAccountId,
        userId,
        text,
        buttons,
      });
    } catch (error) {
      if (!isTemplateRejection(error)) throw error;
      await sendDirectMessage({
        context: accessToken,
        instagramAccountId,
        userId,
        message: `${text}\n${buttons.map((b) => b.url).join("\n")}`,
      });
    }
  }
  const key = {
    instagramAccountId: automation.instagramAccountId,
    igUserId: userId,
    username: commenterName,
  };
  await recordContactEvent(key, {
    type: "DM_SENT",
    automationId: automation.id,
    meta: { via: "flow_link", step: step.key },
  });
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
  via: FlowVia;
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
  via: FlowVia;
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
  if (!decoded || !hasActiveFlow(automation) || decoded.flowId !== automation.flow!.id) {
    return false;
  }
  const def = definitionOf(automation);
  const state = await loadActiveState(automation.instagramAccountId, userId);
  const input: FlowInput = {
    kind: "postback",
    stepKey: decoded.stepKey,
    optionKey: decoded.optionKey,
  };
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
    where: {
      flow: { id: state.flowId, isActive: true },
      isActive: true,
      instagramAccount: { instagramId },
    },
    include: {
      instagramAccount: true,
      trackedLinks: {
        select: { slug: true, label: true, destinationUrl: true },
        orderBy: TRACKED_LINK_ORDER,
      },
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
    ? await classifyReply({
        text,
        question: step.message,
        options: step.options.map((o) => ({ key: o.key, label: o.label })),
      })
    : null;
  const result = advance({
    def,
    currentStepKey: state.currentStepKey,
    input: { kind: "text", text, classified },
    minConfidence: getFlowMinConfidence(),
  });
  const accessToken = await createContext(automation);
  await runActions({
    ...result,
    accessToken,
    automation,
    userId: senderId,
    commenterName: null,
    via: { kind: "dm" },
  });
  return true;
}
