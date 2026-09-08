import type { ClassInstance } from "@gds";
import { urdfPoseService } from "@/engine/hybrid-algorithms/urdf-pose-service";
import { recordJointValue } from "@/engine/hybrid-algorithms/urdf-persistence";
import { solveIk, type IkTarget } from "@/engine/hybrid-algorithms/urdf-ik";
import { logger } from "@/resources/services/logger";

/**
 * Driving the modelled robot from a command, for the stored procedures that execute a
 * process model (`expressionUtility.setRobotJoints` / `.moveRobotTo`).
 *
 * WHY A TASK CANNOT BE READ FOR THIS. Whether a Task moves the arm is a property of the
 * ACTION, not of the command text: "move to pick pose" and "suction cup on" are both
 * commands with numbers in them, and a name match on "move" breaks on "MoveL", on a
 * translated model, and on the first primitive someone words differently. So nothing
 * here guesses — the procedure decides, from the flag the metamodel puts on the
 * Primitive configuration, and only then calls in.
 *
 * WHAT ARRIVES. A joint-space command carries the angles themselves and drives the model
 * exactly. A Cartesian one carries a tool pose, and turning that into joint angles is
 * inverse kinematics — `urdf-ik` solves it approximately, so a Cartesian move is an
 * ILLUSTRATION of the motion rather than a prediction of the hardware's own solution.
 *
 * UNITS are the usual trap: URDF joints are radians and metres, while a robot API is
 * commonly degrees and millimetres (xArm's `set_servo_angle` is degrees unless
 * `is_radian` is set). Both entry points take the incoming units rather than assuming.
 */

export type JointValues = number[] | Record<string, number>;

export type MotionOptions = {
  /** Incoming joint values are degrees (converted to the radians a URDF holds). */
  degrees?: boolean;
  /** Incoming Cartesian coordinates are millimetres (converted to metres). */
  millimetres?: boolean;
  /** Which robot, when more than one is loaded. Defaults to the only one. */
  robotKey?: string;
  /**
   * The Robotic system SCENE whose robot to drive — how a process model names one, via
   * the Pool ▶ Configuration system ▶ scene chain it already walks. Preferred over
   * `robotKey`, which is a URDF name the model never sees.
   */
  sceneInstanceUuid?: string;
  /** The link a Cartesian target refers to. Defaults to the end of the longest chain. */
  tipLinkName?: string;
};

export type MotionResult = {
  /** How many joints of the model actually moved. */
  moved: number;
  /** Why nothing moved, when nothing did. */
  problem?: string;
  /** Cartesian only: whether the solver reached the target, and how close it got. */
  reached?: boolean;
  error?: number;
};

const DEGREES_TO_RADIANS = Math.PI / 180;
const MILLIMETRES_TO_METRES = 0.001;

/**
 * The robot to drive: the one named, or the only one there is. Refusing to guess
 * between several is deliberate — moving the wrong arm is worse than moving none, and
 * the procedure can always name one.
 */
function resolveRobotKey(options: MotionOptions): { robotKey?: string; problem?: string } {
  if (options.sceneInstanceUuid) {
    const keys = urdfPoseService.robotKeysForScene(options.sceneInstanceUuid);
    // A robot with no Joint instances cannot be driven, however well it parsed. Such a
    // registration is a phantom — a scene listing a robot whose instances have gone —
    // and taking it because it happened to be first is how a reach check ends up
    // reporting that it moved nothing at all.
    const usable = keys.filter((key) => urdfPoseService.jointInstancesOf(key).size > 0);
    if (usable.length > 1) {
      logger.log(
        `Scene ${options.sceneInstanceUuid} holds ${usable.length} robots (${usable.join(", ")}); driving '${usable[0]}'`,
        "info",
      );
    }
    if (usable.length > 0) return { robotKey: usable[0] };
    if (keys.length > 0) {
      return { problem: `the robot of scene ${options.sceneInstanceUuid} has no joints that can be driven` };
    }
    return {
      problem:
        `no robot is loaded for scene ${options.sceneInstanceUuid} — show it from its Pool, ` +
        `or open that Robotic system scene, so its URDF is available`,
    };
  }

  if (options.robotKey) {
    return urdfPoseService.robotOf(options.robotKey)
      ? { robotKey: options.robotKey }
      : { problem: `no robot '${options.robotKey}' is loaded` };
  }

  const keys = urdfPoseService.registeredRobotKeys();
  if (keys.length === 1) return { robotKey: keys[0] };
  if (keys.length === 0) {
    return {
      problem:
        "no robot is loaded — open the Robotic system scene, or show it from a Pool, so its URDF is available",
    };
  }
  return { problem: `${keys.length} robots are loaded (${keys.join(", ")}); name one with robotKey` };
}

