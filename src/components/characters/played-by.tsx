import Link from "next/link";
import { ActionForm } from "@/components/action-form";
import { Button, Panel } from "@/components/ui";
import { linkActor, makeActorFrom, unlinkActor } from "@/server/actor-actions";

export interface ActorOption {
  id: string;
  name: string;
  href: string;
}

/**
 * On a Character's page (a role in a story): the Actor that plays it. Linking copies the Actor's reference pictures in
 * as the Character's references (its face); "Make an actor from …" turns this Character's pictures into a new Actor.
 */
export function PlayedBy({
  slug,
  characterId,
  name,
  actor,
  actors,
}: {
  slug: string;
  characterId: string;
  name: string;
  /** the Actor playing it (null: none) */
  actor: ActorOption | null;
  /** the Actors of the library */
  actors: ActorOption[];
}) {
  const hidden = (
    <>
      <input type="hidden" name="projectSlug" value={slug} />
      <input type="hidden" name="characterId" value={characterId} />
    </>
  );
  const others = actors.filter((a) => a.id !== actor?.id);
  return (
    <Panel title="Played by" className="xl:col-span-2">
      <div className="space-y-2 text-[12.5px]" data-testid="played-by" data-actor={actor?.id ?? ""}>
        {actor ? (
          <>
            <p>
              <Link
                href={actor.href}
                className="font-medium text-accent hover:underline"
                data-testid="played-by-actor"
              >
                {actor.name}
              </Link>{" "}
              <span className="text-muted">
                plays {name}: their photos and views are {name}&apos;s references, so every new picture of{" "}
                {name} has their face.
              </span>
            </p>
            <div className="flex flex-wrap gap-2">
              <ActionForm action={linkActor}>
                {hidden}
                <input type="hidden" name="actorId" value={actor.id} />
                <Button type="submit" size="sm" data-testid="played-by-refresh">
                  Bring in {actor.name}&apos;s new pictures
                </Button>
              </ActionForm>
              <ActionForm
                action={unlinkActor}
                confirmMessage={`${actor.name} no longer plays ${name}? Its pictures stay.`}
              >
                {hidden}
                <Button type="submit" size="sm" variant="ghost" data-testid="played-by-unlink">
                  Unlink
                </Button>
              </ActionForm>
            </div>
          </>
        ) : (
          <p className="text-muted">
            An actor is who someone is and how they look: photos and views, kept in your library. Choose who
            plays {name}; their pictures become {name}&apos;s references.
          </p>
        )}
        {others.length ? (
          <ActionForm action={linkActor} className="flex flex-wrap items-center gap-2">
            {hidden}
            <select
              name="actorId"
              aria-label="Actor"
              data-testid="played-by-select"
              defaultValue={others[0]!.id}
            >
              {others.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
            <Button
              type="submit"
              size="sm"
              variant={actor ? "ghost" : "primary"}
              data-testid="played-by-link"
            >
              {actor ? "Played by this actor instead" : "Played by this actor"}
            </Button>
          </ActionForm>
        ) : null}
        {actor ? null : (
          <ActionForm action={makeActorFrom} className="pt-1">
            {hidden}
            <Button type="submit" size="sm" data-testid="played-by-make">
              Make an actor from {name}
            </Button>
            <span className="ml-2 text-[11.5px] text-faint">
              Copies {name}&apos;s photos and views into a new actor in your library; {name} keeps everything.
            </span>
          </ActionForm>
        )}
      </div>
    </Panel>
  );
}
