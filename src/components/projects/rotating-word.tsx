"use client";

import { useEffect, useState } from "react";

/**
 * One word of a heading that changes in place ("What's your [series] about?"), each one sliding in. The heading takes
 * each word's own width, so there are no gaps around a short word. Screen readers get the first word only, and a
 * visitor who asks for reduced motion sees it stay put.
 */
export function RotatingWord({ words, everyMs = 2000 }: { words: readonly string[]; everyMs?: number }) {
  const [at, setAt] = useState(0);
  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const timer = window.setInterval(() => setAt((i) => (i + 1) % words.length), everyMs);
    return () => window.clearInterval(timer);
  }, [words.length, everyMs]);
  return (
    <>
      <span className="sr-only">{words[0]}</span>
      <span
        key={at}
        aria-hidden
        className="rotating-word inline-block text-accent"
        data-testid="rotating-word"
        data-word={words[at]}
      >
        {words[at]}
      </span>
    </>
  );
}
