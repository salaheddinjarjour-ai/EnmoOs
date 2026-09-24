-- CreateEnum
CREATE TYPE "Role" AS ENUM ('ADMIN', 'MANAGER', 'EDITOR');

-- CreateEnum
CREATE TYPE "Platform" AS ENUM ('INSTAGRAM', 'FACEBOOK', 'TIKTOK');

-- CreateEnum
CREATE TYPE "PostType" AS ENUM ('REEL', 'TIKTOK', 'CAROUSEL', 'STATIC', 'STORY');

-- CreateEnum
CREATE TYPE "PostStatus" AS ENUM ('IDEA', 'DRAFTING', 'VISUALIZING', 'ADAPTING', 'QA', 'PENDING_APPROVAL', 'CHANGES_REQUESTED', 'APPROVED', 'SCHEDULED', 'PUBLISHING', 'LIVE', 'SCORED', 'FAILED');

-- CreateEnum
CREATE TYPE "VariantFormat" AS ENUM ('VERTICAL_9_16', 'PORTRAIT_4_5', 'SQUARE_1_1');

-- CreateEnum
CREATE TYPE "AgentName" AS ENUM ('MANAGER', 'STRATEGIST', 'COPYWRITER', 'VISUAL_DIRECTOR', 'ADAPTER', 'ANALYST', 'PUBLISHER');

