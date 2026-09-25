"use client";

import { useRouter } from "next/navigation";
import { useEffect, useEffectEvent, useRef, useState } from "react";
import {
  isTypingTarget,
  NAV_CHORD_LEADER,
  NAV_CHORD_TIMEOUT_MS,
  navItemForShortcut,
  RAIL_TOGGLE_KEY,
  type NavItem,
} from "@/lib/nav";

/**
 * The sidebar's keyboard layer: G then a screen's letter opens it, "[" folds the rail. Keys typed
 * into a field, with a modifier held, or behind an open dialog are left alone. Returns whether a
 * chord is waiting for its second key, so the sidebar can light up the letters.
 */
export function useNavShortcuts({
  items,
  onToggleRail,
  onNavigate,
}: {
  items: readonly NavItem[];
  onToggleRail: () => void;
  onNavigate?: () => void;
}): boolean {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const pendingRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const setChord = (next: boolean) => {
    clearTimeout(timerRef.current);
    pendingRef.current = next;
    setPending(next);
    if (next) timerRef.current = setTimeout(() => setChord(false), NAV_CHORD_TIMEOUT_MS);
  };

  const onKeyDown = useEffectEvent((event: KeyboardEvent) => {
    if (event.defaultPrevented || event.repeat || event.isComposing) return;
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    if (isTypingTarget(event.target) || document.querySelector("dialog[open]")) {
      if (pendingRef.current) setChord(false);
      return;
    }
    if (pendingRef.current) {
      setChord(false);
      const item = navItemForShortcut(event.key, items);
      if (!item) return;
      event.preventDefault();
      onNavigate?.();
      router.push(item.href);
      return;
    }
    if (event.key.toLowerCase() === NAV_CHORD_LEADER) {
      setChord(true);
      return;
    }
    if (event.key === RAIL_TOGGLE_KEY) {
      event.preventDefault();
      onToggleRail();
    }
  });

  useEffect(() => {
    const listener = (event: KeyboardEvent) => onKeyDown(event);
    document.addEventListener("keydown", listener);
    return () => {
      document.removeEventListener("keydown", listener);
      clearTimeout(timerRef.current);
    };
  }, []);

  return pending;
}
