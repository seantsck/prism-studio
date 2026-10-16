"use client";

import dynamic from "next/dynamic";
import type { VirtualSetProps } from "./virtual-set-editor";

// WebGL needs the browser: the editor is never server-rendered.
const VirtualSetEditor = dynamic(() => import("./virtual-set-editor").then((m) => m.VirtualSetEditor), {
  ssr: false,
  loading: () => <div className="p-6 text-sm text-muted">Loading the 3D set…</div>,
});

export function VirtualSetLoader(props: VirtualSetProps) {
  return <VirtualSetEditor {...props} />;
}
