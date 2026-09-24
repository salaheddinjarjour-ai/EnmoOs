"use client";

import { useId, useState, type KeyboardEvent, type ReactNode } from "react";
import { cx } from "./cx";

/*
 * WAI-ARIA tabs (automatic activation): arrow keys, Home and End move between tabs, and every
 * panel is labelled by its tab. With `keepMounted`, inactive panels stay in the DOM (hidden) so
 * unsaved drafts survive switching tabs.
 */

export interface TabItem {
  id: string;
  label: ReactNode;
  /** Small trailing marker, e.g. a count or an "unsaved" dot. */
  badge?: ReactNode;
  content: ReactNode;
}

export interface TabsProps {
  /** Accessible name of the tab list. */
  label: string;
  items: readonly TabItem[];
  value?: string;
  defaultValue?: string;
  onValueChange?: (id: string) => void;
  keepMounted?: boolean;
  className?: string;
  listClassName?: string;
  panelClassName?: string;
}

export function Tabs({
  label,
  items,
  value,
  defaultValue,
  onValueChange,
  keepMounted = false,
  className,
  listClassName,
  panelClassName,
}: TabsProps) {
  const baseId = useId();
  const [uncontrolled, setUncontrolled] = useState(defaultValue ?? items[0]?.id ?? "");
  const requested = value ?? uncontrolled;
  const active = items.some((item) => item.id === requested) ? requested : (items[0]?.id ?? "");

  const tabId = (id: string) => `${baseId}-tab-${id}`;
  const panelId = (id: string) => `${baseId}-panel-${id}`;

  function select(id: string) {
    if (value === undefined) setUncontrolled(id);
    onValueChange?.(id);
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const index = items.findIndex((item) => item.id === active);
    const last = items.length - 1;
    const target = {
      ArrowRight: index >= last ? 0 : index + 1,
      ArrowLeft: index <= 0 ? last : index - 1,
      Home: 0,
      End: last,
    }[event.key];
    const next = target === undefined ? undefined : items[target];
    if (!next) return;
    event.preventDefault();
    select(next.id);
    document.getElementById(tabId(next.id))?.focus();
  }

  return (
    <div className={cx("flex flex-col", className)}>
      <div
        role="tablist"
        aria-label={label}
        onKeyDown={onKeyDown}
        className={cx(
          "flex items-center gap-1 overflow-x-auto border-b border-line",
          listClassName,
        )}
      >
        {items.map((item) => {
          const selected = item.id === active;
          return (
            <button
              key={item.id}
              id={tabId(item.id)}
              type="button"
              role="tab"
              aria-selected={selected}
              aria-controls={panelId(item.id)}
              tabIndex={selected ? 0 : -1}
              onClick={() => select(item.id)}
              className={cx(
                "relative flex h-11 shrink-0 items-center gap-2 px-3.5 text-sm transition-colors duration-200 ease-enmo",
                selected ? "text-paper" : "text-steel hover:text-paper",
              )}
            >
              {item.label}
              {item.badge}
              <span
                aria-hidden
                className={cx(
                  "absolute inset-x-2 bottom-0 h-px bg-paper transition-opacity duration-250 ease-enmo",
                  selected ? "opacity-100" : "opacity-0",
                )}
              />
            </button>
          );
        })}
      </div>
      {items.map((item) => {
        const selected = item.id === active;
        if (!selected && !keepMounted) return null;
        return (
          <div
            key={item.id}
            id={panelId(item.id)}
            role="tabpanel"
            aria-labelledby={tabId(item.id)}
            hidden={!selected}
            tabIndex={0}
            className={cx("pt-8 focus-visible:outline-none", panelClassName)}
          >
            {item.content}
          </div>
        );
      })}
    </div>
  );
}
