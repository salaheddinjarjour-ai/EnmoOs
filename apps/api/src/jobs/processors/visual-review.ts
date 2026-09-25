import { reviewTake } from "../../orchestrator/visual-review";
import { JOB, parseJobData } from "../queues";
import { runAttempt, type JobProcessor } from "../types";

/**
 * visual.review (agents queue, DESIGN §C/§D). Parses VisualReviewJob; does nothing unless the
 * Asset is READY, not yet reviewed and still awaited (its direct task WAITING, or a Vault take).
 * Reads the render back from deps.storage, downscales it with toReviewImage, runs
 * VISUAL_DIRECTOR.review with the image, stores Asset.review (AssetReview) and calls onReviewDone:
 * accept, regenerate as the next version, or escalate after MAX_VISUAL_REGENERATIONS. An
 * AgentEscalation escalates the direct task; a budget stop re-queues the review for after UTC
 * midnight while the task keeps WAITING.
 */
export const visualReviewProcessor: JobProcessor = async (job, deps) => {
  const { assetId } = parseJobData(JOB.visualReview, job.data);
  await reviewTake(deps, assetId, runAttempt(job));
};
