import * as THREE from "three";
import type { URDFJoint, URDFLink, URDFRobot } from "urdf-loader";

/**
 * Where the joints have to go for the arm's tip to reach a point in space.
 *
 * WHY THIS EXISTS. A robot command is either joint-space ("set these six angles") or
 * Cartesian ("put the tool here"). The first drives a URDF directly. The second does
 * not: turning a tool pose into joint angles is inverse kinematics, and neither
 * urdf-loader nor three.js offers one for a URDF chain (three's CCDIKSolver wants a
 * skinned bone rig). So the Cartesian half of a robot program could not be reflected in
 * the model at all.
 *
 * WHAT IT IS. Cyclic Coordinate Descent: walk the movable joints from the tip back to
 * the base, and turn each one by the angle that best points the tip at the target,
 * repeating the sweep until the tip is close enough. It is iterative and local, which
 * is what makes it small and dependency-free.
 *
 * WHAT IT IS NOT. It finds *a* pose that reaches the point, not the one the real robot
 * chose: no redundancy resolution, no elbow preference, no collision or self-collision
 * awareness, and orientation is ignored — only the tip POSITION is solved. Treat the
 * result as an illustration of the motion, not as a prediction of the hardware. Where
 * the robot can report its own joint state, that reading is the better source and this
 * solver should not be used at all.
 */

export type IkTarget = { x: number; y: number; z: number };

export type IkOptions = {
  /** Sweeps over the chain. Each sweep costs one pass per joint. */
  maxIterations?: number;
  /** Distance from the tip to the target at which the solve is called done. */
  tolerance?: number;
  /** The link to bring to the target. Defaults to the deepest leaf of the chain. */
  tipLinkName?: string;
};

export type IkResult = {
  /** Whether the tip got within `tolerance` of the target. */
  converged: boolean;
  /** How far the tip ended up from the target. */
  error: number;
  /** The value each movable joint ended on, by URDF joint name. */
  jointValues: Record<string, number>;
};

const DEFAULT_ITERATIONS = 20;
const DEFAULT_TOLERANCE = 1e-3;

/** A joint that moves. `fixed` joints carry no value and are skipped. */
function isMovable(joint: URDFJoint): boolean {
  return (joint.jointType ?? "fixed") !== "fixed";
}

/**
 * The link to drive: the one the longest chain of joints leads to, unless the caller
 * names one. A URDF tree can branch (a gripper's two fingers, a mounted camera); the
 * deepest leaf is the arm's own end, which is what a Cartesian command is about.
 */
function findTipLink(robot: URDFRobot, tipLinkName?: string): URDFLink | undefined {
  const links: URDFLink[] = Object.values(robot.links ?? {});
  if (tipLinkName) {
    return links.find((link) => link.urdfName === tipLinkName) ?? robot.links?.[tipLinkName];
  }

  let deepest: URDFLink | undefined;
  let deepestCount = -1;
  for (const link of links) {
    // Ranked by EVERY joint above the link, fixed ones included. Ranking by the
    // movable chain instead makes a flange tie with the last link that moves — a
    // fixed wrist joins them — and the tie is then settled by declaration order,
    // which is how the solver ends up driving the elbow and leaving the tool behind.
    const count = jointDepthOf(link);
    if (count > deepestCount) {
      deepest = link;
      deepestCount = count;
    }
  }
  return deepest;
}

/** How many joints of any kind sit between the root and `link`. */
function jointDepthOf(link: THREE.Object3D): number {
  let depth = 0;
  let current: THREE.Object3D | null = link.parent;
  while (current) {
    if ((current as URDFJoint).isURDFJoint) depth++;
    current = current.parent;
  }
  return depth;
}

/** The movable joints between the root and `link`, base first. */
function jointChainTo(link: THREE.Object3D): URDFJoint[] {
  const chain: URDFJoint[] = [];
  let current: THREE.Object3D | null = link.parent;
  while (current) {
    const joint = current as URDFJoint;
    if (joint.isURDFJoint && isMovable(joint)) chain.unshift(joint);
    current = current.parent;
  }
  return chain;
}

