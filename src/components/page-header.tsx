import { Fragment, type ReactNode } from "react";
import Link from "next/link";

export type Crumb = { label: string; href?: string };

export type PageHeaderProps = {
  title: string;
  description?: ReactNode;
  /** Optional uppercase tracking-widest trail rendered above the title.
   *  The last entry is treated as the current page (no link styling). */
  breadcrumb?: Crumb[];
  /** Right-side action slot — typically buttons. Aligned to the title's
   *  bottom baseline on md+. */
  actions?: ReactNode;
};

/**
 * Title block used at the top of every dashboard page. Keeps the
 * mockup's spacing/baseline contract in one place: 40px black title,
 * tiny muted breadcrumb above, optional description below, actions
 * floated right at the title's baseline on md+.
 */
export function PageHeader({
  title,
  description,
  breadcrumb,
  actions,
}: PageHeaderProps) {
  return (
    <header className="flex flex-col gap-3">
      {breadcrumb && breadcrumb.length > 0 && (
        <nav
          aria-label="Breadcrumb"
          className="text-muted-foreground flex flex-wrap items-center gap-2 text-[10px] font-bold uppercase tracking-widest"
        >
          {breadcrumb.map((crumb, i) => {
            const isLast = i === breadcrumb.length - 1;
            return (
              <Fragment key={`${crumb.label}-${i}`}>
                {i > 0 && <span aria-hidden>/</span>}
                {crumb.href && !isLast ? (
                  <Link
                    href={crumb.href}
                    className="hover:text-foreground transition-colors"
                  >
                    {crumb.label}
                  </Link>
                ) : (
                  <span className={isLast ? "text-foreground" : ""}>
                    {crumb.label}
                  </span>
                )}
              </Fragment>
            );
          })}
        </nav>
      )}
      {/* Title row: title left, actions right, both bottom-aligned. The
       *  description renders OUTSIDE this row so the actions stay anchored
       *  to the title's baseline (matches the mockup, where there's no
       *  description and the buttons sit flush with the h1 bottom). */}
      <div className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between md:gap-6">
        <h1 className="text-[2.5rem] font-extrabold leading-[1.1] tracking-[-0.02em]">
          {title}
        </h1>
        {actions && (
          <div className="flex items-center gap-3">{actions}</div>
        )}
      </div>
      {description && (
        <p className="text-muted-foreground max-w-3xl text-sm">
          {description}
        </p>
      )}
    </header>
  );
}
