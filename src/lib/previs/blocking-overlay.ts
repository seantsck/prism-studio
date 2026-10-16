import * as THREE from "three";
import {
  canonicalizeEntry,
  heightForScale,
  rootYawDeg,
  scaleForHeight,
  yawQuat,
  type ShotBlockingEntry,
} from "@/domain/previs/blocking";
import {
  canonicalizePose,
  clampJointToLimits,
  headDirection,
  matchingPreset,
  presetById,
  withHeadDirection,
  type Pose,
  type PosePresetId,
} from "@/domain/previs/pose";
import { quatsEqual, type Quat } from "@/domain/previs/quat";
import type { PoseJointId } from "@/domain/previs/rig";
import type { Vec3 } from "@/domain/previs/types";
import { beginTransformSession } from "@/vendor/artcraft-scene-engine/actions/transformObject";
import { KinMode } from "@/vendor/artcraft-scene-engine/engine/keybinds_controls";
import type Editor from "@/vendor/artcraft-scene-engine/engine/editor";
import type { UndoableAction } from "@/vendor/artcraft-scene-engine/engine/editor/HistoryManager";
import { clearFKHooks, setFKHooks } from "@/vendor/artcraft-scene-engine/shims/fk-hooks";
import {
  PROXY_USERDATA,
  buildHumanoidRig,
  jointWorldPosition,
  poseJointOfBone,
  type RigHandle,
} from "./humanoid-rig";

/**
 * The Shot blocking overlay: the neutral rigged character proxies of the SELECTED Shot, living in the engine's
 * THREE scene as a runtime layer. They carry no `media_id`, so the engine's scene save never serialises them: the
 * Location's persistent set stays free of any Shot's blocking. Selecting, moving and rotating a proxy uses the
 * engine's own selection + gizmo + history; posing uses the vendored FK helper (rotate gizmo on bones).
 */

export interface BlockingFigureView {
  characterId: string;
  label: string;
  /** the engine uuid of the proxy (matches the engine's selection) */
  objectId: string;
  root: { position: Vec3; orientation: Quat; yawDeg: number; heightM: number; scale: number };
  pose: Pose;
  head: { yawDeg: number; pitchDeg: number };
  visible: boolean;
  selected: boolean;
}

interface Figure {
  characterId: string;
  label: string;
  rig: RigHandle;
  visible: boolean;
}

const act = (label: string, apply: () => void, revert: () => void): UndoableAction => ({
  label,
  apply,
  revert,
});

export class BlockingOverlay {
  private figures = new Map<string, Figure>();
  /** removed by an undoable action: kept (detached) so undo can restore them; released on dispose */
  private retired = new Set<RigHandle>();
  private selectedJoint: PoseJointId | null = null;
  private skeletonVisible = true;
  private dragBefore: { bone: THREE.Object3D; q: THREE.Quaternion } | null = null;
  private disposed = false;

  constructor(
    private readonly editorOf: () => Editor | null,
    private readonly notify: () => void,
  ) {
    setFKHooks({
      onBoneSelected: (bone) => {
        this.selectedJoint = bone ? poseJointOfBone(bone) : null;
        this.notify();
      },
      onBoneDragStart: (bone) => {
        this.dragBefore = { bone, q: bone.quaternion.clone() };
      },
      constrainBone: (bone) => {
        const id = poseJointOfBone(bone);
        if (!id) return;
        const q = bone.quaternion;
        const c = clampJointToLimits(id, { x: q.x, y: q.y, z: q.z, w: q.w });
        if (!quatsEqual(c, { x: q.x, y: q.y, z: q.z, w: q.w }, 1e-5)) bone.quaternion.set(c.x, c.y, c.z, c.w);
      },
      onBoneChange: () => this.notify(),
      onBoneDragEnd: (bone) => {
        const before = this.dragBefore;
        this.dragBefore = null;
        if (!before || before.bone !== bone) return;
        const a = before.q.clone();
        const b = bone.quaternion.clone();
        if (a.angleTo(b) < 1e-5) return;
        this.record(
          act(
            "Rotate joint",
            () => this.setBoneQuat(bone, b),
            () => this.setBoneQuat(bone, a),
          ),
        );
        this.notify();
      },
    });
  }

  // ───────────────────────── helpers ─────────────────────────

