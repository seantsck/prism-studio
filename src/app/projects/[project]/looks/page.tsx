import Link from "next/link";
import { notFound } from "next/navigation";
import { LooksEditor } from "@/components/characters/looks-editor";
import { PageHeader, Panel } from "@/components/ui";
import { requireProject } from "@/server/repo";

/**
 * Every Character's Looks in one place: a Look is an outfit (wardrobe, shoes, jewelry, hair, makeup, accessories) a
 * Character wears in some scenes, with its own pictures. A Shot uses the Look its Character wears there.
 */
export default async function LooksPage({ params }: { params: Promise<{ project: string }> }) {
  const { project: slug } = await params;
  const data = await requireProject(slug);
  if (!data) notFound();
  const total = data.looks.length;
  return (
    <div>
      <PageHeader
        title="Looks"
        subtitle={`${total} Look${total === 1 ? "" : "s"} across ${data.characters.length} actor${data.characters.length === 1 ? "" : "s"}`}
      />
      <div className="space-y-4 p-6">
        <p className="max-w-[80ch] text-[12.5px] text-muted" data-testid="looks-explainer">
          A Look is an outfit an actor wears in some scenes: wardrobe, shoes, jewelry, hair, makeup and
          accessories, with its own pictures. A shot uses the Look its actor wears there, so the clothes match
          from shot to shot. Lock a Look when it is final: a locked Look can&apos;t be edited by accident. An
          actor&apos;s face comes from their reference set, not from a Look.
        </p>
        {data.characters.length === 0 ? <p className="text-[12.5px] text-faint">No actors yet.</p> : null}
        {data.characters.map((c) => {
          const looks = data.looks.filter((l) => l.characterId === c.id);
          return (
            <div key={c.id} id={`looks-${c.id}`} className="scroll-mt-4" data-testid="looks-character">
              <Panel
                title={`${c.name} · ${looks.length} Look${looks.length === 1 ? "" : "s"}`}
                actions={
                  <Link
                    href={`/projects/${slug}/characters/${c.id}`}
                    className="text-[12px] text-accent hover:underline"
                  >
                    Open {c.name}
                  </Link>
                }
              >
                <LooksEditor
                  slug={slug}
                  character={c}
                  looks={looks}
                  episodes={data.episodes}
                  assets={data.assets}
                />
              </Panel>
            </div>
          );
        })}
      </div>
    </div>
  );
}
