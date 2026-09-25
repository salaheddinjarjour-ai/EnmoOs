import type { LlmImageBlock, LlmRequest } from "../types";

/** What a fixture may look at besides the input: the images the call carried (runAgent `images`). */
export interface MockCall {
  images: readonly LlmImageBlock[];
}

export function mockCallOf(request: LlmRequest): MockCall {
  const images: LlmImageBlock[] = [];
  for (const message of request.messages) {
    if (message.role !== "user" || typeof message.content === "string") continue;
    for (const block of message.content) if (block.type === "image") images.push(block);
  }
  return { images };
}
