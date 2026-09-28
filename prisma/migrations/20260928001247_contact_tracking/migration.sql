-- CreateEnum
CREATE TYPE "ContactEventType" AS ENUM ('COMMENT', 'DM_IN', 'DM_SENT', 'PUBLIC_REPLY', 'BUTTON_TAP', 'FOLLOW_CHECK', 'LINK_CLICK', 'GUIDE_DELIVERED', 'EMAIL_CAPTURED');

-- AlterTable
ALTER TABLE "LinkClick" ADD COLUMN     "contactId" TEXT;

-- CreateTable
CREATE TABLE "Contact" (
    "id" TEXT NOT NULL,
    "instagramAccountId" TEXT NOT NULL,
    "igUserId" TEXT NOT NULL,
    "username" TEXT,
    "email" TEXT,
    "emailCapturedAt" TIMESTAMP(3),
    "isFollower" BOOLEAN,
    "followCheckedAt" TIMESTAMP(3),
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastInboundAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Contact_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ContactEvent" (
    "id" TEXT NOT NULL,
    "contactId" TEXT NOT NULL,
    "type" "ContactEventType" NOT NULL,
    "automationId" TEXT,
    "dmLogId" TEXT,
    "trackedLinkId" TEXT,
    "meta" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ContactEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GuideDelivery" (
    "id" TEXT NOT NULL,
    "contactId" TEXT NOT NULL,
    "automationId" TEXT NOT NULL,
    "dmLogId" TEXT,
    "deliveredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GuideDelivery_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Contact_instagramAccountId_lastInboundAt_idx" ON "Contact"("instagramAccountId", "lastInboundAt");

-- CreateIndex
CREATE INDEX "Contact_email_idx" ON "Contact"("email");

-- CreateIndex
CREATE UNIQUE INDEX "Contact_instagramAccountId_igUserId_key" ON "Contact"("instagramAccountId", "igUserId");

-- CreateIndex
CREATE INDEX "ContactEvent_contactId_createdAt_idx" ON "ContactEvent"("contactId", "createdAt");

-- CreateIndex
CREATE INDEX "ContactEvent_automationId_type_idx" ON "ContactEvent"("automationId", "type");

-- CreateIndex
CREATE INDEX "ContactEvent_type_createdAt_idx" ON "ContactEvent"("type", "createdAt");

-- CreateIndex
CREATE INDEX "GuideDelivery_automationId_deliveredAt_idx" ON "GuideDelivery"("automationId", "deliveredAt");

-- CreateIndex
CREATE UNIQUE INDEX "GuideDelivery_contactId_automationId_key" ON "GuideDelivery"("contactId", "automationId");

-- CreateIndex
CREATE INDEX "LinkClick_contactId_idx" ON "LinkClick"("contactId");

-- AddForeignKey
ALTER TABLE "LinkClick" ADD CONSTRAINT "LinkClick_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Contact" ADD CONSTRAINT "Contact_instagramAccountId_fkey" FOREIGN KEY ("instagramAccountId") REFERENCES "InstagramAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContactEvent" ADD CONSTRAINT "ContactEvent_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContactEvent" ADD CONSTRAINT "ContactEvent_automationId_fkey" FOREIGN KEY ("automationId") REFERENCES "Automation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GuideDelivery" ADD CONSTRAINT "GuideDelivery_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GuideDelivery" ADD CONSTRAINT "GuideDelivery_automationId_fkey" FOREIGN KEY ("automationId") REFERENCES "Automation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