  private editor(): Editor {
    const e = this.editorOf();
    if (!e) throw new Error("The 3D set is not mounted.");
    return e;
  }
  private scene(): THREE.Scene {
    return this.editor().activeScene.scene;
  }
  private record(action: UndoableAction) {
    this.editor().history.record(action);
  }
  private setBoneQuat(bone: THREE.Object3D, q: THREE.Quaternion) {
    bone.quaternion.copy(q);
    bone.updateMatrixWorld(true);
    this.notify();
  }
  private figureOf(characterId: string): Figure {
    const f = this.figures.get(characterId);
    if (!f) throw new Error("That character has no proxy in this shot.");
    return f;
  }
  private mouseControls() {
    return this.editor().mouse_controls;
  }

  // ───────────────────────── lifecycle ─────────────────────────

  /** Replaces every figure with these (no history). Used when a Shot loads or the base scene is reloaded. */
  setFigures(entries: Array<{ entry: ShotBlockingEntry; label: string }>) {
    this.exitPoseMode();
    this.deselect();
    for (const f of this.figures.values()) f.rig.dispose();
    for (const r of this.retired) r.dispose();
    this.figures.clear();
    this.retired.clear();
    for (const { entry, label } of entries) this.mount(entry, label);
    this.notify();
  }

  private mount(entry: ShotBlockingEntry, label: string): Figure {
    const e = canonicalizeEntry(entry);
    const rig = buildHumanoidRig({ name: `${label} · Character Proxy` });
    rig.group.userData[PROXY_USERDATA] = { characterId: e.characterId };
    // the engine treats `isCharacter` objects as rigged (it enables its pose controls for them)
    rig.group.userData.isCharacter = true;
    rig.group.userData.locked = false;
    rig.group.position.set(e.root.position.x, e.root.position.y, e.root.position.z);
    rig.group.quaternion.set(
      e.root.orientation.x,
      e.root.orientation.y,
      e.root.orientation.z,
      e.root.orientation.w,
    );
    rig.group.scale.setScalar(e.root.scale);
    rig.group.visible = e.visibility;
    rig.setPose(e.pose);
    this.scene().add(rig.group);
    rig.group.updateMatrixWorld(true);
    const fig: Figure = { characterId: e.characterId, label, rig, visible: e.visibility };
    this.figures.set(e.characterId, fig);
    return fig;
  }

  has(characterId: string) {
    return this.figures.has(characterId);
  }

  /** Re-attaches the figures to the scene after the engine replaced it (loadScene wipes every scene child). */
  reattachAll() {
    const scene = this.scene();
    for (const f of this.figures.values()) if (f.rig.group.parent !== scene) scene.add(f.rig.group);
  }

  add(entry: ShotBlockingEntry, label: string): string {
    if (this.figures.has(entry.characterId))
      throw new Error("That character already has a proxy in this shot.");
    const fig = this.mount(entry, label);
    this.record(
      act(
        "Add character proxy",
        () => {
          this.scene().add(fig.rig.group);
          this.retired.delete(fig.rig);
          this.figures.set(fig.characterId, fig);
          this.notify();
        },
        () => {
          this.exitPoseMode();
          this.deselect();
          fig.rig.group.parent?.remove(fig.rig.group);
          this.figures.delete(fig.characterId);
          this.retired.add(fig.rig);
          this.notify();
        },
      ),
    );
    this.select(fig.characterId);
    return fig.rig.group.uuid;
  }

  remove(characterId: string) {
    const fig = this.figureOf(characterId);
    this.exitPoseMode();
    this.deselect();
    fig.rig.group.parent?.remove(fig.rig.group);
    this.figures.delete(characterId);
    this.retired.add(fig.rig);
    this.record(
      act(
        "Remove character proxy",
        () => {
          this.exitPoseMode();
          this.deselect();
          fig.rig.group.parent?.remove(fig.rig.group);
          this.figures.delete(characterId);
          this.retired.add(fig.rig);
          this.notify();
        },
        () => {
          this.scene().add(fig.rig.group);
          this.retired.delete(fig.rig);
          this.figures.set(characterId, fig);
          this.notify();
        },
      ),
    );
    this.notify();
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    clearFKHooks();
    for (const f of this.figures.values()) f.rig.dispose();
    for (const r of this.retired) r.dispose();
    this.figures.clear();
    this.retired.clear();
  }

  // ───────────────────────── reading ─────────────────────────