/** A joint's axis of motion in world space. */
function worldAxis(joint: URDFJoint, out: THREE.Vector3): THREE.Vector3 {
  const axis = (joint.axis as THREE.Vector3 | undefined) ?? new THREE.Vector3(0, 0, 1);
  // Rotating a joint about its own axis does not turn the axis, so the joint's own
  // world quaternion is the right frame to read it in.
  return out.copy(axis).applyQuaternion(joint.getWorldQuaternion(new THREE.Quaternion())).normalize();
}

/** The value a joint currently holds, whatever shape the loader keeps it in. */
function currentValue(joint: URDFJoint): number {
  const raw = (joint as unknown as { jointValue?: number | number[] }).jointValue;
  const value = Array.isArray(raw) ? raw[0] : raw;
  return Number.isFinite(value) ? (value as number) : 0;
}

/** `value`, kept inside the joint's declared limits when it declares usable ones. */
function clampToLimit(joint: URDFJoint, value: number): number {
  const limit = joint.limit as { lower?: number; upper?: number } | undefined;
  const lower = Number(limit?.lower);
  const upper = Number(limit?.upper);
  // A continuous joint has lower === upper === 0 in urdf-loader, which is not a limit
  // of zero travel but the absence of one.
  if (!Number.isFinite(lower) || !Number.isFinite(upper) || lower >= upper) return value;
  return Math.min(Math.max(value, lower), upper);
}

/**
 * Solve for the joint values that bring the arm's tip to `target` (in the robot's own
 * coordinates). The robot is left AT the solved pose — the caller decides whether to
 * keep it, and `jointValues` is what to feed the model.
 */
export function solveIk(robot: URDFRobot, target: IkTarget, options: IkOptions = {}): IkResult {
  const maxIterations = options.maxIterations ?? DEFAULT_ITERATIONS;
  const tolerance = options.tolerance ?? DEFAULT_TOLERANCE;

  const empty: IkResult = { converged: false, error: Infinity, jointValues: {} };
  const tipLink = findTipLink(robot, options.tipLinkName);
  if (!tipLink) return empty;

  const chain = jointChainTo(tipLink);
  if (chain.length === 0) return empty;

  const goal = new THREE.Vector3(target.x, target.y, target.z);
  const tip = new THREE.Vector3();
  const jointOrigin = new THREE.Vector3();
  const axis = new THREE.Vector3();
  const toTip = new THREE.Vector3();
  const toGoal = new THREE.Vector3();

  robot.updateMatrixWorld?.(true);

  let error = tipLink.getWorldPosition(tip).distanceTo(goal);

  for (let iteration = 0; iteration < maxIterations && error > tolerance; iteration++) {
    // Tip first: the joints nearest the tip make the small corrections, the ones near
    // the base the large ones. That ordering is what makes CCD converge quickly.
    for (let index = chain.length - 1; index >= 0; index--) {
      const joint = chain[index];
      joint.getWorldPosition(jointOrigin);
      worldAxis(joint, axis);
      tipLink.getWorldPosition(tip);

      if (joint.jointType === "prismatic") {
        // A slider cannot rotate anything: it can only close the part of the gap that
        // lies along its own axis.
        const along = toGoal.subVectors(goal, tip).dot(axis);
        joint.setJointValue(clampToLimit(joint, currentValue(joint) + along));
      } else {
        // Project both directions onto the plane the joint turns in, then take the
        // signed angle between them about the axis.
        toTip.subVectors(tip, jointOrigin).projectOnPlane(axis);
        toGoal.subVectors(goal, jointOrigin).projectOnPlane(axis);
        if (toTip.lengthSq() < 1e-12 || toGoal.lengthSq() < 1e-12) continue;
        toTip.normalize();
        toGoal.normalize();

        const cos = Math.min(1, Math.max(-1, toTip.dot(toGoal)));
        const sign = Math.sign(toTip.clone().cross(toGoal).dot(axis)) || 1;
        const delta = Math.acos(cos) * sign;
        if (!Number.isFinite(delta) || Math.abs(delta) < 1e-9) continue;

        joint.setJointValue(clampToLimit(joint, currentValue(joint) + delta));
      }

      robot.updateMatrixWorld?.(true);
    }

    error = tipLink.getWorldPosition(tip).distanceTo(goal);
  }

  const jointValues: Record<string, number> = {};
  for (const joint of chain) {
    if (joint.urdfName) jointValues[joint.urdfName] = currentValue(joint);
  }

  return { converged: error <= tolerance, error, jointValues };
}
