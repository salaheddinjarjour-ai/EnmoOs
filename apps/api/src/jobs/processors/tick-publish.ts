import { publishTick } from "../../publishing/publish-service";
import type { JobProcessor } from "../types";

/**
 * tick.publish, every minute (DESIGN §D): SCHEDULED PublishJobs whose scheduledFor has come
 * (deps.clock) become QUEUED and get a publish.run for their next attempt. It also re-drives what
 * a lost enqueue or a dead worker left behind: QUEUED jobs without a run, PUBLISHING ones nothing
 * works on any more (FAILED, retryable), APPROVED posts whose publisher.schedule never ran.
 */
export const tickPublishProcessor: JobProcessor = (_job, deps) => publishTick(deps);