  readEntries(): ShotBlockingEntry[] {
    return [...this.figures.values()]
      .map((f) => this.entryOf(f))
      .sort((a, b) => (a.characterId < b.characterId ? -1 : 1));
  }

  private entryOf(f: Figure): ShotBlockingEntry {
    const g = f.rig.group;
    return canonicalizeEntry({
      characterId: f.characterId,
      root: {
        position: { x: g.position.x, y: g.position.y, z: g.position.z },
        orientation: { x: g.quaternion.x, y: g.quaternion.y, z: g.quaternion.z, w: g.quaternion.w },
        scale: g.scale.x,
      },
      pose: f.rig.readPose(),
      visibility: f.visible,
    });
  }

  list(): BlockingFigureView[] {
    const sel = this.selectedCharacter();
    return [...this.figures.values()].map((f) => {
      const e = this.entryOf(f);
      return {
        characterId: f.characterId,
        label: f.label,
        objectId: f.rig.group.uuid,
        root: {
          position: e.root.position,
          orientation: e.root.orientation,
          yawDeg: rootYawDeg(e.root),
          heightM: heightForScale(e.root.scale),
          scale: e.root.scale,
        },
        pose: e.pose,
        head: headDirection(e.pose),
        visible: f.visible,
        selected: sel === f.characterId,
      };
    });
  }

  // ───────────────────────── selection + pose mode ─────────────────────────

  selectedCharacter(): string | null {
    const o = this.editorOf()?.sceneManager?.selected_objects?.[0];
    const c = o?.userData?.[PROXY_USERDATA] as { characterId?: string } | undefined;
    return c?.characterId ?? null;
  }

  select(characterId: string | null) {
    const editor = this.editor();
    if (!characterId) return this.deselect();
    const fig = this.figureOf(characterId);
    if (this.poseMode() && this.selectedCharacter() !== characterId) this.exitPoseMode();
    this.mouseControls()?.selectObject(fig.rig.group);
    editor.selection.refreshOutliner?.();
    this.notify();
  }

  deselect() {
    const mc = this.editorOf()?.mouse_controls;
    if (!mc) return;
    if (this.poseMode()) this.exitPoseMode();
    mc.selected = [];
    const editor = this.editorOf();
    if (editor?.sceneManager) editor.sceneManager.selected_objects = undefined;
    editor?.selection.publishSelect();
    editor?.utils.removeTransformControls(false);
    this.notify();
  }

  poseMode(): boolean {
    return this.editorOf()?.mouse_controls?.kinMode === KinMode.FK;
  }

  enterPoseMode(characterId: string) {
    const mc = this.mouseControls();
    if (!mc) return;
    if (this.poseMode() && this.selectedCharacter() === characterId) return;
    if (this.poseMode()) this.exitPoseMode();
    this.select(characterId);
    mc.toggleFKMode();
    mc.fkHelper.setSkeletonVisible(this.skeletonVisible);
    this.notify();
  }

  exitPoseMode() {
    const mc = this.editorOf()?.mouse_controls;
    if (!mc) return;
    if (mc.kinMode === KinMode.FK) mc.toggleFKMode();
    this.selectedJoint = null;
    this.notify();
  }

  selectedJointId(): PoseJointId | null {
    return this.poseMode() ? this.selectedJoint : null;
  }

  selectJoint(characterId: string, joint: PoseJointId | null) {
    if (!this.poseMode()) this.enterPoseMode(characterId);
    const mc = this.mouseControls();
    if (!mc) return;
    const bone = joint ? this.figureOf(characterId).rig.bones.get(joint) : null;
    mc.fkHelper.selectBone(bone ?? null);
  }

  setSkeletonVisible(visible: boolean) {
    this.skeletonVisible = visible;
    this.editorOf()?.mouse_controls?.fkHelper.setSkeletonVisible(visible);
    this.notify();
  }
  skeletonShown() {
    return this.skeletonVisible;
  }

  // ───────────────────────── edits (each one undoable) ─────────────────────────

