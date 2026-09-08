import { useCallback, useEffect, useState } from "react";
import * as THREE from "three";
import { Box, Button, Divider, TextField, Typography } from "@mui/material";
import { globalObject, globalSelectedObject } from "@/engine";
import { counterScaleChildren } from "@/engine/transform-control-events";
import { eventBus } from "@/resources/services/event-bus";

/**
 * The "Position" tab of the attribute window: the X / Y / Z and the rotation of the
 * selected class or port instance, shown and edited as plain number fields.
 *
 * The three.js mesh is the source of truth — the same value a gizmo drag writes. So a
 * commit here sets `mesh.position[axis]` (or `mesh.quaternion`) and asks for a render;
 * the animator's coordinates-updater pass then copies the new transform onto the gds
 * instance, pushes it to collaborators and marks the scene dirty, exactly as it does for
 * a drag. The `historyRecord` publish mirrors `transform-control-events` (one undo step
 * per commit, flushed after the transform sync).
 *
 * Rotation is stored — on the mesh and on the instance — as a quaternion, but is edited
 * here as Euler XYZ degrees, which is what the rotate gizmo shows and what a modeller can
 * reason about.
 *
 * Scale works the same way, and is worth having here for one reason in particular: this
 * client draws in METRES, so a concept sized for the canvas — a Task icon a couple of
 * units across — dwarfs a real machine standing beside it. Scale is stored on the
 * instance in `custom_variables.scale`, which the same coordinates-updater pass writes
 * from the mesh, so setting `mesh.scale` here is exactly what the scale gizmo does.
 *
 * `coordinates_2d` / `rotation` are passed in only as the fallback display values for the
 * frame before the mesh is reachable (or in a non-engine test render); once the mesh is
 * found its `position` / `quaternion` win.
 */

type Axis = "x" | "y" | "z";
const AXES: Axis[] = ["x", "y", "z"];

type Vector3Like = { x: number; y: number; z: number };
type QuaternionLike = { x: number; y: number; z: number; w: number };
/** A quaternion we can write to: three.js needs `set()` so its change callback fires. */
type WritableQuaternion = QuaternionLike & { set(x: number, y: number, z: number, w: number): unknown };

interface PositionPanelProps {
  /** uuid of the selected class / port instance — also the uuid of its mesh. */
  instanceUuid: string;
  instanceName: string;
  /** The instance's stored `coordinates_2d`, used until the live mesh is resolved. */
  fallbackCoordinates: Vector3Like;
  /** The instance's stored `rotation` quaternion, used until the live mesh is resolved. */
  fallbackRotation?: QuaternionLike;
  /** The instance's stored `custom_variables.scale`, used until the live mesh is resolved. */
  fallbackScale?: Vector3Like;
  /** True while the Position tab is the visible one — re-reads the mesh on each show. */
  active: boolean;
}

/** The selected mesh, but only when it is the one this panel is editing. */
function selectedMeshFor(
  instanceUuid: string,
): { position: Vector3Like; quaternion?: QuaternionLike; scale?: Vector3Like } | null {
  const mesh = globalSelectedObject.getObject() as
    | { uuid?: string; position?: Vector3Like; quaternion?: QuaternionLike; scale?: Vector3Like }
    | undefined;
  if (!mesh || mesh.uuid !== instanceUuid || !mesh.position) return null;
  return mesh as { position: Vector3Like; quaternion?: QuaternionLike; scale?: Vector3Like };
}

