import { QueryClient } from "@tanstack/react-query";
import { ApiError } from "./api";

/** One QueryClient per browser session (mounted by app/providers.tsx). */
export function makeQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        refetchOnWindowFocus: false,
        // Client errors will not fix themselves on retry; network and 5xx errors might.
        retry: (failureCount, error) =>
          !(error instanceof ApiError && error.status > 0 && error.status < 500) &&
          failureCount < 2,
      },
      mutations: {
        // Mutations are not idempotent in general (creating a client twice makes two clients).
        retry: false,
      },
    },
  });
}
