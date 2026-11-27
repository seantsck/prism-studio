import "server-only";
import { randomUUID } from "node:crypto";
import { projectSchema, type Project } from "@/domain/schemas";
import { newProjectRecords } from "@/domain/series-start";
import { CHARACTER_STUDIO_SLUG, CHARACTER_STUDIO_TITLE } from "@/domain/standalone-character";
import { UserFacingError } from "./action-result";
import { getRepo } from "./repo";

/** The account's own project for Characters and Locations made outside any story (purpose `library`), made the first time. */
export async function characterStudio(): Promise<Project> {
  const repo = await getRepo();
  const all = await repo.listProjects();
  const found = all.find((p) => p.purpose === "library");
  if (found) return found;
  const taken = new Set([
    ...all.map((p) => p.slug),
    ...(await repo.trashedProjects()).projects.map((t) => t.project.slug),
  ]);
  let slug = CHARACTER_STUDIO_SLUG;
  while (taken.has(slug)) slug = `${CHARACTER_STUDIO_SLUG}-${randomUUID().slice(0, 4)}`;
  const records = newProjectRecords({
    id: randomUUID(),
    userId: repo.currentUserId(),
    title: CHARACTER_STUDIO_TITLE,
    slug,
    projectType: "film",
    description: "Characters and locations made on their own, ready to add to any project.",
    now: new Date().toISOString(),
  });
  const project = projectSchema.parse({ ...records.project, purpose: "library" });
  try {
    await repo.createProject(project, records.bible);
  } catch (err) {
    // 23514: the purpose check does not allow `library` yet
    if ((err as { code?: string }).code === "23514")
      throw new UserFacingError(
        "Creating characters and locations on their own needs a one-time database update (migration 0065) that has not been applied yet.",
      );
    throw err;
  }
  return project;
}

