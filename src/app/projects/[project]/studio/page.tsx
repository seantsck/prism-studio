import { showsOwnerCost } from "@/domain/pricing/user-price";
import Link from "next/link";
import { CastBar } from "@/components/studio/cast-bar";
import { ReferenceStudio } from "@/components/studio/reference-studio";
import { Empty, PageHeader } from "@/components/ui";
import { usd } from "@/domain/generation/reference-studio";
import { LOCATION_VIEW_KINDS, LOCATION_VIEW_KIND_LABEL } from "@/domain/location-view";
import { singleUploadLimit } from "@/lib/upload-policy";
import { referenceStudioState } from "@/server/reference-studio";
import { requireProject } from "@/server/repo";

/**
 * The Reference Studio: one screen that turns a reference photograph into the consistent references a film needs
 * (front, three-quarter, both profiles, half and full body, wardrobe), and lets the creator change an image (hair,
 * clothing, lighting, background), compare the takes, and promote the one they choose to the Visual Bible. It is the
 * front door to the existing Character / Location image pipeline, not a second one.
 */
export default async function Page({
  params,
  searchParams,
}: {
  params: Promise<{ project: string }>;
  searchParams: Promise<{ subject?: string; make?: string; look?: string; from?: string; change?: string }>;
}) {
  const { project: slug } = await params;
  const sp = await searchParams;
  const data = await requireProject(slug);
  const base = `/projects/${slug}/studio`;
  // with no choice in the address, the first Character (else the first Location) is the natural place to start
  const first = data.characters[0]
    ? `character:${data.characters[0].id}`
    : data.locations[0]
      ? `location:${data.locations[0].id}`
      : undefined;
  const state = await referenceStudioState(data, sp.subject ?? first);
  const subject = state.selected;
  return (
    <div>
      <PageHeader
        title="Reference Studio"
        subtitle="Turn a reference photo into the consistent set of references a film needs."
        actions={
          subject ? (
            <span className="text-[11.5px] text-muted" data-testid="studio-spent">
              {state.spent.charged === 0
                ? `Nothing charged for ${subject.name} yet`
                : `$${state.spent.charged.toFixed(2)} charged for ${subject.name}${
                    showsOwnerCost()
                      ? ` (provider billed ${usd(state.spent.usd)} for ${state.spent.images} image${state.spent.images === 1 ? "" : "s"})`
                      : ""
                  }`}
            </span>
          ) : undefined
        }
      />
      <CastBar base={base} subjects={state.subjects} selected={subject} />
      {subject ? (
        <ReferenceStudio
          // a different subject is a different workspace: its brief starts fresh
          key={`${subject.kind}:${subject.id}`}
          slug={slug}
          state={state}
          initial={{ make: sp.make, look: sp.look, from: sp.from, change: sp.change }}
          locationViewKinds={LOCATION_VIEW_KINDS.map((k) => ({ id: k, label: LOCATION_VIEW_KIND_LABEL[k] }))}
          // what ONE upload can carry on this deployment (a host limit where it is small): a larger photo is added
          // as a smaller copy made in the browser, and said to be one
          maxUploadBytes={singleUploadLimit(process.env)}
        />
      ) : (
        <div className="p-6">
          <Empty>
            This project has no Actor or Location yet.{" "}
            <Link href={`/projects/${slug}/characters`} className="text-accent hover:underline">
              Add an Actor
            </Link>{" "}
            to start making references.
          </Empty>
        </div>
      )}
    </div>
  );
}
