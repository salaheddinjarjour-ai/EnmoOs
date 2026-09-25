import { pollPublish } from "../../publishing/publish-service";
import { JOB, parseJobData } from "../queues";
import { runAttempt, type JobProcessor } from "../types";

/**
 * publish.poll (ops queue, DESIGN §F "Meta"). Parses PublishPollJob; does nothing unless the
 * PublishJob is PUBLISHING on that attempt. Asks the publisher to poll the container: still
 * processing → the next poll after publishPollDelayMs (FAILED once publishPollMaxPolls ran out);
 * published → PUBLISHED with its live URL, like publish.run (publishing/publish-service.ts).
 */
export const publishPollProcessor: JobProcessor = (job, deps) =>
  pollPublish(deps, parseJobData(JOB.publishPoll, job.data), runAttempt(job));
