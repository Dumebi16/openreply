import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/client";
import { getRequestIp, hashClickIp } from "@/lib/tracking/server";
import {
  findContactIdByIgUserId,
  recordContactEvent,
} from "@/lib/contacts/record";

type RedirectRouteProps = {
  params: Promise<{ slug: string }>;
};

export async function GET(request: NextRequest, { params }: RedirectRouteProps) {
  const { slug } = await params;
  const trackedLink = await prisma.trackedLink.findUnique({
    where: { slug },
    select: {
      id: true,
      workspaceId: true,
      automationId: true,
      destinationUrl: true,
      automation: {
        select: {
          instagramAccountId: true,
        },
      },
    },
  });

  if (!trackedLink) {
    return NextResponse.redirect(new URL("/", request.url), { status: 302 });
  }

  // `c` is the recipient's Instagram user id, added by the worker when the DM
  // was sent (lib/tracking/message.ts buildTrackedUrl). Optional: a link
  // shared onward or opened from a log has no `c` and is counted anonymously.
  const clickRef =
    new URL(request.url).searchParams.get("c")?.trim() || null;
  const instagramAccountId = trackedLink.automation.instagramAccountId;
  const contactId = clickRef
    ? await findContactIdByIgUserId(instagramAccountId, clickRef)
    : null;

  await prisma.linkClick.create({
    data: {
      workspaceId: trackedLink.workspaceId,
      automationId: trackedLink.automationId,
      instagramAccountId,
      trackedLinkId: trackedLink.id,
      contactId,
      ipHash: hashClickIp(getRequestIp(request)),
      userAgent: request.headers.get("user-agent"),
      referrer: request.headers.get("referer"),
    },
  });

  if (clickRef) {
    await recordContactEvent(
      { instagramAccountId, igUserId: clickRef },
      {
        type: "LINK_CLICK",
        automationId: trackedLink.automationId,
        trackedLinkId: trackedLink.id,
        inbound: true,
      }
    );
  }

  return NextResponse.redirect(trackedLink.destinationUrl, { status: 302 });
}