export default function PositionPanel({
  instanceUuid,
  instanceName,
  fallbackCoordinates,
  fallbackRotation,
  fallbackScale,
  active,
}: PositionPanelProps) {
  const readPosition = useCallback((): Record<Axis, number> => {
    const mesh = selectedMeshFor(instanceUuid);
    const source = mesh ? mesh.position : fallbackCoordinates;
    return { x: Number(source.x) || 0, y: Number(source.y) || 0, z: Number(source.z) || 0 };
  }, [instanceUuid, fallbackCoordinates]);

  const readRotation = useCallback((): Record<Axis, number> => {
    const mesh = selectedMeshFor(instanceUuid);
    return toDegrees(mesh?.quaternion ?? fallbackRotation);
  }, [instanceUuid, fallbackRotation]);

  const readScale = useCallback((): Record<Axis, number> => {
    const scale = selectedMeshFor(instanceUuid)?.scale ?? fallbackScale;
    // An unset scale is 1, not 0: a mesh nobody has resized still occupies its own size.
    return { x: Number(scale?.x) || 1, y: Number(scale?.y) || 1, z: Number(scale?.z) || 1 };
  }, [instanceUuid, fallbackScale]);

  // One draft string per axis so the field stays controlled while typing; the commit
  // parses it back to a number.
  const [draft, setDraft] = useState<Record<Axis, string>>(() => stringifyAll(readPosition()));
  const [rotationDraft, setRotationDraft] = useState<Record<Axis, string>>(() => stringifyAll(readRotation()));
  const [scaleDraft, setScaleDraft] = useState<Record<Axis, string>>(() => stringifyAll(readScale()));

  // Re-sync from the mesh whenever this becomes the visible tab or the selection changes
  // (a gizmo drag between visits, a different instance behind the same panel).
  useEffect(() => {
    if (active) {
      setDraft(stringifyAll(readPosition()));
      setRotationDraft(stringifyAll(readRotation()));
      setScaleDraft(stringifyAll(readScale()));
    }
  }, [active, readPosition, readRotation, readScale]);

  /** One undo step per commit, flushed after the three.js -> gds transform sync so the
   *  snapshot holds the new transform rather than the old one. */
  function recordHistory(label: "position" | "rotation" | "scale") {
    eventBus.publish("historyRecord", {
      label,
      afterTransformSync: true,
      coalesceKey: `${label}:${instanceUuid}`,
    });
  }

  function commit(axis: Axis, raw: string) {
    const next = Number(raw.trim());
    if (raw.trim() === "" || !Number.isFinite(next)) {
      // Not a number — snap the field back to the current value.
      setDraft((d) => ({ ...d, [axis]: stringifyAxis(readPosition()[axis]) }));
      return;
    }

    const mesh = selectedMeshFor(instanceUuid);
    if (!mesh) {
      setDraft((d) => ({ ...d, [axis]: stringifyAxis(readPosition()[axis]) }));
      return;
    }
    if (mesh.position[axis] === next) return;

    mesh.position[axis] = next;
    setDraft((d) => ({ ...d, [axis]: stringifyAxis(next) }));

    // Keep the red selection box on the moved object, then let the render loop pick up
    // the delta: the animator writes it back onto the gds instance, syncs it to
    // collaborators and flags the scene dirty (see coordinates-updater).
    globalSelectedObject.getObject();
    globalObject.render = true;

    recordHistory("position");
  }

  function commitRotation(axis: Axis, raw: string) {
    const next = Number(raw.trim());
    const snapBack = () => setRotationDraft((d) => ({ ...d, [axis]: stringifyAxis(readRotation()[axis]) }));
    if (raw.trim() === "" || !Number.isFinite(next)) {
      snapBack();
      return;
    }

    const quaternion = selectedMeshFor(instanceUuid)?.quaternion as WritableQuaternion | undefined;
    // `set` is what notifies three.js that the quaternion changed; without it (a plain
    // object stand-in outside the engine) there is nothing to drive.
    if (!quaternion || typeof quaternion.set !== "function") {
      snapBack();
      return;
    }

    // The three Euler angles are not independent, so the other two axes are taken from
    // the mesh as it stands rather than from their (possibly uncommitted) drafts.
    const degrees = { ...readRotation(), [axis]: next };
    const target = new THREE.Quaternion().setFromEuler(
      new THREE.Euler(
        THREE.MathUtils.degToRad(degrees.x),
        THREE.MathUtils.degToRad(degrees.y),
        THREE.MathUtils.degToRad(degrees.z),
        EULER_ORDER,
      ),
    );
    if (quaternion.x === target.x && quaternion.y === target.y && quaternion.z === target.z && quaternion.w === target.w) {
      setRotationDraft((d) => ({ ...d, [axis]: stringifyAxis(next) }));
      return;
    }

    quaternion.set(target.x, target.y, target.z, target.w);
    // Re-read all three: one rotation has many Euler spellings, so an angle outside the
    // canonical range comes back as the equivalent triple the mesh now actually holds.
    setRotationDraft(stringifyAll(readRotation()));

    globalSelectedObject.getObject();
    globalObject.render = true;

    recordHistory("rotation");
  }

  /**
   * Resize the mesh. `axes` is what a uniform edit uses to set all three at once, which
   * is the usual want: a concept is nearly always too big or too small as a whole.
   */
  function commitScale(axes: Axis[], raw: string) {
    const next = Number(raw.trim());
    const snapBack = () => setScaleDraft(stringifyAll(readScale()));
    // Zero or negative collapses or mirrors the geometry, and neither is a resize anyone
    // means; the field snaps back rather than leaving an invisible object behind.
    if (raw.trim() === "" || !Number.isFinite(next) || next <= 0) {
      snapBack();
      return;
    }

    const mesh = globalSelectedObject.getObject();
    const scale = mesh?.uuid === instanceUuid ? mesh.scale : undefined;
    if (!scale) {
      snapBack();
      return;
    }
    if (axes.every((axis) => scale[axis] === next)) return;

    for (const axis of axes) scale[axis] = next;
    setScaleDraft(stringifyAll(readScale()));

    // Keep labels (and any other plain, non-self-scaled child) at a constant absolute
    // size — the same compensation the scale gizmo applies, and what setScale() expects
    // to already be in place when the scene is reloaded. Skipping this looks right while
    // the tab stays open (the label just shrinks with its parent) but balloons back up
    // on reload, once the counter-scale is finally applied against the persisted value.
    counterScaleChildren(mesh);
    globalSelectedObject.getObject();
    globalObject.render = true;

    // The updater copies this onto custom_variables.scale on the next frame, and from
    // there it is saved and broadcast like any other transform.
    recordHistory("scale");
  }

  return (
    <Box>
      <Typography variant="h6" sx={{ mb: 1.5, fontSize: "1rem", fontWeight: 600 }}>
        Position
      </Typography>
      <Typography variant="body2" sx={{ mb: 1.5, color: "text.secondary" }}>
        {instanceName}
      </Typography>

      {AXES.map((axis) => (
        <TextField
          key={axis}
          fullWidth
          size="small"
          type="number"
          label={axis.toUpperCase()}
          value={draft[axis]}
          onChange={(e) => setDraft((d) => ({ ...d, [axis]: e.target.value }))}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              commit(axis, (e.target as HTMLInputElement).value);
            }
          }}
          onBlur={() => commit(axis, draft[axis])}
          sx={{ mb: 1 }}
        />
      ))}

      <Typography variant="h6" sx={{ mt: 2, mb: 1.5, fontSize: "1rem", fontWeight: 600 }}>
        Rotation (degrees)
      </Typography>

      {AXES.map((axis) => (
        <TextField
          key={axis}
          fullWidth
          size="small"
          type="number"
          label={`Rotation ${axis.toUpperCase()}`}
          value={rotationDraft[axis]}
          onChange={(e) => setRotationDraft((d) => ({ ...d, [axis]: e.target.value }))}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              commitRotation(axis, (e.target as HTMLInputElement).value);
            }
          }}
          onBlur={() => commitRotation(axis, rotationDraft[axis])}
          sx={{ mb: 1 }}
        />
      ))}

      <Typography variant="h6" sx={{ mt: 2, mb: 0.5, fontSize: "1rem", fontWeight: 600 }}>
        Scale
      </Typography>
      <Typography variant="body2" sx={{ mb: 1.5, color: "text.secondary" }}>
        1 unit is 1 metre — a concept drawn for the canvas is usually far larger than the
        machine beside it.
      </Typography>

      <TextField
        fullWidth
        size="small"
        type="number"
        label="All axes"
        value={uniformScale(scaleDraft)}
        onChange={(e) => setScaleDraft({ x: e.target.value, y: e.target.value, z: e.target.value })}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            commitScale(AXES, (e.target as HTMLInputElement).value);
          }
        }}
        onBlur={() => commitScale(AXES, uniformScale(scaleDraft))}
        inputProps={{ min: 0, step: 0.1 }}
        sx={{ mb: 1 }}
      />

      {AXES.map((axis) => (
        <TextField
          key={axis}
          fullWidth
          size="small"
          type="number"
          label={`Scale ${axis.toUpperCase()}`}
          value={scaleDraft[axis]}
          onChange={(e) => setScaleDraft((d) => ({ ...d, [axis]: e.target.value }))}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              commitScale([axis], (e.target as HTMLInputElement).value);
            }
          }}
          onBlur={() => commitScale([axis], scaleDraft[axis])}
          inputProps={{ min: 0, step: 0.1 }}
          sx={{ mb: 1 }}
        />
      ))}

      <Button
        variant="outlined"
        size="small"
        onClick={() => {
          setDraft(stringifyAll(readPosition()));
          setRotationDraft(stringifyAll(readRotation()));
          setScaleDraft(stringifyAll(readScale()));
        }}
        sx={{ mt: 0.5 }}
      >
        Refresh from canvas
      </Button>
      <Divider sx={{ borderColor: "silver", mt: 1 }} />
    </Box>
  );
}

