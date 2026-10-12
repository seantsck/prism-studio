import { redirect } from "next/navigation";

/** The asset library is project-wide; the episode tab simply opens it. */
export default async function Page({ params }: { params: Promise<{ project: string; ep: string }> }) {
  const { project } = await params;
  redirect(`/projects/${project}/assets`);
}
