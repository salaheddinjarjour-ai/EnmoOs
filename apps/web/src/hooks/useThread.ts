import { ChatMessageDto, ThreadMessagesResponse } from "@enmo/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, apiPath } from "@/lib/api";
import { upsertMessage } from "@/lib/realtime-events";
import { queryKeys } from "./query-keys";

/*
 * A campaign's chat thread (DESIGN §E): the whole thread, oldest first. Live message.created and
 * message.updated events patch the cached list in place (lib/realtime), so it is fetched once per
 * visit and refetched only when the stream (re)opens without a replay cursor.
 */

export function useThreadMessages(threadId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.threads.messages(threadId ?? ""),
    queryFn: async ({ signal }) => {
      const data = await api(apiPath("threads", threadId ?? "", "messages"), {
        schema: ThreadMessagesResponse,
        signal,
      });
      return data.items;
    },
    enabled: Boolean(threadId),
    // Events keep it current; a remount must not throw away messages the stream already patched in.
    staleTime: Infinity,
  });
}

/** Stores the user's turn verbatim; the Manager answers in the background. */
export function usePostMessage(threadId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (content: string) =>
      api(apiPath("threads", threadId, "messages"), {
        method: "POST",
        body: { content },
        schema: ChatMessageDto,
      }),
    onSuccess: (message) => {
      queryClient.setQueryData<ChatMessageDto[]>(queryKeys.threads.messages(threadId), (current) =>
        current ? upsertMessage(current, message) : current,
      );
      return queryClient.invalidateQueries({ queryKey: queryKeys.campaigns.all });
    },
  });
}
