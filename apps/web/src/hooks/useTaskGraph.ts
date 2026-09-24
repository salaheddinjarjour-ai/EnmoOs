import { TaskGraphDto, type RequestPlanChangesRequest } from "@enmo/shared";
import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { api, apiPath } from "@/lib/api";
import { queryKeys } from "./query-keys";

/*
 * Plans (DESIGN §D "Graph lifecycle"): the PlanCard's task graph, approving it (the point where
 * generation spend starts) and asking for a new version with the reviewer's words verbatim.
 */

export function useTaskGraph(graphId: string) {
  return useQuery({
    queryKey: queryKeys.taskGraphs.detail(graphId),
    queryFn: ({ signal }) => api(apiPath("task-graphs", graphId), { schema: TaskGraphDto, signal }),
  });
}

function storeGraph(queryClient: QueryClient, graph: TaskGraphDto): Promise<unknown> {
  queryClient.setQueryData(queryKeys.taskGraphs.detail(graph.id), graph);
  return Promise.all([
    queryClient.invalidateQueries({ queryKey: queryKeys.campaigns.all }),
    queryClient.invalidateQueries({ queryKey: queryKeys.threads.all }),
  ]);
}

export function useApprovePlan() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (graphId: string) =>
      api(apiPath("task-graphs", graphId, "approve"), { method: "POST", schema: TaskGraphDto }),
    onSuccess: (graph) =>
      Promise.all([
        storeGraph(queryClient, graph),
        queryClient.invalidateQueries({ queryKey: queryKeys.posts.all }),
        queryClient.invalidateQueries({ queryKey: queryKeys.budget }),
      ]),
  });
}

/** The feedback travels byte-for-byte: it is never trimmed or rewritten here. */
export function useRequestPlanChanges() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ graphId, feedback }: { graphId: string } & RequestPlanChangesRequest) =>
      api(apiPath("task-graphs", graphId, "request-changes"), {
        method: "POST",
        body: { feedback },
        schema: TaskGraphDto,
      }),
    onSuccess: (graph) => storeGraph(queryClient, graph),
  });
}
