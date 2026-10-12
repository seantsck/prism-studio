"use client";

import {
  DndContext,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import { SortableContext, arrayMove, rectSortingStrategy, useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Children, useState, useTransition, type ReactNode } from "react";
import { reorderShots } from "@/server/actions";

interface Item {
  id: string;
  locked: boolean;
}

function SortableItem({ id, locked, children }: { id: string; locked: boolean; children: ReactNode }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id,
    disabled: locked,
  });
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.6 : 1 }}
      className="relative"
    >
      <button
        type="button"
        aria-label={locked ? "Locked shot — cannot reorder" : "Drag to reorder"}
        title={locked ? "Locked shots keep their position" : "Drag to reorder"}
        disabled={locked}
        className="absolute right-1.5 top-1.5 z-10 cursor-grab rounded-[2px] border border-line2 bg-bg/80 px-1 text-[11px] leading-4 text-muted disabled:cursor-not-allowed disabled:opacity-40"
        {...attributes}
        {...listeners}
      >
        {locked ? "🔒" : "⠿"}
      </button>
      {children}
    </div>
  );
}

/**
 * Drag-to-reorder grid for the shots of one scene. Children are server-rendered cards in the same
 * order as `items`. The server action enforces ordering rules (same scene, locked shots pinned).
 */
export function SortableBoard({
  items,
  children,
  sceneId,
  projectSlug,
}: {
  items: Item[];
  children: ReactNode;
  sceneId: string;
  projectSlug: string;
}) {
  const nodes = Children.toArray(children);
  const byId = new Map(items.map((it, i) => [it.id, { item: it, node: nodes[i] }]));
  const [order, setOrder] = useState(items.map((i) => i.id));
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));

  const onDragEnd = (e: DragEndEvent) => {
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    // Locked shots are pinned; dropping onto one is a no-op.
    if (byId.get(String(over.id))?.item.locked) return;
    const from = order.indexOf(String(active.id));
    const to = order.indexOf(String(over.id));
    const next = arrayMove(order, from, to);
    const previous = order;
    setOrder(next);
    setError(null);
    start(async () => {
      try {
        const result = await reorderShots(sceneId, next, projectSlug);
        if (!result.ok) {
          setOrder(previous);
          setError(result.error);
        }
      } catch {
        setOrder(previous);
        setError("The new order could not be saved. Check your connection and try again.");
      }
    });
  };

  return (
    <div>
      {error ? (
        <div role="alert" className="mb-2 text-fail">
          {error}
        </div>
      ) : null}
      {pending ? <div className="mb-2 text-[11px] text-muted">Saving order…</div> : null}
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
        <SortableContext items={order} strategy={rectSortingStrategy}>
          <div
            className="grid gap-3 transition-opacity"
            style={{
              gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))",
              opacity: pending ? 0.7 : 1,
            }}
          >
            {order.map((id) => {
              const entry = byId.get(id);
              if (!entry) return null;
              return (
                <SortableItem key={id} id={id} locked={entry.item.locked}>
                  {entry.node}
                </SortableItem>
              );
            })}
          </div>
        </SortableContext>
      </DndContext>
    </div>
  );
}
