import { cva, type VariantProps } from "class-variance-authority";
import type { ButtonHTMLAttributes, ReactNode } from "react";
import { cn } from "@/lib/utils";

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-1.5 rounded-[3px] border text-[12px] font-medium transition-colors disabled:opacity-40 disabled:pointer-events-none whitespace-nowrap",
  {
    variants: {
      variant: {
        primary: "bg-accent text-accentfg border-accent hover:brightness-110",
        secondary: "bg-panel2 text-fg border-line2 hover:bg-[#1f1f25]",
        ghost: "border-transparent text-muted hover:text-fg hover:bg-panel2",
        danger: "border-fail/50 text-fail hover:bg-fail/10",
      },
      size: { sm: "h-6 px-2", md: "h-7 px-3" },
    },
    defaultVariants: { variant: "secondary", size: "md" },
  },
);

export function Button({
  className,
  variant,
  size,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & VariantProps<typeof buttonVariants>) {
  return <button className={cn(buttonVariants({ variant, size }), className)} {...props} />;
}

type Tone = "neutral" | "pass" | "warn" | "fail" | "info" | "accent";
const TONES: Record<Tone, string> = {
  neutral: "border-line2 text-muted",
  pass: "border-pass/40 text-pass bg-pass/10",
  warn: "border-warn/40 text-warn bg-warn/10",
  fail: "border-fail/40 text-fail bg-fail/10",
  info: "border-info/40 text-info bg-info/10",
  accent: "border-accent/50 text-accent bg-accent/10",
};

export function Badge({
  tone = "neutral",
  children,
  className,
}: {
  tone?: Tone;
  children: ReactNode;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-[3px] border px-1.5 py-px text-[10.5px] uppercase tracking-wide leading-4",
        TONES[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

export function PageHeader({
  title,
  subtitle,
  actions,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="flex items-end justify-between gap-4 border-b border-line px-6 py-4">
      <div className="min-w-0">
        <h1 className="truncate text-[17px] font-semibold tracking-tight">{title}</h1>
        {subtitle ? <p className="mt-0.5 text-muted">{subtitle}</p> : null}
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
    </div>
  );
}

export function Panel({
  title,
  actions,
  children,
  className,
}: {
  title?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={cn("border border-line bg-panel rounded-[3px]", className)}>
      {title ? (
        <header className="flex items-center justify-between border-b border-line px-3 py-2">
          <h2 className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted">{title}</h2>
          {actions}
        </header>
      ) : null}
      <div className="p-3">{children}</div>
    </section>
  );
}

export function Field({
  label,
  hint,
  children,
  className,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <label className={cn("block", className)}>
      <span className="mb-1 block text-[11px] text-muted">{label}</span>
      {children}
      {hint ? <span className="mt-0.5 block text-[10.5px] text-faint">{hint}</span> : null}
    </label>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="border border-dashed border-line2 p-6 text-center text-muted">{children}</div>;
}

export function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="rounded-[2px] border border-line2 px-1 font-mono text-[10px] text-muted">{children}</kbd>
  );
}

export const STATUS_TONE: Record<string, Tone> = {
  draft: "neutral",
  prepping: "info",
  ready: "pass",
  generating: "accent",
  review: "warn",
  approved: "pass",
  locked: "accent",
};
