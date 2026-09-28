import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db/client";
import { FlowDefinitionError, validateFlowDefinition } from "@/lib/flows/definition";
import { canManageWorkspace, getCurrentWorkspaceContext } from "@/lib/workspace-access";

export const dynamic = "force-dynamic";

const bodySchema = z.object({
  automationId: z.string().min(1),
  name: z.string().min(1).max(100),
  isActive: z.boolean().optional().default(true),
  definition: z.unknown(),
});

export async function GET() {
  const context = await getCurrentWorkspaceContext();
  if (!context) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }
  const flows = await prisma.flow.findMany({
    where: { workspaceId: context.workspaceId },
    select: { id: true, automationId: true, name: true, isActive: true, definition: true, updatedAt: true },
    orderBy: { updatedAt: "desc" },
  });
  return NextResponse.json({ success: true, data: { flows } });
}

export async function POST(request: Request) {
  const context = await getCurrentWorkspaceContext();
  if (!context) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }
  if (!canManageWorkspace(context.role)) {
    return NextResponse.json(
      { success: false, error: "Only owners and admins can edit flows" },
      { status: 403 }
    );
  }
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ success: false, error: "Invalid input" }, { status: 400 });
  }

  let definition;
  try {
    definition = validateFlowDefinition(parsed.data.definition);
  } catch (error) {
    if (error instanceof FlowDefinitionError) {
      return NextResponse.json({ success: false, error: error.message }, { status: 400 });
    }
    throw error;
  }

  const automation = await prisma.automation.findFirst({
    where: { id: parsed.data.automationId, workspaceId: context.workspaceId },
    select: { id: true },
  });
  if (!automation) {
    return NextResponse.json({ success: false, error: "Campaign not found" }, { status: 404 });
  }

  const flow = await prisma.flow.upsert({
    where: { automationId: automation.id },
    create: {
      workspaceId: context.workspaceId,
      automationId: automation.id,
      name: parsed.data.name,
      isActive: parsed.data.isActive,
      definition,
    },
    update: { name: parsed.data.name, isActive: parsed.data.isActive, definition },
    select: { id: true },
  });
  return NextResponse.json({ success: true, data: { id: flow.id } });
}
