"use client";

import { useSyncExternalStore } from "react";

/**
 * The image model the creator chose in the Reference Studio, remembered in this browser, so the choice holds from one
 * Character to the next and from one visit to the next. Without it the Studio went back to the free test model each
 * time, and the next Generate drew a test pattern instead of a picture.
 *
 * Only the creator's own choice is ever stored (never a suggestion). A remembered paid model changes nothing about
 * spending: every paid picture still shows its price on the button and starts only from that click.
 */
const KEY = "prism-studio.reference-studio.model";
const listeners = new Set<() => void>();

function read(): string {
  try {
    return window.localStorage.getItem(KEY) ?? "";
  } catch {
    // storage is switched off (private browsing, a locked-down browser): the choice lasts for this visit
    return "";
  }
}

function subscribe(onChange: () => void): () => void {
  listeners.add(onChange);
  window.addEventListener("storage", onChange);
  return () => {
    listeners.delete(onChange);
    window.removeEventListener("storage", onChange);
  };
}

/** Remembers a model the creator chose themselves ("provider/modelId"). */
export function rememberModel(value: string): void {
  try {
    window.localStorage.setItem(KEY, value);
  } catch {
    // not stored: the Studio keeps the choice in its own state for this visit
  }
  for (const listener of listeners) listener();
}

/** The remembered model, or "" (always "" on the server, so the first render is the same in both places). */
export function useRememberedModel(): string {
  return useSyncExternalStore(subscribe, read, () => "");
}
