"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { cx } from "./cx";

/*
 * Transient confirmations ("Saved", "Invite created") and failures. Success gets the green mark
 * (success is one of Enmo Green's three jobs); errors are announced assertively.
 */

export type ToastTone = "success" | "error" | "info";

export interface ToastInput {
  title: string;
  description?: string;
  tone?: ToastTone;
}

interface ToastRecord extends Required<Pick<ToastInput, "title" | "tone">> {
  id: number;
  description?: string;
}

export interface ToastApi {
  show(toast: ToastInput): void;
  success(title: string, description?: string): void;
  error(title: string, description?: string): void;
}

const ToastContext = createContext<ToastApi | null>(null);
const MAX_VISIBLE = 4;
const DURATION_MS = { success: 4000, info: 4000, error: 7000 } as const;

let toastSequence = 0;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastRecord[]>([]);

  const dismiss = useCallback((id: number) => {
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  const api = useMemo<ToastApi>(() => {
    const show = ({ title, description, tone = "info" }: ToastInput) => {
      toastSequence += 1;
      const record: ToastRecord = { id: toastSequence, title, description, tone };
      setToasts((current) => [...current.slice(-(MAX_VISIBLE - 1)), record]);
    };
    return {
      show,
      success: (title, description) => show({ title, description, tone: "success" }),
      error: (title, description) => show({ title, description, tone: "error" }),
    };
  }, []);

  return (
    <ToastContext value={api}>
      {children}
      <div
        aria-label="Notifications"
        role="region"
        className="pointer-events-none fixed right-6 bottom-6 z-50 flex w-[min(24rem,calc(100vw-3rem))] flex-col gap-2"
      >
        {toasts.map((toast) => (
          <ToastItem key={toast.id} toast={toast} onDismiss={dismiss} />
        ))}
      </div>
    </ToastContext>
  );
}

function ToastItem({ toast, onDismiss }: { toast: ToastRecord; onDismiss: (id: number) => void }) {
  useEffect(() => {
    const timer = setTimeout(() => onDismiss(toast.id), DURATION_MS[toast.tone]);
    return () => clearTimeout(timer);
  }, [toast.id, toast.tone, onDismiss]);

  return (
    <div
      role={toast.tone === "error" ? "alert" : "status"}
      className={cx(
        "pointer-events-auto flex items-start gap-3 rounded-lg border bg-panel/95 px-4 py-3 shadow-[0_24px_60px_-24px_rgb(0_0_0/0.9)] backdrop-blur",
        "translate-y-0 opacity-100 transition-[opacity,translate] duration-250 ease-enmo starting:translate-y-2 starting:opacity-0",
        toast.tone === "error" ? "border-red-400/30" : "border-line",
      )}
    >
      <span
        aria-hidden
        className={cx(
          "mt-1.5 size-1.5 shrink-0 rounded-full",
          toast.tone === "success" && "bg-enmo",
          toast.tone === "error" && "bg-red-400",
          toast.tone === "info" && "bg-steel",
        )}
      />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <p className="text-sm text-paper">{toast.title}</p>
        {toast.description ? (
          <p className="text-xs leading-relaxed text-steel">{toast.description}</p>
        ) : null}
      </div>
      <button
        type="button"
        onClick={() => onDismiss(toast.id)}
        aria-label="Dismiss notification"
        className="-mr-1 rounded p-1 text-steel transition-colors duration-200 hover:text-paper"
      >
        <svg
          aria-hidden
          viewBox="0 0 16 16"
          className="size-3"
          fill="none"
          stroke="currentColor"
          strokeWidth={1.5}
          strokeLinecap="round"
        >
          <path d="m4 4 8 8M12 4l-8 8" />
        </svg>
      </button>
    </div>
  );
}

export function useToast(): ToastApi {
  const api = useContext(ToastContext);
  if (!api) throw new Error("useToast must be used inside <ToastProvider>");
  return api;
}
