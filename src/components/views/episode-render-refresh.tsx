"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

/** 5B-V4: while a render is active, re-read the page every 1.5 s so its state and progress stay current. */
export function RenderAutoRefresh({ active }: { active: boolean }) {
  const router = useRouter();
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => router.refresh(), 1500);
    return () => clearInterval(t);
  }, [active, router]);
  return null;
}
