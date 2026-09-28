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
