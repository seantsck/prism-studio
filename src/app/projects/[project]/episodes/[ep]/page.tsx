import { redirect } from "next/navigation";

export default async function EpisodeIndex({ params }: { params: Promise<{ project: string; ep: string }> }) {
  const { project, ep } = await params;
  redirect(`/projects/${project}/episodes/${ep}/shots`);
}
