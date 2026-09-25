"use client";

import { useCallback, useSyncExternalStore } from "react";

/*
 * Whether the desktop sidebar is folded to its icon rail: a per-browser preference, so it lives
 * in localStorage (and follows other tabs through the storage event). Storage can be missing or
 * throw (private windows, blocked site data); the choice then lasts for this page's lifetime.
 */

const STORAGE_KEY = "enmo:sidebar-rail";
const listeners = new Set<() => void>();
let fallback: boolean | null = null;

function readStored(): boolean {
  try {
    return window.localStorage.getItem(STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

function getSnapshot(): boolean {
  return fallback ?? readStored();
}

function getServerSnapshot(): boolean {
  return false;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  const onStorage = (event: StorageEvent) => {
    if (event.key !== STORAGE_KEY) return;
    fallback = null;
    listener();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}

function writeRail(rail: boolean): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, rail ? "1" : "0");
    fallback = null;
  } catch {
    fallback = rail;
  }
  for (const listener of listeners) listener();
}

export function useSidebarRail(): readonly [boolean, (rail: boolean) => void] {
  const rail = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const setRail = useCallback((next: boolean) => writeRail(next), []);
  return [rail, setRail] as const;
}
