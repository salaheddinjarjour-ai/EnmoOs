import { runPublish } from "../../publishing/publish-service";
import { JOB, parseJobData } from "../queues";
import { runAttempt, type JobProcessor } from "../types";

/**
 * publish.run (ops queue, DESIGN §F "Publishing safety", "Meta"). Parses PublishRunJob; does
 * nothing unless the PublishJob is QUEUED for this attempt (or PUBLISHING on it, after a crash).
 * Runs the publish guard (latest approval APPROVED, contentHash unchanged, no banned words, token
 * valid), builds the PublishPayload, and publishes through a DryRunPublisher (PublishJob.dryRun)
 * or deps.publishers[platform], resuming PublishJob.containerId and persisting a new one at once.
 * `published` → PUBLISHED with externalId, liveUrl and publishedAt, and the post LIVE once its
 * variants are; `processing` → publish.poll; a retryable PublishError → publish.run for the next
 * attempt until PUBLISH_MAX_ATTEMPTS, then FAILED with an alert (publishing/publish-service.ts).
 */
export const publishRunProcessor: JobProcessor = (job, deps) =>
  runPublish(deps, parseJobData(JOB.publishRun, job.data), runAttempt(job));
