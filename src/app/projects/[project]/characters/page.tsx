import Link from "next/link";
import { Badge, Button, Field, PageHeader, Panel } from "@/components/ui";
import { saveCharacter } from "@/server/actions";
import { requireProject } from "@/server/repo";

export default async function CharactersPage({ params }: { params: Promise<{ project: string }> }) {
  const { project: slug } = await params;
  const data = await requireProject(slug);

  return (
    <div>
      <PageHeader
        title="Characters"
        subtitle="Identity, Looks and voices. Shots reference these by id — never by repeated text."
      />
      <div className="grid gap-6 p-6 lg:grid-cols-[1fr_320px]">
        <div className="space-y-2">
          {data.characters.map((c) => {
            const looks = data.looks.filter((l) => l.characterId === c.id);
            const voices = data.voiceProfiles.filter((v) => v.characterId === c.id);
            const refs = data.identityRefs.filter((r) => r.characterId === c.id && r.assetId);
            return (
              <Link
                key={c.id}
                href={`/projects/${slug}/characters/${c.id}`}
                className="block border border-line bg-panel px-4 py-3 hover:border-line2 hover:bg-panel2"
              >
                <div className="flex items-center justify-between">
                  <div className="text-[14px] font-medium">{c.name}</div>
                  <div className="flex gap-1.5">
                    <Badge tone={refs.length >= 4 ? "pass" : "warn"}>{refs.length} identity refs</Badge>
                    <Badge tone={looks.some((l) => l.locked) ? "pass" : "warn"}>{looks.length} looks</Badge>
                    <Badge>{voices.length} voices</Badge>
                  </div>
                </div>
                <div className="text-muted">{c.role}</div>
                <p className="mt-1 line-clamp-2 text-muted">{c.description}</p>
              </Link>
            );
          })}
        </div>
        <Panel title="New character">
          <form action={saveCharacter} className="space-y-3">
            <input type="hidden" name="projectSlug" value={slug} />
            <Field label="Name">
              <input name="name" required />
            </Field>
            <Field label="Role">
              <input name="role" />
            </Field>
            <Field label="Description">
              <textarea name="description" rows={3} />
            </Field>
            <Button type="submit" variant="primary">
              Create
            </Button>
          </form>
        </Panel>
      </div>
    </div>
  );
}
