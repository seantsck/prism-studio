// PRISM PATCH (replaces upstream engine/entranceAnimation.ts): the entrance effect is a Spark-dyno polish
// feature that is not part of the Prism 3D set. The editor only ever calls `tick` and `clear`.
export class EntranceAnimator {
  play(_object: unknown): void {}
  tick(_deltaSeconds: number): void {}
  clear(): void {}
}
