import { CalendarResponse, type CalendarQuery } from "@enmo/shared";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { queryKeys } from "./query-keys";

/*
 * GET /calendar (DESIGN §E "calendar"): every client's publish jobs and ghost slots over a range of
 * client-local days. Realtime `publish.updated` invalidates it; the previous month stays on screen
 * while the next one loads, so month navigation never blanks the grid.
 */
export function useCalendar(query: CalendarQuery) {
  return useQuery({
    queryKey: queryKeys.calendar.range(query),
    queryFn: ({ signal }) =>
      api("/calendar", { query: { ...query }, schema: CalendarResponse, signal }),
    placeholderData: keepPreviousData,
  });
}
