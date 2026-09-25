import { regenerateVaultTake } from "../../orchestrator/vault-takes";
import { JOB, parseJobData } from "../queues";
import { runAttempt, type JobProcessor } from "../types";

/**
 * visual.regenerate (agents queue): the Vault's Regenerate of a take outside any plan (a take on a
 * planned post is directed by its revision task's task.run instead). Parses VisualRegenerateJob;
 * does nothing unless the new version is still QUEUED. Gives the Visual Director its original
 * context back (brand, post, copy, the take's shot as previousShots, the instruction verbatim as
 * HUMAN feedback), stores the re-planned shot on the Asset and queues render.submit.
 */
export const visualRegenerateProcessor: JobProcessor = async (job, deps) => {
  const { assetId } = parseJobData(JOB.visualRegenerate, job.data);
  await regenerateVaultTake(deps, assetId, runAttempt(job));
};
