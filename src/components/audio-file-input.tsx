"use client";

import { useState } from "react";

/** File picker that measures the audio duration in the browser and fills the take's duration field. */
export function AudioFileInput() {
  const [seconds, setSeconds] = useState("");

  const onFile = (file: File | undefined) => {
    if (!file) return;
    const url = URL.createObjectURL(file);
    const audio = new Audio();
    audio.preload = "metadata";
    audio.onloadedmetadata = () => {
      if (Number.isFinite(audio.duration)) setSeconds(audio.duration.toFixed(2));
      URL.revokeObjectURL(url);
    };
    audio.onerror = () => URL.revokeObjectURL(url);
    audio.src = url;
  };

  return (
    <>
      <label className="block">
        <span className="mb-1 block text-[11px] text-muted">Audio file (optional)</span>
        <input
          type="file"
          name="file"
          accept="audio/*"
          onChange={(e) => onFile(e.target.files?.[0])}
          className="!p-0.5"
        />
      </label>
      <label className="block">
        <span className="mb-1 block text-[11px] text-muted">Duration (s)</span>
        <input
          name="durationSec"
          type="number"
          step="0.01"
          min="0.1"
          required
          value={seconds}
          onChange={(e) => setSeconds(e.target.value)}
          placeholder="2.80"
        />
      </label>
    </>
  );
}
