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
 * Title block used at the top of every dashboard page. Sized per the
 * messages-cockpit Stitch design — 24px bold h1, short description
 * directly under, optional breadcrumb above, actions floated right at
 * the title's baseline on md+. Tighter than the v1 hero-style 40px
 * title; matches the cockpit-style design language meant to feel dense
 * and professional.
 */
export function PageHeader({
  title,
  description,
  breadcrumb,
  actions,
}: PageHeaderProps) {
  return (
    <header className="flex flex-col gap-2">
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
      {/* Title row: title+description left, actions right. Description
       *  sits inside the left column so actions stay glued to the title's
       *  baseline (per Stitch). */}
      <div className="flex flex-col gap-2 md:flex-row md:items-start md:justify-between md:gap-6">
        <div className="flex flex-col gap-1 min-w-0">
          <h1 className="text-2xl font-bold leading-tight tracking-[-0.02em]">
            {title}
          </h1>
          {description && (
            <p className="text-muted-foreground max-w-3xl text-sm">
              {description}
            </p>
          )}
        </div>
        {actions && (
          <div className="flex shrink-0 items-center gap-3">{actions}</div>
        )}
      </div>
    </header>
  );
}
