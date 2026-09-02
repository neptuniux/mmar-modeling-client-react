import { useCallback, useEffect, useState } from "react";
import { Box, Button, Divider, TextField, Typography } from "@mui/material";
import { globalObject, globalSelectedObject } from "@/engine";
import { eventBus } from "@/resources/services/event-bus";

/**
 * The "Position" tab of the attribute window: the X / Y / Z of the selected class or
 * port instance, shown and edited as plain number fields.
 *
 * The three.js mesh is the source of truth — the same value a gizmo drag writes. So a
 * commit here sets `mesh.position[axis]` and asks for a render; the animator's
 * coordinates-updater pass then copies the new position onto the gds instance, pushes
 * it to collaborators and marks the scene dirty, exactly as it does for a drag. The
 * `historyRecord` publish mirrors `transform-control-events` (one undo step per commit,
 * flushed after the transform sync).
 *
 * `coordinates_2d` is passed in only as the fallback display value for the frame before
 * the mesh is reachable (or in a non-engine test render); once the mesh is found its
 * `position` wins.
 */

type Axis = "x" | "y" | "z";
const AXES: Axis[] = ["x", "y", "z"];

interface PositionPanelProps {
  /** uuid of the selected class / port instance — also the uuid of its mesh. */
  instanceUuid: string;
  instanceName: string;
  /** The instance's stored `coordinates_2d`, used until the live mesh is resolved. */
  fallbackCoordinates: { x: number; y: number; z: number };
  /** True while the Position tab is the visible one — re-reads the mesh on each show. */
  active: boolean;
}

/** The selected mesh, but only when it is the one this panel is editing. */
function selectedMeshFor(instanceUuid: string): { position: { x: number; y: number; z: number } } | null {
  const mesh = globalSelectedObject.getObject() as
    | { uuid?: string; position?: { x: number; y: number; z: number } }
    | undefined;
  if (!mesh || mesh.uuid !== instanceUuid || !mesh.position) return null;
  return mesh as { position: { x: number; y: number; z: number } };
}

export default function PositionPanel({
  instanceUuid,
  instanceName,
  fallbackCoordinates,
  active,
}: PositionPanelProps) {
  const readPosition = useCallback((): Record<Axis, number> => {
    const mesh = selectedMeshFor(instanceUuid);
    const source = mesh ? mesh.position : fallbackCoordinates;
    return { x: Number(source.x) || 0, y: Number(source.y) || 0, z: Number(source.z) || 0 };
  }, [instanceUuid, fallbackCoordinates]);

  // One draft string per axis so the field stays controlled while typing; the commit
  // parses it back to a number.
  const [draft, setDraft] = useState<Record<Axis, string>>(() => stringifyAll(readPosition()));

  // Re-sync from the mesh whenever this becomes the visible tab or the selection changes
  // (a gizmo drag between visits, a different instance behind the same panel).
  useEffect(() => {
    if (active) setDraft(stringifyAll(readPosition()));
  }, [active, readPosition]);

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

    // One undo step per commit, flushed after the three.js -> gds transform sync so the
    // snapshot holds the new position rather than the old one.
    eventBus.publish("historyRecord", {
      label: "position",
      afterTransformSync: true,
      coalesceKey: `position:${instanceUuid}`,
    });
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

      <Button variant="outlined" size="small" onClick={() => setDraft(stringifyAll(readPosition()))} sx={{ mt: 0.5 }}>
        Refresh from canvas
      </Button>
      <Divider sx={{ borderColor: "silver", mt: 1 }} />
    </Box>
  );
}

function stringifyAxis(value: number): string {
  // Trim the float noise a drag leaves behind without forcing decimals on round values.
  return String(Math.round(value * 1e6) / 1e6);
}

function stringifyAll(position: Record<Axis, number>): Record<Axis, string> {
  return { x: stringifyAxis(position.x), y: stringifyAxis(position.y), z: stringifyAxis(position.z) };
}
