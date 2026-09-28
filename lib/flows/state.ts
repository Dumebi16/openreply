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
