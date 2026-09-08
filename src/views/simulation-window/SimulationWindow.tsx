import { useCallback, useEffect, useRef, useState } from "react";
import {
  Box,
  Button,
  Chip,
  FormControl,
  InputLabel,
  MenuItem,
  Select,
  type SelectChangeEvent,
  Slider,
  Stack,
  Typography,
} from "@mui/material";
import { eventBus } from "@/resources/services/event-bus";
import { instanceUtility } from "@/resources/services/instance-utility";
import { logger } from "@/resources/services/logger";
import { describeError } from "@/resources/util/describe-error";
import {
  applyJointValue,
  buildSimulationState,
  type JointControl,
} from "@/views/simulation-window/simulationModel";
import {
  capturePose,
  positionSignature,
  previewTaskReach,
  restorePose,
  type PoseSnapshot,
  type ReachResult,
  type ReachTask,
} from "@/engine/hybrid-algorithms/task-reach";

/**
 * The simulation-mode panel: one slider per Joint instance of an open Robotic system
 * scene. Dragging a slider re-poses the cached URDF robot and pushes the recomputed
 * world poses back into the gds instances and the live three.js objects.
 *
 * The slider list is rebuilt on mount (RightNav mounts this only in simulation mode),
 * on `tabChanged`, and on a `sceneInstanceMutated` naming the ACTIVE scene — adding or
 * deleting instances changes which joints exist. The triggers are coalesced through a
 * 100 ms timer so a cascade of mutations rebuilds the list once.
 *
 * REACH CHECK (a BPMN scene). Picking a Task poses the Pool's robot as if it were
 * reaching that Task where it sits, and says whether it got there. Dragging the Task
 * around the canvas re-asks the question continuously, which is what turns the model
 * into a workspace study: move the step until the arm can do it.
 *
 * The drag is WATCHED rather than subscribed to. Moving an object writes its new
 * position onto the instance from the animator's own loop, and there is no channel that
 * announces it; a 120 ms poll of the selected Task's coordinates is enough to follow a
 * drag and costs nothing when nothing is selected.
 */
