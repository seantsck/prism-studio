import type { MediaPort } from "./controller";

/**
 * A browser media element as a controller `MediaPort`. The element only follows the master clock: the controller
 * loads, seeks, plays and pauses it; its own time is read only to measure drift.
 */
export class DomMediaPort implements MediaPort {
  constructor(private readonly el: HTMLMediaElement) {}

  get url(): string | null {
    return this.el.getAttribute("src");
  }

  load(url: string | null): void {
    if (url) this.el.setAttribute("src", url);
    else this.el.removeAttribute("src");
    this.el.load();
  }

  currentTimeMs(): number {
    return this.el.currentTime * 1000;
  }

  seekMs(ms: number): void {
    try {
      this.el.currentTime = ms / 1000;
    } catch {
      // not seekable yet: the next drift check seeks again
    }
  }

  play(): Promise<void> {
    return this.el.play();
  }

  pause(): void {
    this.el.pause();
  }

  setMuted(muted: boolean): void {
    this.el.muted = muted;
  }

  onError(cb: () => void): void {
    // an element with no source is not a failure (it is simply idle)
    this.el.addEventListener("error", () => {
      if (this.el.getAttribute("src")) cb();
    });
  }

  dispose(): void {
    this.el.pause();
    this.el.removeAttribute("src");
    this.el.load();
  }
}

export const audioPort = (): DomMediaPort => {
  const audio = new Audio();
  audio.preload = "auto";
  return new DomMediaPort(audio);
};
