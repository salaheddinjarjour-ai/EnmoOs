-- AlterTable
ALTER TABLE "SocialAccount" ADD COLUMN "isPrimary" BOOLEAN;

-- Until now a client's posts went through its newest ACTIVE account on the platform: that account
-- becomes its explicit publishing account (a platform with none active keeps its newest one).
UPDATE "SocialAccount" AS account
SET "isPrimary" = true
FROM (
  SELECT DISTINCT ON ("clientId", "platform") "id"
  FROM "SocialAccount"
  ORDER BY "clientId", "platform", ("status" = 'ACTIVE') DESC, "createdAt" DESC, "id" DESC
) AS chosen
WHERE account."id" = chosen."id";

-- CreateIndex
CREATE UNIQUE INDEX "SocialAccount_clientId_platform_isPrimary_key" ON "SocialAccount"("clientId", "platform", "isPrimary");
