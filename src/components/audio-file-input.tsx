"use client";

import { useEffect, useRef, useState } from "react";
import { Circle, Mic, Square } from "lucide-react";

/**
 * Take audio source: choose a file OR record in the browser (MediaRecorder).
 *
 * The browser-measured length is sent as `durationHintSec` and shown as a provisional value while the file
 * uploads; it is NOT canonical — the server re-reads the file and stores its own duration. The manual
 * duration field is only required when no audio is attached (placeholder / temp takes).
 */
export function AudioFileInput() {
  const fileRef = useRef<HTMLInputElement>(null);
  const [hint, setHint] = useState("");
  const [hasFile, setHasFile] = useState(false);
  const [recording, setRecording] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [recError, setRecError] = useState<string | null>(null);
  const recorder = useRef<MediaRecorder | null>(null);
  const chunks = useRef<Blob[]>([]);
  const stream = useRef<MediaStream | null>(null);
  const supportsRecording = typeof window !== "undefined" && "MediaRecorder" in window;

  useEffect(() => {
    if (!recording) return;
    const t0 = Date.now();
    const id = setInterval(() => setElapsed((Date.now() - t0) / 1000), 200);
    return () => clearInterval(id);
  }, [recording]);

  useEffect(() => () => stream.current?.getTracks().forEach((t) => t.stop()), []);

  const measure = (file: File) => {
    setHasFile(true);
    const url = URL.createObjectURL(file);
    const audio = new Audio();
    audio.preload = "metadata";
    audio.onloadedmetadata = () => {
      if (Number.isFinite(audio.duration)) setHint(audio.duration.toFixed(2));
      URL.revokeObjectURL(url);
    };
    audio.onerror = () => URL.revokeObjectURL(url);
    audio.src = url;
  };

  const startRecording = async () => {
    setRecError(null);
    try {
      stream.current = await navigator.mediaDevices.getUserMedia({ audio: true });
      const rec = new MediaRecorder(stream.current);
      chunks.current = [];
      rec.ondataavailable = (e) => e.data.size > 0 && chunks.current.push(e.data);
      rec.onstop = () => {
        const type = rec.mimeType || "audio/webm";
        const ext = type.includes("ogg") ? "ogg" : type.includes("mp4") ? "m4a" : "webm";
        const file = new File(chunks.current, `recording-${Date.now()}.${ext}`, { type });
        const dt = new DataTransfer();
        dt.items.add(file);
        if (fileRef.current) fileRef.current.files = dt.files;
        measure(file);
        stream.current?.getTracks().forEach((t) => t.stop());
        setRecording(false);
      };
      recorder.current = rec;
      rec.start();
      setElapsed(0);
      setRecording(true);
    } catch {
      setRecError("Microphone access was denied or is unavailable.");
    }
  };

  return (
    <>
      <div className="col-span-2 space-y-1.5">
        <label className="block">
          <span className="mb-1 block text-[11px] text-muted">Audio file</span>
          <input
            ref={fileRef}
            type="file"
            name="file"
            accept="audio/*"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) measure(f);
              else setHasFile(false);
            }}
            className="!p-0.5"
          />
        </label>
        {supportsRecording ? (
          <div className="flex items-center gap-2">
            {recording ? (
              <button
                type="button"
                onClick={() => recorder.current?.stop()}
                className="inline-flex h-7 items-center gap-1.5 rounded-[3px] border border-fail/60 px-2 text-[12px] text-fail"
              >
                <Square className="h-3 w-3" /> Stop ({elapsed.toFixed(1)}s)
              </button>
            ) : (
              <button
                type="button"
                onClick={startRecording}
                className="inline-flex h-7 items-center gap-1.5 rounded-[3px] border border-line2 px-2 text-[12px] text-muted hover:text-fg"
              >
                <Mic className="h-3 w-3" /> Record take
              </button>
            )}
            {recording ? <Circle className="h-2.5 w-2.5 animate-pulse fill-fail text-fail" /> : null}
            {recError ? <span className="text-[11px] text-fail">{recError}</span> : null}
          </div>
        ) : null}
        <p className="text-[10.5px] text-faint">
          The file&apos;s duration is read on the server and is canonical
          {hint ? ` (browser preview: ${hint}s)` : ""}.
        </p>
      </div>
      <input type="hidden" name="durationHintSec" value={hint} />
      <label className="block">
        <span className="mb-1 block text-[11px] text-muted">
          Duration (s){hasFile ? " — read from file" : " — required without a file"}
        </span>
        <input
          name="durationSec"
          type="number"
          step="0.01"
          min="0.1"
          required={!hasFile}
          disabled={hasFile}
          placeholder="2.80"
        />
      </label>
    </>
  );
}