  /** Root blocking: where the whole figure stands, which way the body faces, and its height. */
  setRoot(characterId: string, patch: { position?: Partial<Vec3>; yawDeg?: number; heightM?: number }) {
    const fig = this.figureOf(characterId);
    const g = fig.rig.group;
    const session = beginTransformSession(this.editor(), g.uuid);
    if (patch.position) {
      g.position.set(
        patch.position.x ?? g.position.x,
        patch.position.y ?? g.position.y,
        patch.position.z ?? g.position.z,
      );
    }
    if (patch.yawDeg !== undefined) {
      const q = yawQuat(patch.yawDeg);
      g.quaternion.set(q.x, q.y, q.z, q.w);
    }
    if (patch.heightM !== undefined) g.scale.setScalar(scaleForHeight(patch.heightM));
    g.updateMatrixWorld(true);
    session.commit();
    this.notify();
  }

  setVisible(characterId: string, visible: boolean) {
    const fig = this.figureOf(characterId);
    if (fig.visible === visible) return;
    const apply = (v: boolean) => {
      fig.visible = v;
      fig.rig.group.visible = v;
      this.notify();
    };
    apply(visible);
    this.record(
      act(
        visible ? "Show proxy" : "Hide proxy",
        () => apply(visible),
        () => apply(!visible),
      ),
    );
  }

  private poseEdit(label: string, characterId: string, mutate: (fig: Figure) => void) {
    const fig = this.figureOf(characterId);
    const before = this.snapshot(fig);
    mutate(fig);
    fig.rig.group.updateMatrixWorld(true);
    const after = this.snapshot(fig);
    if (JSON.stringify(before) === JSON.stringify(after)) return;
    this.record(
      act(
        label,
        () => this.restore(fig, after),
        () => this.restore(fig, before),
      ),
    );
    this.notify();
  }

  private snapshot(fig: Figure) {
    const e = this.entryOf(fig);
    return { pose: e.pose, y: fig.rig.group.position.y };
  }
  private restore(fig: Figure, s: { pose: Pose; y: number }) {
    fig.rig.setPose(s.pose);
    fig.rig.group.position.y = s.y;
    fig.rig.group.updateMatrixWorld(true);
    this.notify();
  }

  /** Numeric joint edit (the panel); the rotation is clamped to the joint's limits. */
  setJointQuat(characterId: string, joint: PoseJointId, q: Quat) {
    this.poseEdit("Rotate joint", characterId, (fig) => {
      const bone = fig.rig.bones.get(joint);
      if (!bone) return;
      const c = clampJointToLimits(joint, q);
      bone.quaternion.set(c.x, c.y, c.z, c.w);
    });
  }

  setHeadDirection(characterId: string, yawDeg: number, pitchDeg: number) {
    this.poseEdit("Head direction", characterId, (fig) => {
      fig.rig.setPose(withHeadDirection(fig.rig.readPose(), yawDeg, pitchDeg));
    });
  }

  applyPreset(characterId: string, presetId: PosePresetId) {
    this.poseEdit("Apply pose preset", characterId, (fig) => {
      const preset = presetById(presetId);
      const prevOffset = matchingPreset(fig.rig.readPose())?.rootYOffsetM ?? 0;
      const scale = fig.rig.group.scale.x;
      fig.rig.setPose(preset.pose);
      // the only root effect a preset can have: the documented hip-height difference (stand <-> seated)
      fig.rig.group.position.y += (preset.rootYOffsetM - prevOffset) * scale;
    });
  }

  resetPose(characterId: string) {
    this.applyPreset(characterId, "neutral_stand");
  }

  // ───────────────────────── render + test support ─────────────────────────

  /** Runs `fn` with the FK gizmo hidden so a production render never contains an editor helper. */
  async cleanRender<T>(fn: () => Promise<T> | T): Promise<T> {
    const fk = this.editorOf()?.mouse_controls?.fkHelper;
    fk?.setGizmoVisible(false);
    try {
      return await fn();
    } finally {
      fk?.setGizmoVisible(true);
    }
  }

  jointWorld(characterId: string, joint: PoseJointId): Vec3 | null {
    const fig = this.figures.get(characterId);
    if (!fig) return null;
    const v = jointWorldPosition(fig.rig, joint);
    return v ? { x: v.x, y: v.y, z: v.z } : null;
  }

  /** Every proxy object currently in the scene (for leak/duplicate checks). */
  sceneProxyCount(): number {
    let n = 0;
    this.editorOf()?.activeScene.scene.children.forEach((c) => {
      if (c.userData?.[PROXY_USERDATA]) n++;
    });
    return n;
  }

  readPoseOf(characterId: string): Pose {
    return canonicalizePose(this.figureOf(characterId).rig.readPose());
  }
}
