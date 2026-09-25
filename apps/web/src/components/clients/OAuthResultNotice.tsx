"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useRef } from "react";
import { useToast } from "@/components/ui/Toast";
import {
  oauthNotice,
  oauthResultFrom,
  pendingSelection,
  withoutOAuthResult,
} from "./accounts-model";

/*
 * Announces what an OAuth round trip did. The API's callback redirects to the client's accounts
 * tab (or, when it lost track of the client, the client list) with `oauth`, `outcome`,
 * `connected` and `message` in the query; this shows them as a toast once, then takes them out of
 * the address so a reload or a shared link doesn't repeat it. A pick list (`outcome=choose`) is
 * left to MetaAccountPicker. Renders nothing.
 */
export function OAuthResultNotice() {
  // It reads the address, which only the browser knows.
  return (
    <Suspense fallback={null}>
      <Notice />
    </Suspense>
  );
}

function Notice() {
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const toast = useToast();
  // Effects run twice in development: the same redirect is announced once.
  const announced = useRef<string | null>(null);
  const search = params.toString();

  useEffect(() => {
    if (!params.has("oauth") || announced.current === search) return;
    const result = oauthResultFrom(params);
    // A pick list is the picker's to show and clear (MetaAccountPicker).
    if (pendingSelection(result)) return;
    announced.current = search;
    if (result) toast.show(oauthNotice(result));
    router.replace(`${pathname}${withoutOAuthResult(search)}`, { scroll: false });
  }, [params, search, pathname, router, toast]);

  return null;
}
