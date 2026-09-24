import type { ReactNode, TdHTMLAttributes } from "react";
import { cx } from "@/components/ui/cx";

/** Minimal data-table styling shared by the admin tables. */

export function TableSection({
  title,
  description,
  children,
}: {
  title: string;
  description?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h2 className="font-display text-lg font-medium tracking-tight text-paper">{title}</h2>
        {description ? <p className="text-sm text-steel">{description}</p> : null}
      </div>
      <div className="overflow-x-auto rounded-xl border border-line bg-panel">{children}</div>
    </section>
  );
}

export function Th({ children, className }: { children?: ReactNode; className?: string }) {
  return (
    <th
      scope="col"
      className={cx(
        "border-b border-line px-4 py-3 text-left font-mono text-[10px] font-normal uppercase tracking-[0.16em] text-steel",
        className,
      )}
    >
      {children}
    </th>
  );
}

export function Td({ className, ...props }: TdHTMLAttributes<HTMLTableCellElement>) {
  return <td className={cx("px-4 py-3.5 align-middle", className)} {...props} />;
}

/** Body row with a divider, none after the last one (tables collapse borders). */
export const ROW_CLASS =
  "border-b border-line transition-colors duration-200 last:border-b-0 hover:bg-paper/[0.02]";
