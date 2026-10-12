import { buildSeedProject, uid } from "@/data/seed";
import type { ProjectData, Shot } from "@/domain/schemas";

export { uid };
export const seed = (): ProjectData => structuredClone(buildSeedProject());
export const shotByCode = (data: ProjectData, code: string): Shot => {
  const s = data.shots.find((x) => x.shotCode === code);
  if (!s) throw new Error(`no shot ${code}`);
  return s;
};
