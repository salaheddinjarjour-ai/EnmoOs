"use client";

import { Button } from "@/components/ui/Button";
import { useToast } from "@/components/ui/Toast";
import { useStartMetaOAuth } from "@/hooks/useOAuth";
import { errorMessage } from "@/lib/api";
import { useRuntimeCapabilities } from "@/lib/capabilities";

/*
 * ADMIN only (the parent gates it): sends the browser to Meta's consent screen for this client.
 * Meta brings the admin back through the API's callback to the accounts tab, where
 * OAuthResultNotice says how it went. Without the Meta app's credentials on the API there is no
 * consent screen to go to, so the button says so instead of failing on click.
 */
export function ConnectMetaButton({ clientId }: { clientId: string }) {
  const toast = useToast();
  const runtime = useRuntimeCapabilities();
  const start = useStartMetaOAuth();
  const unavailable = runtime.data?.integrations.meta === false;

  return (
    <div className="flex flex-col items-start gap-3">
      <Button
        variant="primary"
        // Stays busy after success: the page is on its way to Meta.
        loading={start.isPending || start.isSuccess}
        disabled={unavailable}
        aria-describedby={unavailable ? "connect-meta-unavailable" : undefined}
        onClick={() =>
          start.mutate(clientId, {
            onError: (error) => toast.error("Couldn't start the Meta sign-in", errorMessage(error)),
          })
        }
      >
        Connect Meta
      </Button>
      {unavailable ? (
        <p id="connect-meta-unavailable" className="max-w-xl text-xs leading-relaxed text-steel">
          Meta sign-in needs the Meta app&apos;s credentials on the API (META_APP_ID and
          META_APP_SECRET). Until they are set, connect accounts with a pasted token below.
        </p>
      ) : null}
    </div>
  );
}