/**
 * Pair the incoming values with URDF joint names.
 *
 * An array is matched against the robot's own movable joints IN URDF ORDER, which is
 * what a controller's `angles: [j1…j6]` means. An object is taken as given.
 */
function namedValues(robotKey: string, values: JointValues): Record<string, number> {
  if (!Array.isArray(values)) return values;

  const robot = urdfPoseService.robotOf(robotKey);
  const movable = Object.entries(robot?.joints ?? {}).filter(
    ([, joint]) => (joint.jointType ?? "fixed") !== "fixed",
  );

  const named: Record<string, number> = {};
  values.forEach((value, index) => {
    const entry = movable[index];
    if (entry) named[entry[0]] = value;
  });
  return named;
}

/** Apply one joint's value to the model, and remember it for the next save. */
async function applyOne(instance: ClassInstance, radians: number): Promise<boolean> {
  const applied = await urdfPoseService.tryUpdateRobotFromJointValue(instance, radians);
  // Recorded on the same terms as a simulation slider: only a value the robot took.
  if (applied) recordJointValue(instance, radians);
  return applied;
}

/**
 * Where the model's joints are now, in radians, by URDF joint name.
 *
 * A simulation needs this to ANIMATE: to step a joint from where it is to where the
 * command puts it, something has to know where it started. It is also the honest thing
 * to log after a move.
 */
export function readJointValues(options: MotionOptions = {}): Record<string, number> {
  const { robotKey } = resolveRobotKey(options);
  if (!robotKey) return {};

  const values: Record<string, number> = {};
  for (const [jointName, instance] of urdfPoseService.jointInstancesOf(robotKey)) {
    const value = urdfPoseService.tryGetRobotJointValue(instance);
    values[jointName] = Number.isFinite(value) ? (value as number) : 0;
  }
  return values;
}

/**
 * Put the model's joints where a joint-space command puts the real ones.
 *
 * Every joint the command names is moved; one the model does not have is reported and
 * the rest still move, because a partial arm is more useful than none.
 */
export async function applyJointValues(
  values: JointValues,
  options: MotionOptions = {},
): Promise<MotionResult> {
  const { robotKey, problem } = resolveRobotKey(options);
  if (!robotKey) return { moved: 0, problem };

  const named = namedValues(robotKey, values);
  const jointInstances = urdfPoseService.jointInstancesOf(robotKey);

  let moved = 0;
  const missing: string[] = [];
  for (const [jointName, rawValue] of Object.entries(named)) {
    const value = Number(rawValue);
    if (!Number.isFinite(value)) continue;

    const instance = jointInstances.get(jointName);
    if (!instance) {
      missing.push(jointName);
      continue;
    }
    if (await applyOne(instance, options.degrees ? value * DEGREES_TO_RADIANS : value)) moved++;
  }

  if (missing.length > 0) {
    logger.log(`Robot '${robotKey}' has no joint named ${missing.join(", ")} — those were skipped`, "info");
  }
  return { moved };
}

/**
 * Put the model's joints where they would have to be for the tool to reach a point.
 *
 * The solve runs on the loaded URDF, so it starts from the pose the model is already in
 * — which is what makes a sequence of Cartesian moves track the program rather than jump
 * about. An unreachable target still moves the arm as far as it goes, and says so.
 */
export async function applyCartesianTarget(
  target: IkTarget,
  options: MotionOptions = {},
): Promise<MotionResult> {
  const { robotKey, problem } = resolveRobotKey(options);
  if (!robotKey) return { moved: 0, problem };

  const robot = urdfPoseService.robotOf(robotKey)!;
  const scale = options.millimetres ? MILLIMETRES_TO_METRES : 1;
  const solution = solveIk(
    robot,
    { x: Number(target.x) * scale, y: Number(target.y) * scale, z: Number(target.z) * scale },
    { tipLinkName: options.tipLinkName },
  );

  if (Object.keys(solution.jointValues).length === 0) {
    return { moved: 0, problem: `robot '${robotKey}' has no movable chain to solve` };
  }

  // The solved values are already radians, whatever units the target came in.
  const applied = await applyJointValues(solution.jointValues, { robotKey });
  if (!solution.converged) {
    logger.log(
      `The robot cannot reach that point: the tool stops ${solution.error.toFixed(3)} away from it`,
      "info",
    );
  }
  return { ...applied, reached: solution.converged, error: solution.error };
}
