"use client";

import { useEffect, useState, type ReactNode } from "react";

/**
 * A picture that opens large when clicked (Escape, the ✕ or a click outside closes it). What is passed as children is
 * shown under the large picture: the actions that belong to it (use it, lock it …).
 */
export function ZoomImage({
  src,
  alt,
  className,
  caption,
  children,
  testId,
  wrapperClassName = "block",
}: {
  src: string;
  alt: string;
  className?: string;
  caption?: ReactNode;
  children?: ReactNode;
  testId?: string;
  /** the clickable box around the picture ("block h-full w-full" to fill a sized frame) */
  wrapperClassName?: string;
}) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const close = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [open]);
  return (
    <>
      <button
        type="button"
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setOpen(true);
        }}
        className={`${wrapperClassName} cursor-zoom-in p-0`}
        title="Click to see it large"
        data-testid="zoom-open"
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={src} alt={alt} className={className} data-testid={testId} />
      </button>
      {open ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/85 p-6"
          role="dialog"
          aria-modal="true"
          aria-label={alt}
          onClick={() => setOpen(false)}
          data-testid="zoom-dialog"
        >
          <div
            className="flex max-h-full max-w-full flex-col items-center gap-2"
            onClick={(e) => e.stopPropagation()}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={src}
              alt={alt}
              className="max-h-[82vh] max-w-[90vw] rounded-[3px] object-contain"
              data-testid="zoom-image"
            />
            {caption ? <div className="text-[12.5px] text-fg">{caption}</div> : null}
            <div className="flex flex-wrap items-center justify-center gap-2">
              {children}
              <button
                type="button"
                className="rounded-[3px] border border-line2 px-2 py-1 text-[12px] text-fg hover:bg-panel2"
                onClick={() => setOpen(false)}
                data-testid="zoom-close"
              >
                ✕ Close
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
