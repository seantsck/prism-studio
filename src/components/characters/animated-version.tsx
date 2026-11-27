import Link from "next/link";
import { ActionForm } from "@/components/action-form";
import { Button, Panel } from "@/components/ui";
import { MAX_ART_STYLE_CHARS } from "@/domain/generation/subject-image";
import type { Character } from "@/domain/schemas";
import { createAnimatedCharacter, setArtStyle } from "@/server/animated-character-actions";

/**
 * On a Character's page: make an animated Character from this one (a real person, from their photos), or, on an
 * animated Character, the style it is drawn in and whose likeness it has.
 */
export function AnimatedVersion({
  slug,
  character,
  likenessFrom,
}: {
  slug: string;
  character: Character;
  /** the real Character an animated one takes its likeness from */
  likenessFrom: { id: string; name: string } | null;
}) {
  const style = (character.artStyle ?? "").trim();
  if (style || likenessFrom)
    return (
      <Panel title="Animated actor" className="xl:col-span-2">
        <div className="space-y-2 text-[12.5px]" data-testid="animated-character">
          <p className="text-muted">
            {style ? (
              <>
                {character.name} is drawn as{" "}
                <span className="text-fg" data-testid="animated-style">
                  {style}
                </span>
              </>
            ) : (
              <>{character.name} is drawn as photographs</>
            )}
            {likenessFrom ? (
              <>
                , with the likeness of{" "}
                <Link
                  href={`/projects/${slug}/characters/${likenessFrom.id}`}
                  className="text-accent hover:underline"
                  data-testid="animated-likeness"
                >
                  {likenessFrom.name}
                </Link>{" "}
                from their photos until {character.name} has pictures of their own
              </>
            ) : null}
            . Changing the style changes new pictures only.
          </p>
          <ActionForm action={setArtStyle} className="flex flex-wrap items-center gap-2">
            <input type="hidden" name="projectSlug" value={slug} />
            <input type="hidden" name="characterId" value={character.id} />
            <input
              name="style"
              defaultValue={style}
              maxLength={MAX_ART_STYLE_CHARS}
              placeholder="anime, 3D animated film, soft watercolour…"
              aria-label="Art style"
              className="min-w-[16rem] flex-1"
              data-testid="animated-style-input"
            />
            <Button type="submit" size="sm" data-testid="animated-style-save">
              Save style
            </Button>
          </ActionForm>
        </div>
      </Panel>
    );
  return (
    <Panel title="Make an animated version" className="xl:col-span-2">
      <div className="space-y-2 text-[12.5px]" data-testid="animated-version">
        <p className="text-muted">
          A new actor drawn in the style you write, from {character.name}&apos;s photos, so it still looks
          like them. {character.name} and their pictures stay as they are. Making it costs nothing; its
          pictures are made on its page, priced first as always. Use photos only of people who agreed to it.
        </p>
        <ActionForm action={createAnimatedCharacter} className="flex flex-wrap items-center gap-2">
          <input type="hidden" name="projectSlug" value={slug} />
          <input type="hidden" name="characterId" value={character.id} />
          <input
            name="style"
            required
            maxLength={MAX_ART_STYLE_CHARS}
            placeholder="anime, 3D animated film, soft watercolour…"
            aria-label="Art style"
            className="min-w-[16rem] flex-1"
            data-testid="animated-version-style"
          />
          <Button type="submit" size="sm" variant="primary" data-testid="animated-version-create">
            Create animated actor
          </Button>
        </ActionForm>
      </div>
    </Panel>
  );
}
