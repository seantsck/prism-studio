"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

export function NavLink({
  href,
  children,
  exact = false,
  variant = "side",
}: {
  href: string;
  children: React.ReactNode;
  exact?: boolean;
  variant?: "side" | "tab";
}) {
  const pathname = usePathname();
  const active = exact ? pathname === href : pathname === href || pathname.startsWith(`${href}/`);
  if (variant === "tab") {
    return (
      <Link
        href={href}
        className={cn(
          "border-b-2 px-3 py-2 text-[12px] transition-colors",
          active ? "border-accent text-fg" : "border-transparent text-muted hover:text-fg",
        )}
      >
        {children}
      </Link>
    );
  }
  return (
    <Link
      href={href}
      className={cn(
        "block rounded-[3px] px-2.5 py-1.5 text-[12.5px] transition-colors",
        active ? "bg-panel2 text-fg" : "text-muted hover:bg-panel2 hover:text-fg",
      )}
    >
      {children}
    </Link>
  );
}

/**
 * The sidebar's "More tools": every specialist page, one click away and out of the main path. It opens on its own when
 * the page being shown is one of them.
 */
export function MoreTools({
  base,
  items,
}: {
  base: string;
  items: ReadonlyArray<readonly [string, string]>;
}) {
  const pathname = usePathname();
  const here = items.some(
    ([href]) => pathname === `${base}${href}` || pathname.startsWith(`${base}${href}/`),
  );
  return (
    <details className="group pt-2" open={here} data-testid="nav-more">
      <summary className="cursor-pointer px-2.5 py-1 text-[11px] text-faint hover:text-fg">
        More tools
      </summary>
      <div className="mt-0.5 space-y-0.5">
        {items.map(([href, label]) => (
          <NavLink key={label} href={`${base}${href}`}>
            {label}
          </NavLink>
        ))}
      </div>
    </details>
  );
}
