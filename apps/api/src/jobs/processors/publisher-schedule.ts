import { schedulePost } from "../../publishing/schedule";
import { JOB, parseJobData } from "../queues";
import type { JobProcessor } from "../types";

/**
 * publisher.schedule (agents queue, DESIGN §C "Publisher", §F "Slot optimizer"). Parses
 * PublisherScheduleJob; does nothing unless the post is still APPROVED on that round. Creates a
 * PostVariant per platform that takes the post type, scores slot candidates for each (the
 * optimizer's top SLOT_RULES.candidates in the client's time zone), asks the Publisher to pick one
 * per variant (falling back to the top candidate with slotSource "optimizer" once its retries run
 * out), creates one SCHEDULED PublishJob per variant (dryRun decided now) and moves the post to
 * SCHEDULED. Idempotent: variants that already have a job keep it (publishing/schedule.ts).
 */
export const publisherScheduleProcessor: JobProcessor = (job, deps) =>
  schedulePost(deps, parseJobData(JOB.publisherSchedule, job.data));
