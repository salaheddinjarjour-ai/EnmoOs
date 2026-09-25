import { submitRender } from "../../orchestrator/renders";
import { failTake } from "../../orchestrator/render-outcomes";
import { JOB, parseJobData } from "../queues";
import { runAttempt, type JobProcessor } from "../types";

/**
 * render.submit (media queue, DESIGN §D/§F). Parses RenderSubmitJob; does nothing unless the Asset
 * is still QUEUED (a Vault take waits for the Visual Director first). Builds the VisualRequest from
 * the Asset row (prompt, negativePrompt, AssetParams.shot for kind/aspect ratio/duration/seed, the
 * client's visual style), calls deps.visual.submit, stores providerJobId/providerModel, moves the
 * Asset to RENDERING (an asset.updated event) and queues the first render.poll. When the provider
 * keeps failing through BullMQ's last attempt, the take FAILS and its task is handed to people.
 */
export const renderSubmitProcessor: JobProcessor = async (job, deps) => {
  const { assetId } = parseJobData(JOB.renderSubmit, job.data);
  try {
    await submitRender(deps, assetId);
  } catch (error) {
    if (runAttempt(job).isLast) {
      const reason = error instanceof Error ? error.message : String(error);
      await failTake(deps, assetId, "FAILED", `submitting it failed after every retry: ${reason}`, [
        "QUEUED",
      ]);
    }
    throw error;
  }
};
