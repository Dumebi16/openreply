import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    contact: { upsert: vi.fn(), findUnique: vi.fn() },
    contactEvent: { create: vi.fn() },
    guideDelivery: { findUnique: vi.fn(), create: vi.fn() },
  },
}));

vi.mock("@/lib/db/client", () => ({ prisma: mockPrisma }));

import {
  findContactIdByIgUserId,
  recordContactEvent,
  recordGuideDelivery,
  touchContact,
} from "../lib/contacts/record";
import { buildTrackedUrl, renderMessageWithTracking } from "../lib/tracking/message";

const key = { instagramAccountId: "acct_1", igUserId: "ig_123", username: "jane" };

beforeEach(() => {
  vi.clearAllMocks();
  mockPrisma.contact.upsert.mockResolvedValue({ id: "contact_1" });
  mockPrisma.contactEvent.create.mockResolvedValue({ id: "ev_1" });
  mockPrisma.guideDelivery.findUnique.mockResolvedValue(null);
  mockPrisma.guideDelivery.create.mockResolvedValue({ id: "gd_1" });
});

describe("touchContact", () => {
  it("upserts on (account, igUserId) and bumps lastInboundAt only for inbound", async () => {
    const id = await touchContact(key, { inbound: true });
    expect(id).toBe("contact_1");
    const args = mockPrisma.contact.upsert.mock.calls[0][0];
    expect(args.where).toEqual({
      instagramAccountId_igUserId: { instagramAccountId: "acct_1", igUserId: "ig_123" },
    });
    expect(args.update.lastInboundAt).toBeInstanceOf(Date);
    expect(args.update.username).toBe("jane");

    await touchContact(key, {});
    const quiet = mockPrisma.contact.upsert.mock.calls[1][0];
    expect(quiet.update.lastInboundAt).toBeUndefined();
  });

  it("records follow status with a timestamp, including an explicit null", async () => {
    await touchContact(key, { isFollower: null });
    const args = mockPrisma.contact.upsert.mock.calls[0][0];
    expect(args.update.isFollower).toBeNull();
    expect(args.update.followCheckedAt).toBeInstanceOf(Date);
  });

  it("never throws when the database fails", async () => {
    mockPrisma.contact.upsert.mockRejectedValueOnce(new Error("db down"));
    await expect(touchContact(key)).resolves.toBeNull();
  });
});

describe("recordContactEvent", () => {
  it("creates the contact then the event with the campaign reference", async () => {
    await recordContactEvent(key, {
      type: "COMMENT",
      automationId: "auto_1",
      inbound: true,
      meta: { text: "guide" },
    });
    expect(mockPrisma.contactEvent.create).toHaveBeenCalledWith({
      data: {
        contactId: "contact_1",
        type: "COMMENT",
        automationId: "auto_1",
        dmLogId: null,
        trackedLinkId: null,
        meta: { text: "guide" },
      },
    });
  });

  it("skips the event when the contact could not be created", async () => {
    mockPrisma.contact.upsert.mockRejectedValueOnce(new Error("db down"));
    await recordContactEvent(key, { type: "DM_IN" });
    expect(mockPrisma.contactEvent.create).not.toHaveBeenCalled();
  });

  it("swallows an event write failure", async () => {
    mockPrisma.contactEvent.create.mockRejectedValueOnce(new Error("db down"));
    await expect(recordContactEvent(key, { type: "DM_SENT" })).resolves.toBeUndefined();
  });
});

describe("recordGuideDelivery", () => {
  it("creates one delivery row per person per campaign", async () => {
    await recordGuideDelivery(key, { automationId: "auto_1" });
    expect(mockPrisma.guideDelivery.create).toHaveBeenCalledWith({
      data: { contactId: "contact_1", automationId: "auto_1", dmLogId: null },
    });
    expect(mockPrisma.contactEvent.create.mock.calls[0][0].data.type).toBe("GUIDE_DELIVERED");
  });

  it("does not create a second row on a repeat delivery, but still logs the event", async () => {
    mockPrisma.guideDelivery.findUnique.mockResolvedValueOnce({ id: "gd_existing" });
    await recordGuideDelivery(key, { automationId: "auto_1" });
    expect(mockPrisma.guideDelivery.create).not.toHaveBeenCalled();
    expect(mockPrisma.contactEvent.create.mock.calls[0][0].data.meta).toEqual({ repeat: true });
  });
});

describe("click attribution", () => {
  it("appends the recipient reference to tracked URLs only when given", () => {
    expect(buildTrackedUrl("abc", "https://x.test")).toBe("https://x.test/r/abc");
    expect(buildTrackedUrl("abc", "https://x.test", "ig 1")).toBe(
      "https://x.test/r/abc?c=ig%201"
    );
    expect(buildTrackedUrl("abc", "https://x.test", null)).toBe("https://x.test/r/abc");
  });

  it("threads the reference through {link} rendering", () => {
    const rendered = renderMessageWithTracking({
      message: "Here {link}",
      trackedLinks: [{ slug: "abc", destinationUrl: "https://g.test/x" }],
      baseUrl: "https://x.test",
      clickRef: "ig_123",
    });
    expect(rendered).toBe("Here https://x.test/r/abc?c=ig_123");
  });

  it("resolves a contact id from the reference", async () => {
    mockPrisma.contact.findUnique.mockResolvedValueOnce({ id: "contact_9" });
    await expect(findContactIdByIgUserId("acct_1", "ig_9")).resolves.toBe("contact_9");
    mockPrisma.contact.findUnique.mockResolvedValueOnce(null);
    await expect(findContactIdByIgUserId("acct_1", "nope")).resolves.toBeNull();
  });
});
