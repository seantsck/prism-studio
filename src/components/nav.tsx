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