export default function SimulationWindow() {
  const [loading, setLoading] = useState(false);
  const [isRoboticSystemSceneType, setIsRoboticSystemSceneType] = useState(false);
  const [jointControls, setJointControls] = useState<JointControl[]>([]);
  const [reachTasks, setReachTasks] = useState<ReachTask[]>([]);
  const [selectedTaskUuid, setSelectedTaskUuid] = useState("");
  const [reach, setReach] = useState<ReachResult | null>(null);

  // The pose to put back when the preview is cleared, and the Task position the arm was
  // last solved for — the poll re-solves only when that changes.
  const poseBeforePreviewRef = useRef<PoseSnapshot | null>(null);
  const lastSolvedRef = useRef("");

  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Guards against a slow refresh landing after a newer one, and against a setState
  // after unmount.
  const runIdRef = useRef(0);
  const mountedRef = useRef(true);

  const refresh = useCallback(async () => {
    const runId = ++runIdRef.current;
    setLoading(true);
    try {
      const state = await buildSimulationState();
      if (!mountedRef.current || runId !== runIdRef.current) return;
      setIsRoboticSystemSceneType(state.isRoboticSystemSceneType);
      setJointControls(state.jointControls);
      setReachTasks(state.reachTasks);
      // A Task that is no longer offered cannot stay selected — its Pool may have
      // stopped showing its robot, or the Task may be gone.
      setSelectedTaskUuid((current) =>
        state.reachTasks.some((task) => task.instance.uuid === current) ? current : "",
      );
    } finally {
      if (mountedRef.current && runId === runIdRef.current) setLoading(false);
    }
  }, []);

  /** Coalesces multiple refresh requests into a single refresh call. */
  const requestRefresh = useCallback(() => {
    if (refreshTimerRef.current) return;
    refreshTimerRef.current = setTimeout(() => {
      refreshTimerRef.current = null;
      void refresh().catch((err) =>
        logger.log(`Simulation window refresh failed: ${describeError(err)}`, "error"),
      );
    }, 100);
  }, [refresh]);

  useEffect(() => {
    mountedRef.current = true;

    // Keep the simulation panel in sync with active tab changes.
    const tabChangedSub = eventBus.subscribe("tabChanged", () => requestRefresh());

    // Recompute the joint list when instances are added/removed from the active SceneInstance.
    const sceneInstanceMutatedSub = eventBus.subscribe("sceneInstanceMutated", (payload) => {
      void (async () => {
        const sceneInstance = await instanceUtility.getTabContextSceneInstance();
        const activeSceneInstanceUuid = sceneInstance?.uuid;
        if (!activeSceneInstanceUuid) return;

        // Only refresh if the mutation applies to the currently active SceneInstance.
        if (payload?.sceneInstanceUuid === activeSceneInstanceUuid) {
          requestRefresh();
        }
      })().catch((err) => logger.log(describeError(err), "error"));
    });

    requestRefresh();

    return () => {
      mountedRef.current = false;
      tabChangedSub.dispose();
      sceneInstanceMutatedSub.dispose();
      if (refreshTimerRef.current) {
        clearTimeout(refreshTimerRef.current);
        refreshTimerRef.current = null;
      }
    };
  }, [requestRefresh]);

  const selectedTask = reachTasks.find((task) => task.instance.uuid === selectedTaskUuid);

  /** Solve the arm to where the Task sits now, and show the verdict. */
  const solveForSelected = useCallback(async (task: ReachTask) => {
    lastSolvedRef.current = positionSignature(task);
    const result = await previewTaskReach(task);
    if (mountedRef.current) setReach(result);
  }, []);

  // Follow the Task while it is dragged. Nothing announces an object move, so the
  // selected Task's own coordinates are watched instead; an unchanged position costs a
  // string compare.
  useEffect(() => {
    if (!selectedTask) return;

    poseBeforePreviewRef.current = capturePose(selectedTask);
    void solveForSelected(selectedTask).catch((err) =>
      logger.log(`Reach check failed: ${describeError(err)}`, "error"),
    );

    const watch = setInterval(() => {
      if (positionSignature(selectedTask) === lastSolvedRef.current) return;
      void solveForSelected(selectedTask).catch((err) =>
        logger.log(`Reach check failed: ${describeError(err)}`, "error"),
      );
    }, 120);

    return () => clearInterval(watch);
  }, [selectedTask, solveForSelected]);

  /** Drop the preview and put the robot back where it was. */
  function clearSelection() {
    const snapshot = poseBeforePreviewRef.current;
    poseBeforePreviewRef.current = null;
    lastSolvedRef.current = "";
    setSelectedTaskUuid("");
    setReach(null);
    void restorePose(snapshot).catch((err) =>
      logger.log(`Could not restore the robot's pose: ${describeError(err)}`, "error"),
    );
  }

  function onJointValueChanged(ctrl: JointControl, rawValue: number | number[]) {
    const raw = Array.isArray(rawValue) ? rawValue[0] : rawValue;
    void applyJointValue(ctrl, raw)
      .then((clamped) => {
        if (!mountedRef.current) return;
        setJointControls((prev) =>
          prev.map((c) => (c.instance.uuid === ctrl.instance.uuid ? { ...c, value: clamped } : c)),
        );
      })
      .catch((err) => logger.log(`Joint update failed: ${describeError(err)}`, "error"));
  }

  return (
    <Box sx={{ overflowY: "auto" }}>
      <Typography variant="subtitle2" gutterBottom>
        Simulation Controls
      </Typography>

      {loading && <Typography variant="body2">Loading…</Typography>}

      {!loading && reachTasks.length > 0 && (
        <Box sx={{ mb: 2 }}>
          <Typography variant="body2" color="text.secondary" gutterBottom>
            Pick a Task, then drag it in the model: the robot reaches for it where it sits.
          </Typography>
          <FormControl fullWidth size="small" sx={{ mt: 1 }}>
            <InputLabel id="reach-task-label">Task</InputLabel>
            <Select
              labelId="reach-task-label"
              label="Task"
              value={selectedTaskUuid}
              onChange={(e: SelectChangeEvent) => setSelectedTaskUuid(e.target.value)}
            >
              {reachTasks.map((task) => (
                <MenuItem key={task.instance.uuid} value={task.instance.uuid}>
                  {task.name}
                  {task.motionEffect ? ` — ${task.motionEffect}` : ""}
                </MenuItem>
              ))}
            </Select>
          </FormControl>

          {selectedTask && (
            <Stack direction="row" spacing={1} alignItems="center" sx={{ mt: 1.5 }}>
              {reach?.problem ? (
                <Typography variant="body2" color="text.secondary">
                  {reach.problem}
                </Typography>
              ) : (
                <Chip
                  size="small"
                  color={reach?.reached ? "success" : "warning"}
                  label={
                    reach?.reached
                      ? "In reach"
                      : `Out of reach by ${Number.isFinite(reach?.error) ? reach!.error.toFixed(3) : "?"}`
                  }
                />
              )}
              <Button size="small" onClick={clearSelection} sx={{ ml: "auto" }}>
                Clear
              </Button>
            </Stack>
          )}
        </Box>
      )}

      {!loading && isRoboticSystemSceneType && jointControls.length === 0 && (
        <Typography variant="body2">No Joint instances found in the active scene.</Typography>
      )}

      {!loading &&
        isRoboticSystemSceneType &&
        jointControls.map((ctrl) => (
          <Box key={ctrl.instance.uuid} sx={{ my: 1.5 }}>
            <Box sx={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
              <Typography variant="body2">{ctrl.displayName}</Typography>
              <Typography variant="body2">Value: {ctrl.value}</Typography>
            </Box>
            <Stack direction="row" spacing={1.5} alignItems="center">
              <Typography variant="caption" sx={{ minWidth: 72 }}>
                Min: {ctrl.lower}
              </Typography>
              <Slider
                sx={{ flex: 1 }}
                size="small"
                aria-label={ctrl.displayName}
                min={ctrl.lower}
                max={ctrl.upper}
                step={ctrl.step}
                value={ctrl.value}
                disabled={ctrl.disabled}
                onChange={(_e, value) => onJointValueChanged(ctrl, value)}
              />
              <Typography variant="caption" sx={{ minWidth: 72 }}>
                Max: {ctrl.upper}
              </Typography>
            </Stack>
          </Box>
        ))}
    </Box>
  );
}