/** The order the angles are read back in, and the one the rotate gizmo works in. */
const EULER_ORDER = "XYZ";

/** Euler XYZ degrees of a quaternion, tolerating a missing or unset (all-zero) rotation. */
function toDegrees(rotation: QuaternionLike | undefined): Record<Axis, number> {
  const quaternion = new THREE.Quaternion(
    Number(rotation?.x) || 0,
    Number(rotation?.y) || 0,
    Number(rotation?.z) || 0,
    Number(rotation?.w) || 0,
  );
  // An absent or all-zero rotation is "not set", not a real quaternion — read it as identity.
  if (quaternion.lengthSq() === 0) quaternion.set(0, 0, 0, 1);
  const euler = new THREE.Euler().setFromQuaternion(quaternion.normalize(), EULER_ORDER);
  return {
    x: THREE.MathUtils.radToDeg(euler.x),
    y: THREE.MathUtils.radToDeg(euler.y),
    z: THREE.MathUtils.radToDeg(euler.z),
  };
}

function stringifyAxis(value: number): string {
  // Trim the float noise a drag leaves behind without forcing decimals on round values.
  return String(Math.round(value * 1e6) / 1e6);
}

/** The single value all three axes share, or "" while they differ. */
function uniformScale(scale: Record<Axis, string>): string {
  return scale.x === scale.y && scale.y === scale.z ? scale.x : "";
}

function stringifyAll(values: Record<Axis, number>): Record<Axis, string> {
  return { x: stringifyAxis(values.x), y: stringifyAxis(values.y), z: stringifyAxis(values.z) };
}
