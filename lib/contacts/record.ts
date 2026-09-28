import type { ContactEventType, Prisma } from "@/app/generated/prisma/client";
import { prisma } from "@/lib/db/client";

/**
 * Best-effort contact tracking.
 *
 * Every helper here swallows its own errors and logs them, because these rows
 * are history for the future flows engine, not part of delivering a DM. A
 * database hiccup while recording an event must never fail or retry a send.
 *
 * `instagramAccountId` is always the InstagramAccount row id (the value the
 * worker has as `automation.instagramAccountId`), not Instagram's own id.
 * `igUserId` is the Instagram-scoped user id that arrives on the webhook as
 * commenterId / senderId / userId.
 */

type ContactKey = {
  instagramAccountId: string;
  igUserId: string;
  username?: string | null;
};

type ContactPatch = {
  inbound?: boolean;
  isFollower?: boolean | null;
  email?: string | null;
};

function warn(what: string, error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  console.warn(`[Contacts] ${what} failed (ignored): ${message}`);
}

/** Create or refresh the contact row. Returns its id, or null on failure. */
export async function touchContact(
  key: ContactKey,
  patch: ContactPatch = {}
): Promise<string | null> {
  const now = new Date();
  const update: Prisma.ContactUpdateInput = {};
  if (key.username) update.username = key.username;
  if (patch.inbound) update.lastInboundAt = now;
  if (patch.isFollower !== undefined) {
    update.isFollower = patch.isFollower;
    update.followCheckedAt = now;
  }
  if (patch.email) {
    update.email = patch.email;
    update.emailCapturedAt = now;
  }

  try {
    const contact = await prisma.contact.upsert({
      where: {
        instagramAccountId_igUserId: {
          instagramAccountId: key.instagramAccountId,
          igUserId: key.igUserId,
        },
      },
      create: {
        instagramAccountId: key.instagramAccountId,
        igUserId: key.igUserId,
        username: key.username ?? null,
        lastInboundAt: patch.inbound ? now : null,
        isFollower: patch.isFollower ?? null,
        followCheckedAt: patch.isFollower !== undefined ? now : null,
        email: patch.email ?? null,
        emailCapturedAt: patch.email ? now : null,
      },
      update,
      select: { id: true },
    });
    return contact.id;
  } catch (error) {
    warn("touchContact", error);
    return null;
  }
}

/** Append one event to the contact's timeline (creating the contact first). */
export async function recordContactEvent(
  key: ContactKey,
  event: {
    type: ContactEventType;
    automationId?: string | null;
    dmLogId?: string | null;
    trackedLinkId?: string | null;
    meta?: Prisma.InputJsonValue;
    /** True when the person acted (comment, DM, tap); bumps lastInboundAt. */
    inbound?: boolean;
    isFollower?: boolean | null;
  }
): Promise<void> {
  const contactId = await touchContact(key, {
    inbound: event.inbound,
    isFollower: event.isFollower,
  });
  if (!contactId) return;
  try {
    await prisma.contactEvent.create({
      data: {
        contactId,
        type: event.type,
        automationId: event.automationId ?? null,
        dmLogId: event.dmLogId ?? null,
        trackedLinkId: event.trackedLinkId ?? null,
        meta: event.meta,
      },
    });
  } catch (error) {
    warn(`recordContactEvent(${event.type})`, error);
  }
}

/**
 * Mark a campaign's guide as delivered to this person. Idempotent: a second
 * delivery of the same campaign to the same person keeps the first row.
 */
export async function recordGuideDelivery(
  key: ContactKey,
  delivery: { automationId: string; dmLogId?: string | null }
): Promise<void> {
  const contactId = await touchContact(key);
  if (!contactId) return;
  try {
    const existing = await prisma.guideDelivery.findUnique({
      where: {
        contactId_automationId: {
          contactId,
          automationId: delivery.automationId,
        },
      },
      select: { id: true },
    });
    if (!existing) {
      await prisma.guideDelivery.create({
        data: {
          contactId,
          automationId: delivery.automationId,
          dmLogId: delivery.dmLogId ?? null,
        },
      });
    }
    await prisma.contactEvent.create({
      data: {
        contactId,
        type: "GUIDE_DELIVERED",
        automationId: delivery.automationId,
        dmLogId: delivery.dmLogId ?? null,
        meta: existing ? { repeat: true } : undefined,
      },
    });
  } catch (error) {
    warn("recordGuideDelivery", error);
  }
}

/** Resolve a contact id from the `c` click reference on a tracked link. */
export async function findContactIdByIgUserId(
  instagramAccountId: string,
  igUserId: string
): Promise<string | null> {
  try {
    const contact = await prisma.contact.findUnique({
      where: { instagramAccountId_igUserId: { instagramAccountId, igUserId } },
      select: { id: true },
    });
    return contact?.id ?? null;
  } catch (error) {
    warn("findContactIdByIgUserId", error);
    return null;
  }
}
