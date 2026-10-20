"use client";

import { useCallback, useEffect, useState } from "react";
import { Badge, Button, Empty, Panel } from "@/components/ui";
import {
  cancelLocalAgentPairing,
  createLocalAgentPairing,
  localAgentPairingState,
  localAgentsState,
  renameLocalAgent,
  revokeLocalAgent,
  type AgentDeviceView,
  type PairingOfferView,
} from "@/server/local-agent-actions";

/**
 * Remote Local Agents of one project (Phase 2F M2D.3C1): pair a workstation, see which devices are online and what
 * their local toolchain reports, rename or revoke them. The pairing code lives only in this component's memory: it is
 * shown once, and removed from the page as soon as it is used, expires or is cancelled.
 *
 * Paired agents do not run anything yet: remote execution arrives in M2D.3C2, and Local Capture keeps using the
 * same-host worker until then.
 */

const TOOLCHAIN_LABEL: Record<string, string> = {
  ready: "Toolchain ready",
  colmap_missing: "COLMAP missing",
  colmap_unverified: "COLMAP unverified",
  colmap_incompatible: "COLMAP incompatible",
  brush_missing: "Brush missing",
  brush_incompatible: "Brush incompatible",
  gpu_unavailable: "GPU unavailable",
};

const ago = (iso: string | null, now: number) => {
  if (!iso) return "never";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "unknown";
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  return new Date(iso).toLocaleString();
};
const shortFingerprint = (f: string) => f.slice(0, 16).match(/.{4}/g)!.join(" ");
const mmss = (ms: number) => {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

type Offer = PairingOfferView & { state: "pending" };
type OfferOutcome = { state: "paired"; label: string } | { state: "expired" } | { state: "cancelled" };

export function LocalAgentsPanel({ slug, initial }: { slug: string; initial: AgentDeviceView[] }) {
  const [devices, setDevices] = useState(initial);
  const [offer, setOffer] = useState<Offer | null>(null);
  const [outcome, setOutcome] = useState<OfferOutcome | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  const refresh = useCallback(async () => {
    const r = await localAgentsState(slug);
    if (r.ok) setDevices(r.devices);
  }, [slug]);

  // device list: modest polling (online/offline is derived on the server from the last signed heartbeat)
  useEffect(() => {
    const t = setInterval(() => void refresh(), 5000);
    return () => clearInterval(t);
  }, [refresh]);

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  // the pending offer: watch for its redemption; drop the code the moment it is no longer usable
  useEffect(() => {
    if (!offer) return;
    const expiresAt = Date.parse(offer.expiresAt);
    const t = setInterval(async () => {
      const r = await localAgentPairingState(slug, offer.pairingId);
      if (!r.ok) return;
      if (r.state === "paired") {
        setOffer(null);
        setOutcome({ state: "paired", label: r.device?.label ?? "device" });
        void refresh();
      } else if (r.state === "expired" || Date.now() >= expiresAt) {
        setOffer(null);
        setOutcome({ state: "expired" });
      } else if (r.state === "cancelled") {
        setOffer(null);
        setOutcome({ state: "cancelled" });
      }
    }, 2000);
    return () => clearInterval(t);
  }, [offer, slug, refresh]);

  // a code past its expiry is hidden at once, even before the next status check
  const liveOffer = offer && now < Date.parse(offer.expiresAt) ? offer : null;
  const shownOutcome: OfferOutcome | null = outcome ?? (offer && !liveOffer ? { state: "expired" } : null);

  async function pair() {
    setBusy(true);
    setError(null);
    setOutcome(null);
    const r = await createLocalAgentPairing(slug);
    setBusy(false);
    if (!r.ok) return setError(r.error);
    setOffer({ ...r.pairing, state: "pending" });
  }

  async function cancel() {
    if (!offer) return;
    await cancelLocalAgentPairing(slug, offer.pairingId);
    setOffer(null);
    setOutcome({ state: "cancelled" });
  }

  const replace = (d: AgentDeviceView) => setDevices((all) => all.map((x) => (x.id === d.id ? d : x)));
  const anyOnline = devices.some((d) => d.online);

  return (
    <div className="space-y-4" data-testid="local-agents-panel">
      <Panel
        title="Pair a workstation"
        actions={
          <Button variant="primary" size="sm" onClick={pair} disabled={busy} data-testid="pair-local-agent">
            Pair Local Agent
          </Button>
        }
      >
        <p className="text-[12px] text-muted">
          A Local Agent is a small program on your own computer. It connects out to this Prism server over
          HTTPS and identifies itself with a key that never leaves that computer. It never receives a
          database, storage or provider credential, and it is bound to this project only.
        </p>
        {error ? (
          <p className="mt-2 text-[12px] text-fail" role="alert">
            {error}
          </p>
        ) : null}
        {liveOffer ? (
          <div className="mt-3 space-y-2 border border-line2 p-3" data-testid="pairing-offer">
            <div className="text-[11px] text-muted">
              One-time pairing code. It is shown only now, expires in{" "}
              <span data-testid="pairing-countdown">{mmss(Date.parse(liveOffer.expiresAt) - now)}</span>, and
              works once.
            </div>
            <div className="font-mono text-[15px] tracking-wider" data-testid="pairing-code">
              {liveOffer.code}
            </div>
            <div className="text-[11px] text-muted">On the workstation, in a Prism Studio checkout:</div>
            <pre
              className="overflow-x-auto bg-panel2 p-2 font-mono text-[11px]"
              data-testid="pairing-command"
            >
              {liveOffer.command}
            </pre>
            <Button size="sm" variant="ghost" onClick={cancel} data-testid="cancel-pairing">
              Cancel code
            </Button>
          </div>
        ) : null}
        {shownOutcome ? (
          <p className="mt-2 text-[12px]" data-testid="pairing-outcome" data-state={shownOutcome.state}>
            {shownOutcome.state === "paired"
              ? `Paired: ${shownOutcome.label}. The pairing code has been used and is no longer valid.`
              : shownOutcome.state === "expired"
                ? "The pairing code expired without being used. Create a new one when the workstation is ready."
                : "The pairing code was cancelled."}
          </p>
        ) : null}
      </Panel>

      <Panel title="Paired devices">
        {anyOnline ? (
          <p className="mb-2 text-[12px] text-muted" data-testid="remote-execution-note">
            Remote agent online. A ready workstation runs this project&apos;s Remote Local Agent
            reconstruction jobs; Local Capture still runs only on this server&apos;s same-host worker.
          </p>
        ) : null}
        {devices.length === 0 ? (
          <Empty>No local agents are paired with this project.</Empty>
        ) : (
          <ul className="divide-y divide-line" data-testid="local-agent-list">
            {devices.map((d) => (
              <DeviceRow key={d.id} slug={slug} device={d} now={now} onChange={replace} />
            ))}
          </ul>
        )}
      </Panel>
    </div>
  );
}

function DeviceRow({
  slug,
  device: d,
  now,
  onChange,
}: {
  slug: string;
  device: AgentDeviceView;
  now: number;
  onChange: (d: AgentDeviceView) => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const [editing, setEditing] = useState(false);
  const [label, setLabel] = useState(d.label);
  const [error, setError] = useState<string | null>(null);

  async function revoke() {
    const r = await revokeLocalAgent(slug, d.id);
    setConfirming(false);
    if (!r.ok) return setError(r.error);
    onChange(r.device);
  }
  async function rename() {
    const r = await renameLocalAgent(slug, d.id, label);
    if (!r.ok) return setError(r.error);
    setEditing(false);
    setError(null);
    onChange(r.device);
  }

  const state = d.status === "revoked" ? "revoked" : d.online ? "online" : "offline";
  return (
    <li className="py-3" data-testid="local-agent" data-device-id={d.id} data-state={state}>
      <div className="flex flex-wrap items-center gap-2">
        {editing ? (
          <>
            <input
              className="h-6 rounded-[3px] border border-line2 bg-panel2 px-2 text-[12px]"
              value={label}
              maxLength={64}
              onChange={(e) => setLabel(e.target.value)}
              aria-label="Device name"
            />
            <Button size="sm" onClick={rename}>
              Save
            </Button>
            <Button size="sm" variant="ghost" onClick={() => (setEditing(false), setLabel(d.label))}>
              Cancel
            </Button>
          </>
        ) : (
          <span className="text-[13px] font-medium" data-testid="local-agent-label">
            {d.label}
          </span>
        )}
        <Badge
          tone={state === "online" ? "pass" : state === "revoked" ? "fail" : "neutral"}
          className="local-agent-state"
        >
          <span data-testid="local-agent-state">{state}</span>
        </Badge>
        {d.toolchain ? (
          <Badge tone={d.toolchain.state === "ready" ? "pass" : "warn"}>
            <span data-testid="local-agent-toolchain">
              {TOOLCHAIN_LABEL[d.toolchain.state] ?? d.toolchain.state}
            </span>
          </Badge>
        ) : (
          <Badge>
            <span data-testid="local-agent-toolchain">No report yet</span>
          </Badge>
        )}
        <span className="ml-auto flex gap-1">
          {d.status === "active" && !editing ? (
            <Button size="sm" variant="ghost" onClick={() => setEditing(true)}>
              Rename
            </Button>
          ) : null}
          {d.status === "active" ? (
            confirming ? (
              <>
                <Button size="sm" variant="danger" onClick={revoke} data-testid="confirm-revoke">
                  Revoke permanently
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setConfirming(false)}>
                  Keep
                </Button>
              </>
            ) : (
              <Button
                size="sm"
                variant="danger"
                onClick={() => setConfirming(true)}
                data-testid="revoke-agent"
              >
                Revoke Agent
              </Button>
            )
          ) : null}
        </span>
      </div>
      <div className="mt-1 grid grid-cols-2 gap-x-6 gap-y-0.5 text-[11.5px] text-muted md:grid-cols-4">
        <span>
          Last seen: <span data-testid="local-agent-last-seen">{ago(d.lastSeenAt, now)}</span>
        </span>
        <span>
          {d.platform} · {d.arch}
        </span>
        <span>{d.agentVersion}</span>
        <span>
          Key <span className="font-mono">{shortFingerprint(d.fingerprint)}</span>
        </span>
        {d.toolchain ? (
          <span className="col-span-2">
            COLMAP {d.toolchain.colmapVersion ?? "—"} ({d.toolchain.colmapProvenance}) · Brush{" "}
            {d.toolchain.brushVersion ?? "—"} · Vulkan loader{" "}
            {d.toolchain.vulkanLoader === null ? "unknown" : d.toolchain.vulkanLoader ? "present" : "missing"}
          </span>
        ) : null}
        <span>Paired {new Date(d.pairedAt).toLocaleDateString()}</span>
        {d.revokedAt ? <span>Revoked {new Date(d.revokedAt).toLocaleString()}</span> : null}
      </div>
      {d.status === "revoked" ? (
        <p className="mt-1 text-[11.5px] text-muted">
          Revoked devices are kept as history and can never be reactivated. Pair again to create a new device.
        </p>
      ) : null}
      {error ? <p className="mt-1 text-[11.5px] text-fail">{error}</p> : null}
      <details className="mt-1 text-[11px] text-faint">
        <summary className="cursor-pointer">Diagnostics</summary>
        <div className="mt-1 space-y-0.5 font-mono break-all">
          <div>device {d.id}</div>
          <div>protocol v{d.protocolVersion}</div>
          <div>key sha256 {d.fingerprint}</div>
          <div>public key (Ed25519 SPKI) {d.publicKey}</div>
        </div>
      </details>
    </li>
  );
}
