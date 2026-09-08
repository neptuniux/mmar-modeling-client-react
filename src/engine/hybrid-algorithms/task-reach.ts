import * as THREE from "three";
import type { ClassInstance, SceneInstance } from "@gds";
import { bpmnAlgorithms } from "@/engine/hybrid-algorithms/bpmn-algorithms";
import { applyCartesianTarget, readJointValues, applyJointValues } from "@/engine/hybrid-algorithms/urdf-motion";
import { instanceUtility } from "@/resources/services/instance-utility";
import { backendService } from "@/resources/services/backend-service";
import { logger } from "@/resources/services/logger";
import { describeError } from "@/resources/util/describe-error";
import {
  MESSAGE_FLOW_RELATIONCLASS_UUID,
  MOTION_EFFECT_ATTRIBUTE_NAME,
  TASK_CLASS_UUID,
  TASK_PRIMITIVE_CONFIG_ATTRIBUTE_UUID,
} from "@/constants";

/**
 * "Can the arm reach this?" — asked by placing a Task in the model.
 *
 * A Task drawn in a BPMN scene sits somewhere on the canvas, and the Pool it flows to
 * draws its robot on that same canvas. So the Task's position IS a point in the robot's
 * workspace, once it is expressed in the robot's own frame: the group the robot is drawn
 * in carries the whole mapping (the fit-to-Pool scale, the centring, the Pool's
 * placement), and `worldToLocal` inverts it. Solve the arm to that point and the model
 * answers a question no attribute can — where this step of the process can actually
 * happen, and where it cannot.
 *
 * This is a PREVIEW, driven by the simulation panel rather than by an executing model.
 * `capturePose` / `restorePose` are what let it be undone: dragging a Task around to
 * find the edge of the workspace should not silently leave the robot somewhere new.
 */

/** A Task that has a robot to reach for: one whose Pool is showing one. */
export type ReachTask = {
  instance: ClassInstance;
  name: string;
  /** The Pool it flows to over a Message Flow. */
  poolUuid: string;
  /** The Robotic system scene that Pool's robot belongs to. */
  sceneInstanceUuid: string;
  /** What its Primitive says it does to the arm, when it says anything. */
  motionEffect?: string;
};

export type ReachResult = {
  /** Whether the arm got its tool to the Task. */
  reached: boolean;
  /** How far short it stopped, in the robot's own units (metres). */
  error: number;
  /** Why nothing could be asked, when nothing could. */
  problem?: string;
};

/** Joint values captured before a preview, so it can be taken back. */
export type PoseSnapshot = { sceneInstanceUuid: string; jointValues: Record<string, number> };

/** Primitive configurations already looked up, by uuid. */
const primitiveCache = new Map<string, ClassInstance | null>();

/** The instance behind a reference, from a loaded scene or from the server. */
async function loadInstance(uuid: string): Promise<ClassInstance | undefined> {
  const cached = primitiveCache.get(uuid);
  if (cached !== undefined) return cached ?? undefined;

  const instance =
    (await instanceUtility.getClassInstance(uuid).catch(() => undefined)) ??
    (await backendService.classesInstancesGET(uuid));
  primitiveCache.set(uuid, (instance as ClassInstance) ?? null);
  return instance as ClassInstance | undefined;
}

/** What this Task's Primitive says it does to the arm. */
async function motionEffectOf(task: ClassInstance): Promise<string | undefined> {
  const reference = task.attribute_instance?.find(
    (attributeInstance) => attributeInstance.uuid_attribute === TASK_PRIMITIVE_CONFIG_ATTRIBUTE_UUID,
  )?.role_instance_from?.uuid_has_reference_class_instance;
  if (!reference) return undefined;

  const primitive = await loadInstance(reference);
  // Matched on the name with case and punctuation normalised away: this attribute is
  // added to a metamodel by hand, and "Motion Effect" reading as "no motion" — silently,
  // because a Task that declares nothing is the ordinary case — is a poor way to spend
  // an afternoon.
  const wanted = normaliseAttributeName(MOTION_EFFECT_ATTRIBUTE_NAME);
  const effect = primitive?.attribute_instance?.find(
    (attributeInstance) => normaliseAttributeName(attributeInstance.name ?? "") === wanted,
  )?.value;
  const normalised = String(effect ?? "").trim().toLowerCase();
  return normalised && normalised !== "none" && normalised !== "not defined" ? normalised : undefined;
}

/** A metamodel attribute name, reduced to what a human meant by it. */
function normaliseAttributeName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** The Pool on the other end of this Task's Message Flow, in either direction. */
async function poolUuidOf(task: ClassInstance, scene: SceneInstance): Promise<string | undefined> {
  const relations = [
    ...(await instanceUtility.getOutgoingRelationsFromInstance(task.uuid, MESSAGE_FLOW_RELATIONCLASS_UUID)),
    ...(await instanceUtility.getIncomingRelationsFromInstance(task.uuid, MESSAGE_FLOW_RELATIONCLASS_UUID)),
  ];

  const poolUuids = new Set(
    (scene.class_instances ?? [])
      .filter((classInstance) => classInstance.uuid_class !== TASK_CLASS_UUID)
      .map((classInstance) => classInstance.uuid),
  );

  for (const relation of relations) {
    // A Message Flow is drawn Task -> Pool, but a model may hold it the other way round;
    // take whichever end is not this Task and is a Pool of this scene.
    for (const end of [
      relation.role_instance_to?.uuid_has_reference_class_instance,
      relation.role_instance_from?.uuid_has_reference_class_instance,
    ]) {
      if (end && end !== task.uuid && poolUuids.has(end)) return end;
    }
  }
  return undefined;
}

