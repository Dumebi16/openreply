import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockPrisma, mockContext } = vi.hoisted(() => ({
  mockPrisma: { automation: { findFirst: vi.fn() }, flow: { upsert: vi.fn(), findMany: vi.fn() } },
  mockContext: vi.fn(),
}));
vi.mock("@/lib/db/client", () => ({ prisma: mockPrisma }));
vi.mock("@/lib/workspace-access", () => ({
  getCurrentWorkspaceContext: mockContext,
  canManageWorkspace: (role: string) => role === "OWNER" || role === "ADMIN",
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
