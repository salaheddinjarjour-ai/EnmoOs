import { PublishJobDto, type CalendarResponse } from "@enmo/shared";
import {
  useMutation,
  useMutationState,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";
import { withJob, type PendingMove } from "@/components/calendar/calendar-model";
import { api, apiPath } from "@/lib/api";
import { queryKeys } from "./query-keys";

/*
 * The publish-job controls behind the calendar (DESIGN §E "calendar"): reschedule (a drag, or
 * "Move to date"), retry and cancel. Every one is keyed under queryKeys.publishJobs.all, so a view
 * can tell a publish-job change is in flight.
 *
 * A reschedule is optimistic without touching the cache: the calendar draws each pending move from
 * the mutation itself (usePendingMoves), so a refetch that lands mid-flight (another job's
 * publish.updated) can't snap the job back, and a failed move simply stops being drawn: that is
 * the rollback. The API's answer is written into every cached range before the refetch.
 */

export interface RescheduleInput {
  jobId: string;
  /** The client-local day to move to; the optimizer picks the hour. */
  date: string;
}

const MUTATION_KEYS = {
  reschedule: [...queryKeys.publishJobs.all, "reschedule"],
  retry: [...queryKeys.publishJobs.all, "retry"],
  cancel: [...queryKeys.publishJobs.all, "cancel"],
} as const;

function storeJob(queryClient: QueryClient, job: PublishJobDto): void {
  queryClient.setQueriesData<CalendarResponse>({ queryKey: queryKeys.calendar.all }, (current) =>
    current ? withJob(current, job) : current,
  );
  queryClient.setQueryData(queryKeys.publishJobs.detail(job.id), job);
}

/** Cards read PostDto.publishing, and the post's own status can follow its jobs. */
function refresh(queryClient: QueryClient): void {
  void queryClient.invalidateQueries({ queryKey: queryKeys.calendar.all });
  void queryClient.invalidateQueries({ queryKey: queryKeys.posts.all });
}

/** PATCH /publish-jobs/:id {date}: the best free hour of that day (409 when it has none). */
export function useReschedulePublishJob() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationKey: MUTATION_KEYS.reschedule,
    mutationFn: ({ jobId, date }: RescheduleInput) =>
      api(apiPath("publish-jobs", jobId), {
        method: "PATCH",
        body: { date },
        schema: PublishJobDto,
      }),
    onMutate: () => queryClient.cancelQueries({ queryKey: queryKeys.calendar.all }),
    onSuccess: (job) => storeJob(queryClient, job),
    onSettled: () => refresh(queryClient),
  });
}

/** The moves still waiting on the API, oldest first (the calendar draws the latest per job). */
export function usePendingMoves(): PendingMove[] {
  return useMutationState({
    filters: { mutationKey: MUTATION_KEYS.reschedule, status: "pending" },
    select: (mutation) => mutation.state.variables as RescheduleInput,
  });
}

/** POST /publish-jobs/:id/retry: a FAILED job goes out again now (resuming its container). */
export function useRetryPublishJob() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationKey: MUTATION_KEYS.retry,
    mutationFn: (jobId: string) =>
      api(apiPath("publish-jobs", jobId, "retry"), { method: "POST", schema: PublishJobDto }),
    onSuccess: (job) => storeJob(queryClient, job),
    onSettled: () => refresh(queryClient),
  });
}

/** POST /publish-jobs/:id/cancel: a job that hasn't started publishing is called off. */
export function useCancelPublishJob() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationKey: MUTATION_KEYS.cancel,
    mutationFn: (jobId: string) =>
      api(apiPath("publish-jobs", jobId, "cancel"), { method: "POST", schema: PublishJobDto }),
    onSuccess: (job) => storeJob(queryClient, job),
    onSettled: () => refresh(queryClient),
  });
}
