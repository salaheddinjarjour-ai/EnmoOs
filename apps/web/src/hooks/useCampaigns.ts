import {
  AgentTaskDto,
  AgentTaskListResponse,
  CampaignDto,
  CampaignListResponse,
  type CampaignListQuery,
  type CreateCampaignRequest,
  type ResolveAgentTaskRequest,
} from "@enmo/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, apiPath } from "@/lib/api";
import { queryKeys } from "./query-keys";

/*
 * Campaigns (DESIGN §E "campaigns and chat") and their agent tasks. A campaign opens with its first
 * brief turn; the Manager's intake runs in the background and answers in the thread.
 */

export function useCampaigns(filters: CampaignListQuery = {}) {
  return useQuery({
    queryKey: queryKeys.campaigns.list(filters),
    queryFn: ({ signal }) =>
      api("/campaigns", { query: { ...filters }, schema: CampaignListResponse, signal }),
    select: (data) => data.items,
  });
}

export function useCampaign(campaignId: string) {
  return useQuery({
    queryKey: queryKeys.campaigns.detail(campaignId),
    queryFn: ({ signal }) => api(apiPath("campaigns", campaignId), { schema: CampaignDto, signal }),
  });
}

export function useCreateCampaign() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateCampaignRequest) =>
      api("/campaigns", { method: "POST", body, schema: CampaignDto }),
    onSuccess: (campaign) => {
      queryClient.setQueryData(queryKeys.campaigns.detail(campaign.id), campaign);
      return queryClient.invalidateQueries({ queryKey: queryKeys.campaigns.lists() });
    },
  });
}

/** Every task of the campaign's graphs (escalation cards read whether theirs is still open). */
export function useCampaignTasks(
  campaignId: string,
  { enabled = true }: { enabled?: boolean } = {},
) {
  return useQuery({
    queryKey: queryKeys.campaigns.tasks(campaignId),
    queryFn: ({ signal }) =>
      api(apiPath("campaigns", campaignId, "tasks"), { schema: AgentTaskListResponse, signal }),
    select: (data) => data.items,
    enabled,
  });
}

/** POST /agent-tasks/:id/resolve: retry an escalated or failed task (MANAGER+). */
export function useResolveTask(campaignId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ taskId, action }: { taskId: string } & ResolveAgentTaskRequest) =>
      api(apiPath("agent-tasks", taskId, "resolve"), {
        method: "POST",
        body: { action },
        schema: AgentTaskDto,
      }),
    onSuccess: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.campaigns.tasks(campaignId) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.posts.all }),
      ]),
  });
}