/**
 * The Tasks of this scene that can be placed against a robot: those flowing to a Pool
 * that is currently SHOWING one.
 *
 * Deliberately not filtered to the Tasks whose Primitive declares a motion. The target
 * here is the Task's own position on the canvas, not anything in its command, so any
 * Task can be used to probe the workspace — and a model where nobody has filled in
 * "Motion effect" yet would otherwise offer an empty list with nothing to explain it.
 */
export async function findReachTasks(scene: SceneInstance): Promise<ReachTask[]> {
  const tasks = (scene?.class_instances ?? []).filter(
    (classInstance) => classInstance.uuid_class === TASK_CLASS_UUID,
  );

  const reachable: ReachTask[] = [];
  for (const task of tasks) {
    try {
      const poolUuid = await poolUuidOf(task, scene);
      if (!poolUuid) continue;

      const view = bpmnAlgorithms.robotViewOfPool(poolUuid);
      if (!view) continue; // The Pool is not showing its robot: nothing to reach for.

      reachable.push({
        instance: task,
        name: nameOf(task),
        poolUuid,
        sceneInstanceUuid: view.sceneInstanceUuid,
        motionEffect: await motionEffectOf(task),
      });
    } catch (error) {
      logger.log(`Could not check a Task against its robot: ${describeError(error)}`, "error");
    }
  }
  return reachable;
}

/** A Task's "Name" attribute, or its uuid when it has none worth showing. */
function nameOf(task: ClassInstance): string {
  const named = task.attribute_instance?.find((attributeInstance) => attributeInstance.name === "Name");
  return named?.value?.trim() || task.uuid;
}

/** Where the Task sits, as a string that changes when it is dragged. */
export function positionSignature(task: ReachTask): string {
  const position = task.instance.coordinates_2d;
  return position ? `${position.x},${position.y},${position.z}` : "";
}

/** The robot's joints as they are now, to put back when the preview is cleared. */
export function capturePose(task: ReachTask): PoseSnapshot {
  return {
    sceneInstanceUuid: task.sceneInstanceUuid,
    jointValues: readJointValues({ sceneInstanceUuid: task.sceneInstanceUuid }),
  };
}

/** Put the robot back where `capturePose` found it. */
export async function restorePose(snapshot: PoseSnapshot | null): Promise<void> {
  if (!snapshot || Object.keys(snapshot.jointValues).length === 0) return;
  await applyJointValues(snapshot.jointValues, { sceneInstanceUuid: snapshot.sceneInstanceUuid });
}

/** Metres to millimetres, for a controller that speaks them. */
const METRES_TO_MILLIMETRES = 1000;

/**
 * A point on the canvas, expressed in the robot's own base frame.
 *
 * THIS IS THE CONVERSION A COMMAND NEEDS. The canvas holds metres in the SCENE's frame;
 * a robot is commanded in ITS frame, and often in millimetres. The group the robot is
 * drawn in carries the whole difference — where its base stands in the Pool, which way it
 * faces, and the Pool's own placement — so inverting that one matrix is the conversion.
 * A Task dropped where you want the tool to go therefore becomes the number to send.
 *
 * Returns nothing when the Pool is not showing its robot: without the drawn robot there
 * is no frame to be relative TO, and guessing one would produce a plausible wrong number.
 */
export function toRobotFrame(
  poolUuid: string,
  point: { x: number; y: number; z: number },
  options: { millimetres?: boolean } = {},
): { x: number; y: number; z: number } | undefined {
  const view = bpmnAlgorithms.robotViewOfPool(poolUuid);
  if (!view) return undefined;

  view.group.updateWorldMatrix(true, false);
  const local = view.group.worldToLocal(
    new THREE.Vector3(Number(point?.x) || 0, Number(point?.y) || 0, Number(point?.z) || 0),
  );

  const scale = options.millimetres ? METRES_TO_MILLIMETRES : 1;
  return { x: local.x * scale, y: local.y * scale, z: local.z * scale };
}

/**
 * Pose the robot as if it were reaching this Task, and say whether it got there.
 *
 * The Task's canvas position is mapped through the group its robot is drawn in, so the
 * answer is about where the Task SITS relative to the robot on screen — which is the
 * whole point of dragging it around.
 */
export async function previewTaskReach(task: ReachTask): Promise<ReachResult> {
  const view = bpmnAlgorithms.robotViewOfPool(task.poolUuid);
  if (!view) return { reached: false, error: Infinity, problem: "the Pool is not showing its robot" };

  const position = task.instance.coordinates_2d;
  if (!position) return { reached: false, error: Infinity, problem: "the Task has no position" };

  // The same conversion a command uses, in metres: solve the arm for where the Task sits.
  const target = toRobotFrame(task.poolUuid, position);
  if (!target) return { reached: false, error: Infinity, problem: "the Pool is not showing its robot" };

  const result = await applyCartesianTarget(target, { sceneInstanceUuid: task.sceneInstanceUuid });

  return {
    reached: result.reached === true,
    error: result.error ?? Infinity,
    problem: result.problem,
  };
}

/** Test seam: forget the Primitive configurations looked up so far. */
export function clearPrimitiveCache(): void {
  primitiveCache.clear();
}
