import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockPrisma, mockSends, mockClassify, mockContacts, mockUsage } = vi.hoisted(() => ({
  mockPrisma: {
    conversationState: { findUnique: vi.fn(), upsert: vi.fn(), delete: vi.fn(), deleteMany: vi.fn() },
    automation: { findFirst: vi.fn() },
    dmLog: { upsert: vi.fn() },
  },
  mockUsage: { reserveWorkspaceDMSend: vi.fn(), releaseWorkspaceDMReservation: vi.fn() },
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
vi.mock("@/lib/billing/usage", () => mockUsage);

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
  mockPrisma.dmLog.upsert.mockResolvedValue({});
  mockUsage.reserveWorkspaceDMSend.mockResolvedValue({ allowed: true, reserved: true, remaining: 10, limit: 100, periodStart: new Date("2026-09-01") });
  mockUsage.releaseWorkspaceDMReservation.mockResolvedValue({ count: 1 });
});

describe("accounting", () => {
  it("reserves a workspace DM and writes a DmLog row for each flow send", async () => {
    await startFlow({ accessToken: ctx, automation, userId: "u_1", commenterName: "jane", via: { kind: "dm" } });
    expect(mockUsage.reserveWorkspaceDMSend).toHaveBeenCalledWith("ws_1");
    expect(mockPrisma.dmLog.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { automationId_commentId: { automationId: "auto_1", commentId: "flow:who:u_1" } },
      create: expect.objectContaining({ workspaceId: "ws_1", automationId: "auto_1", instagramAccountId: "acct_1", commenterId: "u_1", status: "SENT", commentText: "(flow: who)" }),
    }));
  });

  it("does not send and logs SKIPPED_PLAN_LIMIT when the monthly cap is reached", async () => {
    mockUsage.reserveWorkspaceDMSend.mockResolvedValue({ allowed: false, reserved: false, remaining: 0, limit: 100, periodStart: new Date("2026-09-01") });
    await startFlow({ accessToken: ctx, automation, userId: "u_1", commenterName: null, via: { kind: "dm" } });
    expect(mockSends.sendDirectMessageWithPostbackButtons).not.toHaveBeenCalled();
    expect(mockPrisma.dmLog.upsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({ status: "SKIPPED_PLAN_LIMIT" }),
    }));
  });

  it("releases the reservation and logs FAILED when the send throws", async () => {
    mockSends.sendDirectMessageWithPostbackButtons.mockRejectedValueOnce(new Error("boom"));
    await expect(startFlow({ accessToken: ctx, automation, userId: "u_1", commenterName: null, via: { kind: "dm" } })).rejects.toThrow("boom");
    expect(mockUsage.releaseWorkspaceDMReservation).toHaveBeenCalledWith("ws_1", new Date("2026-09-01"));
    expect(mockPrisma.dmLog.upsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({ status: "FAILED", errorMessage: "boom" }),
    }));
  });
});

describe("a stored definition that no longer validates", () => {
  const broken = { ...automation, flow: { id: "flow_1", isActive: true, definition: { entryStepKey: "nope", fallbackStepKey: "x", steps: [] } } };

  it("clears the person's state and returns false on a typed reply", async () => {
    mockPrisma.conversationState.findUnique.mockResolvedValue({ id: "s1", flowId: "flow_1", currentStepKey: "who", expiresAt: new Date(Date.now() + 60_000) });
    mockPrisma.automation.findFirst.mockResolvedValue(broken);
    const createContext = vi.fn(async () => ctx);
    expect(await handleFlowReply({ instagramAccountId: "acct_1", instagramId: "ig_1", senderId: "u_1", text: "hi", createContext })).toBe(false);
    expect(mockPrisma.conversationState.deleteMany).toHaveBeenCalledWith({ where: { instagramAccountId: "acct_1", igUserId: "u_1" } });
  });

  it("returns false on a button tap instead of throwing", async () => {
    expect(await handleFlowPostback({ accessToken: ctx, automation: broken, userId: "u_1", commenterName: null, payload: "flow:flow_1:who:owner" })).toBe(false);
  });
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
