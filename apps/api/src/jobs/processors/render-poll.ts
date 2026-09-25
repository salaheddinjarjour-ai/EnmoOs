import { pollRender } from "../../orchestrator/renders";
import { failTake } from "../../orchestrator/render-outcomes";
import { JOB, parseJobData } from "../queues";
import { runAttempt, type JobProcessor } from "../types";

/**
 * render.poll (media queue, DESIGN §D/§F). Parses RenderPollJob; does nothing unless the Asset is
 * RENDERING. Asks deps.visual.status(providerJobId): still queued or running → re-enqueue with
 * attempt + 1 after renderPollDelayMs (FAILED once RENDER_POLL_MAX_ATTEMPTS polls ran out);
 * succeeded → download every output with fetch (a data: URL for MockProvider), put it in
 * deps.storage under assetStorageKey, store url/posterUrl/mimeType/size/bytes, mark the Asset READY
 * and queue its review; failed or rejected → the Asset FAILED or REJECTED and the visual loop hands
 * its task to people. A download or storage error is retried; on the last attempt the take FAILS.
 */
export const renderPollProcessor: JobProcessor = async (job, deps) => {
  const data = parseJobData(JOB.renderPoll, job.data);
  try {
    await pollRender(deps, data);
  } catch (error) {
    if (runAttempt(job).isLast) {
      const reason = error instanceof Error ? error.message : String(error);
      await failTake(deps, data.assetId, "FAILED", `storing the render failed: ${reason}`, [
        "RENDERING",
      ]);
    }
    throw error;
  }
};
