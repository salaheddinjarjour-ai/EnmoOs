import type { VisualOutput } from "./types";

/*
 * Fetching a render the provider finished (DESIGN §F: outputs are always downloaded into our own
 * Storage, never linked). One function for every provider: Higgsfield's outputs are https URLs on
 * its CDN, MockProvider's are data: URLs, and fetch reads both.
 */

export interface DownloadedOutput {
  bytes: Buffer;
  /** The output's declared type, else the response's Content-Type, without parameters. */
  mimeType: string;
}

export async function downloadOutput(
  output: VisualOutput,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
): Promise<DownloadedOutput> {
  const response = await fetchImpl(output.url);
  if (!response.ok) {
    throw new Error(`Downloading the render failed with HTTP ${response.status}`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  const mimeType = output.mimeType || response.headers.get("content-type") || "";
  return { bytes, mimeType: mimeType.split(";")[0]!.trim().toLowerCase() };
}