-- CreateEnum
CREATE TYPE "CampaignStatus" AS ENUM ('BRIEFING', 'PLANNING', 'PRODUCING', 'ACTIVE', 'COMPLETED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "TaskGraphStatus" AS ENUM ('PROPOSED', 'APPROVED', 'REJECTED', 'SUPERSEDED', 'COMPLETED');

-- CreateEnum
CREATE TYPE "TaskStatus" AS ENUM ('PENDING', 'QUEUED', 'RUNNING', 'WAITING', 'SUCCEEDED', 'ESCALATED', 'FAILED', 'BLOCKED_BUDGET', 'CANCELLED');

-- CreateEnum
CREATE TYPE "RunOutcome" AS ENUM ('OK', 'INVALID_OUTPUT', 'REFUSED', 'TRUNCATED', 'API_ERROR');

-- CreateEnum
CREATE TYPE "AssetKind" AS ENUM ('IMAGE', 'VIDEO');

-- CreateEnum
CREATE TYPE "AssetRole" AS ENUM ('SHOT', 'MASTER', 'VARIANT_FRAME');

-- CreateEnum
CREATE TYPE "AssetStatus" AS ENUM ('QUEUED', 'RENDERING', 'READY', 'FAILED', 'REJECTED');

-- CreateEnum
CREATE TYPE "ApprovalStatus" AS ENUM ('PENDING', 'APPROVED', 'CHANGES_REQUESTED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "Decision" AS ENUM ('APPROVE', 'REQUEST_CHANGES');

-- CreateEnum
CREATE TYPE "FeedbackTarget" AS ENUM ('COPY', 'VISUAL', 'BOTH');

-- CreateEnum
CREATE TYPE "PublishStatus" AS ENUM ('SCHEDULED', 'QUEUED', 'PUBLISHING', 'PUBLISHED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "MessageRole" AS ENUM ('USER', 'AGENT', 'SYSTEM');

-- CreateEnum
CREATE TYPE "MessageKind" AS ENUM ('TEXT', 'CLARIFY', 'BRIEF', 'PLAN', 'PROGRESS', 'POST_CARD', 'ESCALATION');

-- CreateEnum
CREATE TYPE "AccountStatus" AS ENUM ('ACTIVE', 'EXPIRED', 'REVOKED', 'ERROR');

-- CreateEnum
CREATE TYPE "Confidence" AS ENUM ('LOW', 'MEDIUM', 'HIGH');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "role" "Role" NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "lastLoginAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ip" TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Invite" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "role" "Role" NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "invitedById" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "acceptedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Invite_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Client" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "timezone" TEXT NOT NULL DEFAULT 'UTC',
    "brandVoice" TEXT NOT NULL DEFAULT '',
    "visualStyle" JSONB NOT NULL,
    "bannedWords" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "approvalChain" JSONB NOT NULL,
    "enabledPlatforms" "Platform"[] DEFAULT ARRAY['INSTAGRAM', 'FACEBOOK', 'TIKTOK']::"Platform"[],
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Client_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SocialAccount" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "platform" "Platform" NOT NULL,
    "externalId" TEXT NOT NULL,
    "handle" TEXT NOT NULL,
    "displayName" TEXT,
    "accessTokenEnc" TEXT NOT NULL,
    "refreshTokenEnc" TEXT,
    "tokenExpiresAt" TIMESTAMP(3),
    "refreshExpiresAt" TIMESTAMP(3),
    "scopes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "meta" JSONB NOT NULL DEFAULT '{}',
    "status" "AccountStatus" NOT NULL DEFAULT 'ACTIVE',
    "lastCheckedAt" TIMESTAMP(3),
    "connectedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SocialAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Campaign" (
    "id" TEXT NOT NULL,
    "clientId" TEXT,
    "name" TEXT NOT NULL,
    "status" "CampaignStatus" NOT NULL DEFAULT 'BRIEFING',
    "brief" JSONB,
    "clarifyCount" INTEGER NOT NULL DEFAULT 0,
    "briefAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "briefLockedAt" TIMESTAMP(3),
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Campaign_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChatThread" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ChatThread_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChatMessage" (
    "id" TEXT NOT NULL,
    "threadId" TEXT NOT NULL,
    "role" "MessageRole" NOT NULL,
    "kind" "MessageKind" NOT NULL DEFAULT 'TEXT',
    "agent" "AgentName",
    "userId" TEXT,
    "content" TEXT NOT NULL,
    "payload" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ChatMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TaskGraph" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "status" "TaskGraphStatus" NOT NULL DEFAULT 'PROPOSED',
    "summary" TEXT NOT NULL,
    "graph" JSONB NOT NULL,
    "estimate" JSONB NOT NULL,
    "changeRequest" TEXT,
    "approvedById" TEXT,
    "approvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TaskGraph_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentTask" (
    "id" TEXT NOT NULL,
    "graphId" TEXT NOT NULL,
    "nodeKey" TEXT NOT NULL,
    "agent" "AgentName" NOT NULL,
    "action" TEXT NOT NULL,
    "postId" TEXT,
    "dependsOn" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "status" "TaskStatus" NOT NULL DEFAULT 'PENDING',
    "revision" INTEGER NOT NULL DEFAULT 0,
    "contractAttempts" INTEGER NOT NULL DEFAULT 0,
    "input" JSONB,
    "output" JSONB,
    "feedback" JSONB,
    "error" TEXT,
    "queuedAt" TIMESTAMP(3),
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgentTask_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentRun" (
    "id" TEXT NOT NULL,
    "taskId" TEXT,
    "campaignId" TEXT,
    "clientId" TEXT,
    "agent" "AgentName" NOT NULL,
    "action" TEXT NOT NULL,
    "attempt" INTEGER NOT NULL,
    "model" TEXT NOT NULL,
    "promptVersion" TEXT NOT NULL,
    "outcome" "RunOutcome" NOT NULL,
    "stopReason" TEXT,
    "inputSnapshot" JSONB,
    "responseText" TEXT,
    "validationErrors" JSONB,
    "inputTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    "cacheReadTokens" INTEGER NOT NULL DEFAULT 0,
    "cacheWriteTokens" INTEGER NOT NULL DEFAULT 0,
    "latencyMs" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgentRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TokenUsage" (
    "day" DATE NOT NULL,
    "inputTokens" BIGINT NOT NULL DEFAULT 0,
    "outputTokens" BIGINT NOT NULL DEFAULT 0,
    "cacheReadTokens" BIGINT NOT NULL DEFAULT 0,
    "cacheWriteTokens" BIGINT NOT NULL DEFAULT 0,
    "calls" INTEGER NOT NULL DEFAULT 0,
    "costUsdMicros" BIGINT NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TokenUsage_pkey" PRIMARY KEY ("day")
);

-- CreateTable
CREATE TABLE "Post" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "ref" TEXT NOT NULL,
    "type" "PostType" NOT NULL,
    "platforms" "Platform"[],
    "status" "PostStatus" NOT NULL DEFAULT 'IDEA',
    "targetDate" DATE,
    "pillar" TEXT,
    "angle" TEXT,
    "hook" TEXT,
    "copy" JSONB,
    "humanEditCount" INTEGER NOT NULL DEFAULT 0,
    "revision" INTEGER NOT NULL DEFAULT 0,
    "needsAttention" BOOLEAN NOT NULL DEFAULT false,
    "attentionReason" TEXT,
    "qaNotes" TEXT,
    "approvedAt" TIMESTAMP(3),
    "liveAt" TIMESTAMP(3),
    "scoredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Post_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PostVariant" (
    "id" TEXT NOT NULL,
    "postId" TEXT NOT NULL,
    "platform" "Platform" NOT NULL,
    "format" "VariantFormat" NOT NULL,
    "caption" TEXT NOT NULL DEFAULT '',
    "hashtags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "overlay" JSONB,
    "engagementRate" DOUBLE PRECISION,
    "baselineRate" DOUBLE PRECISION,
    "score" DOUBLE PRECISION,
    "scoredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PostVariant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Asset" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "campaignId" TEXT,
    "postId" TEXT,
    "variantId" TEXT,
    "position" INTEGER,
    "role" "AssetRole" NOT NULL DEFAULT 'SHOT',
    "parentAssetId" TEXT,
    "rootAssetId" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "isCurrent" BOOLEAN NOT NULL DEFAULT true,
    "kind" "AssetKind" NOT NULL DEFAULT 'IMAGE',
    "status" "AssetStatus" NOT NULL DEFAULT 'QUEUED',
    "provider" TEXT NOT NULL,
    "providerModel" TEXT,
    "providerJobId" TEXT,
    "prompt" TEXT NOT NULL,
    "negativePrompt" TEXT,
    "params" JSONB NOT NULL DEFAULT '{}',
    "shotId" TEXT,
    "sceneIndex" INTEGER,
    "storageKey" TEXT,
    "url" TEXT,
    "posterUrl" TEXT,
    "mimeType" TEXT,
    "width" INTEGER,
    "height" INTEGER,
    "durationSec" DOUBLE PRECISION,
    "bytes" INTEGER,
    "review" JSONB,
    "regenCount" INTEGER NOT NULL DEFAULT 0,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Asset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ApprovalRequest" (
    "id" TEXT NOT NULL,
    "postId" TEXT NOT NULL,
    "round" INTEGER NOT NULL,
    "status" "ApprovalStatus" NOT NULL DEFAULT 'PENDING',
    "chain" JSONB NOT NULL,
    "currentStep" INTEGER NOT NULL DEFAULT 0,
    "contentHash" TEXT NOT NULL,
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ApprovalRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ApprovalDecision" (
    "id" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "step" INTEGER NOT NULL,
    "userId" TEXT NOT NULL,
    "decision" "Decision" NOT NULL,
    "feedback" TEXT,
    "target" "FeedbackTarget",
    "viaApproveAll" BOOLEAN NOT NULL DEFAULT false,
    "auditLogId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ApprovalDecision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PublishJob" (
    "id" TEXT NOT NULL,
    "variantId" TEXT NOT NULL,
    "socialAccountId" TEXT,
    "platform" "Platform" NOT NULL,
    "status" "PublishStatus" NOT NULL DEFAULT 'SCHEDULED',
    "scheduledFor" TIMESTAMP(3) NOT NULL,
    "slotSource" TEXT NOT NULL,
    "slotReason" TEXT,
    "dryRun" BOOLEAN NOT NULL DEFAULT true,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "containerId" TEXT,
    "externalId" TEXT,
    "liveUrl" TEXT,
    "lastError" TEXT,
    "publishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PublishJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SlotScore" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "platform" "Platform" NOT NULL,
    "dayOfWeek" INTEGER NOT NULL,
    "hourBucket" INTEGER NOT NULL,
    "meanScore" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "samples" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SlotScore_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PerformanceMetric" (
    "id" TEXT NOT NULL,
    "variantId" TEXT NOT NULL,
    "platform" "Platform" NOT NULL,
    "capturedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ageHours" INTEGER NOT NULL,
    "views" INTEGER,
    "reach" INTEGER,
    "likes" INTEGER,
    "comments" INTEGER,
    "shares" INTEGER,
    "saves" INTEGER,
    "engagements" INTEGER NOT NULL DEFAULT 0,
    "engagementRate" DOUBLE PRECISION,
    "source" TEXT NOT NULL,
    "raw" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PerformanceMetric_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AccountBaseline" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "platform" "Platform" NOT NULL,
    "computedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "windowDays" INTEGER NOT NULL DEFAULT 90,
    "engagementRate" DOUBLE PRECISION NOT NULL,
    "sampleSize" INTEGER NOT NULL DEFAULT 0,
    "source" TEXT NOT NULL,

    CONSTRAINT "AccountBaseline_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AnalystReport" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "weekOf" DATE NOT NULL,
    "summary" TEXT NOT NULL,
    "strategistBrief" TEXT NOT NULL,
    "stats" JSONB NOT NULL,
    "agentRunId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AnalystReport_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LearningLog" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "reportId" TEXT,
    "takeaway" TEXT NOT NULL,
    "recommendation" TEXT NOT NULL,
    "metric" TEXT NOT NULL,
    "claimedLift" DOUBLE PRECISION NOT NULL,
    "computedLift" DOUBLE PRECISION NOT NULL,
    "confidence" "Confidence" NOT NULL,
    "evidencePostIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "appliesTo" JSONB NOT NULL,
    "applied" BOOLEAN NOT NULL DEFAULT false,
    "appliedAt" TIMESTAMP(3),
    "appliedInCampaignId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LearningLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "actorId" TEXT,
    "action" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT,
    "data" JSONB,
    "ip" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RealtimeEvent" (
    "id" BIGSERIAL NOT NULL,
    "channel" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RealtimeEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "Session_tokenHash_key" ON "Session"("tokenHash");

-- CreateIndex
CREATE INDEX "Session_userId_idx" ON "Session"("userId");

-- CreateIndex
CREATE INDEX "Session_expiresAt_idx" ON "Session"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "Invite_tokenHash_key" ON "Invite"("tokenHash");

-- CreateIndex
CREATE INDEX "Invite_email_idx" ON "Invite"("email");

-- CreateIndex
CREATE UNIQUE INDEX "Client_slug_key" ON "Client"("slug");

-- CreateIndex
CREATE INDEX "Client_archivedAt_idx" ON "Client"("archivedAt");

-- CreateIndex
CREATE INDEX "SocialAccount_clientId_idx" ON "SocialAccount"("clientId");

-- CreateIndex
CREATE UNIQUE INDEX "SocialAccount_platform_externalId_key" ON "SocialAccount"("platform", "externalId");

-- CreateIndex
CREATE INDEX "Campaign_clientId_status_idx" ON "Campaign"("clientId", "status");

-- CreateIndex
CREATE INDEX "Campaign_status_createdAt_idx" ON "Campaign"("status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "ChatThread_campaignId_key" ON "ChatThread"("campaignId");

-- CreateIndex
CREATE INDEX "ChatMessage_threadId_createdAt_idx" ON "ChatMessage"("threadId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "TaskGraph_campaignId_version_key" ON "TaskGraph"("campaignId", "version");

-- CreateIndex
CREATE INDEX "AgentTask_status_updatedAt_idx" ON "AgentTask"("status", "updatedAt");

-- CreateIndex
CREATE INDEX "AgentTask_postId_idx" ON "AgentTask"("postId");

-- CreateIndex
CREATE UNIQUE INDEX "AgentTask_graphId_nodeKey_key" ON "AgentTask"("graphId", "nodeKey");

-- CreateIndex
CREATE INDEX "AgentRun_taskId_idx" ON "AgentRun"("taskId");

-- CreateIndex
CREATE INDEX "AgentRun_campaignId_createdAt_idx" ON "AgentRun"("campaignId", "createdAt");

-- CreateIndex
CREATE INDEX "AgentRun_createdAt_idx" ON "AgentRun"("createdAt");

-- CreateIndex
CREATE INDEX "Post_clientId_status_idx" ON "Post"("clientId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Post_campaignId_ref_key" ON "Post"("campaignId", "ref");

-- CreateIndex
CREATE UNIQUE INDEX "PostVariant_postId_platform_key" ON "PostVariant"("postId", "platform");

-- CreateIndex
CREATE INDEX "Asset_clientId_createdAt_idx" ON "Asset"("clientId", "createdAt");

-- CreateIndex
CREATE INDEX "Asset_postId_idx" ON "Asset"("postId");

-- CreateIndex
CREATE INDEX "Asset_rootAssetId_version_idx" ON "Asset"("rootAssetId", "version");

-- CreateIndex
CREATE INDEX "Asset_variantId_position_idx" ON "Asset"("variantId", "position");

-- CreateIndex
CREATE INDEX "ApprovalRequest_status_createdAt_idx" ON "ApprovalRequest"("status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "ApprovalRequest_postId_round_key" ON "ApprovalRequest"("postId", "round");

-- CreateIndex
CREATE UNIQUE INDEX "ApprovalDecision_requestId_step_userId_key" ON "ApprovalDecision"("requestId", "step", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "PublishJob_variantId_key" ON "PublishJob"("variantId");

-- CreateIndex
CREATE INDEX "PublishJob_status_scheduledFor_idx" ON "PublishJob"("status", "scheduledFor");

-- CreateIndex
CREATE UNIQUE INDEX "SlotScore_clientId_platform_dayOfWeek_hourBucket_key" ON "SlotScore"("clientId", "platform", "dayOfWeek", "hourBucket");

-- CreateIndex
CREATE INDEX "PerformanceMetric_variantId_capturedAt_idx" ON "PerformanceMetric"("variantId", "capturedAt");

-- CreateIndex
CREATE INDEX "AccountBaseline_clientId_platform_computedAt_idx" ON "AccountBaseline"("clientId", "platform", "computedAt");

-- CreateIndex
CREATE UNIQUE INDEX "AnalystReport_clientId_weekOf_key" ON "AnalystReport"("clientId", "weekOf");

-- CreateIndex
CREATE INDEX "LearningLog_clientId_applied_createdAt_idx" ON "LearningLog"("clientId", "applied", "createdAt");

-- CreateIndex
CREATE INDEX "AuditLog_createdAt_idx" ON "AuditLog"("createdAt");

-- CreateIndex
CREATE INDEX "AuditLog_entityType_entityId_idx" ON "AuditLog"("entityType", "entityId");

-- CreateIndex
CREATE INDEX "AuditLog_actorId_createdAt_idx" ON "AuditLog"("actorId", "createdAt");

-- CreateIndex
CREATE INDEX "RealtimeEvent_channel_id_idx" ON "RealtimeEvent"("channel", "id");

-- CreateIndex
CREATE INDEX "RealtimeEvent_createdAt_idx" ON "RealtimeEvent"("createdAt");

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invite" ADD CONSTRAINT "Invite_invitedById_fkey" FOREIGN KEY ("invitedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SocialAccount" ADD CONSTRAINT "SocialAccount_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SocialAccount" ADD CONSTRAINT "SocialAccount_connectedById_fkey" FOREIGN KEY ("connectedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Campaign" ADD CONSTRAINT "Campaign_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Campaign" ADD CONSTRAINT "Campaign_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChatThread" ADD CONSTRAINT "ChatThread_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChatMessage" ADD CONSTRAINT "ChatMessage_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "ChatThread"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChatMessage" ADD CONSTRAINT "ChatMessage_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskGraph" ADD CONSTRAINT "TaskGraph_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskGraph" ADD CONSTRAINT "TaskGraph_approvedById_fkey" FOREIGN KEY ("approvedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentTask" ADD CONSTRAINT "AgentTask_graphId_fkey" FOREIGN KEY ("graphId") REFERENCES "TaskGraph"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentTask" ADD CONSTRAINT "AgentTask_postId_fkey" FOREIGN KEY ("postId") REFERENCES "Post"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentRun" ADD CONSTRAINT "AgentRun_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "AgentTask"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentRun" ADD CONSTRAINT "AgentRun_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentRun" ADD CONSTRAINT "AgentRun_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Post" ADD CONSTRAINT "Post_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Post" ADD CONSTRAINT "Post_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PostVariant" ADD CONSTRAINT "PostVariant_postId_fkey" FOREIGN KEY ("postId") REFERENCES "Post"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Asset" ADD CONSTRAINT "Asset_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Asset" ADD CONSTRAINT "Asset_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Asset" ADD CONSTRAINT "Asset_postId_fkey" FOREIGN KEY ("postId") REFERENCES "Post"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Asset" ADD CONSTRAINT "Asset_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "PostVariant"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Asset" ADD CONSTRAINT "Asset_parentAssetId_fkey" FOREIGN KEY ("parentAssetId") REFERENCES "Asset"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Asset" ADD CONSTRAINT "Asset_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApprovalRequest" ADD CONSTRAINT "ApprovalRequest_postId_fkey" FOREIGN KEY ("postId") REFERENCES "Post"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApprovalDecision" ADD CONSTRAINT "ApprovalDecision_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "ApprovalRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApprovalDecision" ADD CONSTRAINT "ApprovalDecision_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApprovalDecision" ADD CONSTRAINT "ApprovalDecision_auditLogId_fkey" FOREIGN KEY ("auditLogId") REFERENCES "AuditLog"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PublishJob" ADD CONSTRAINT "PublishJob_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "PostVariant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PublishJob" ADD CONSTRAINT "PublishJob_socialAccountId_fkey" FOREIGN KEY ("socialAccountId") REFERENCES "SocialAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SlotScore" ADD CONSTRAINT "SlotScore_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PerformanceMetric" ADD CONSTRAINT "PerformanceMetric_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "PostVariant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccountBaseline" ADD CONSTRAINT "AccountBaseline_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AnalystReport" ADD CONSTRAINT "AnalystReport_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AnalystReport" ADD CONSTRAINT "AnalystReport_agentRunId_fkey" FOREIGN KEY ("agentRunId") REFERENCES "AgentRun"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LearningLog" ADD CONSTRAINT "LearningLog_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LearningLog" ADD CONSTRAINT "LearningLog_reportId_fkey" FOREIGN KEY ("reportId") REFERENCES "AnalystReport"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LearningLog" ADD CONSTRAINT "LearningLog_appliedInCampaignId_fkey" FOREIGN KEY ("appliedInCampaignId") REFERENCES "Campaign"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
