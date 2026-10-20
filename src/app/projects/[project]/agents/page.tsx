import { LocalAgentsPanel } from "@/components/local-agents-panel";
import { PageHeader, Panel } from "@/components/ui";
import { localAgentsEnabled } from "@/server/local-agent";
import { localAgentsState } from "@/server/local-agent-actions";
import { requireProject } from "@/server/repo";

export const dynamic = "force-dynamic";

/** Remote Local Agents paired with this project (Phase 2F M2D.3C1). */
export default async function LocalAgentsPage({ params }: { params: Promise<{ project: string }> }) {
  const { project: slug } = await params;
  await requireProject(slug);
  const enabled = localAgentsEnabled();
  const state = enabled ? await localAgentsState(slug) : null;

  return (
    <div data-testid="local-agents-page">
      <PageHeader
        title="Local agents"
        subtitle="Workstations paired with this project. A ready workstation runs this project's Remote Local Agent reconstructions."
      />
      <div className="space-y-4 p-6">
        {!enabled ? (
          <Panel title="Not enabled">
            <p className="text-[12px] text-muted" data-testid="local-agents-disabled">
              Local agents are not enabled on this Prism server.
            </p>
          </Panel>
        ) : state && !state.ok ? (
          <Panel title="Unavailable">
            <p className="text-[12px] text-fail">{state.error}</p>
          </Panel>
        ) : (
          <LocalAgentsPanel slug={slug} initial={state?.ok ? state.devices : []} />
        )}
      </div>
    </div>
  );
}
