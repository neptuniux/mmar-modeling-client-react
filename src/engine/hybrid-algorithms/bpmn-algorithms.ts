import * as THREE from "three";
import type { ClassInstance, SceneInstance } from "@gds";
import { globalObject } from "@/engine/global-definition";
import { GraphicContext } from "@/engine/graphic-context";
import { hydrateMesh } from "@/engine/hybrid-algorithms/urdf-persistence";
import { instanceUtility } from "@/resources/services/instance-utility";
import { backendService } from "@/resources/services/backend-service";
import { logger } from "@/resources/services/logger";
import { describeError } from "@/resources/util/describe-error";
import {
  POOL_CLASS_UUID,
  ROBOTIC_SYSTEM_SCENETYPE_UUID,
  SHOW_REFERENCED_URDF_ATTRIBUTE_NAME,
  SHOW_REFERENCED_URDF_ATTRIBUTE_UUID,
} from "@/constants";

/**
 * Hybrid algorithms for the BPMN metamodel, reached through `hybridAlgorithmsService`
 * and never directly.
 *
 * A Pool can reference a Robotic system scene and switch the robot on with its
 * "Show referenced URDF system" attribute. When it is on, the referenced robot is built
 * from the meshes that scene has STORED (`urdf-persistence`) and hung under the Pool's
 * own three.js object, centred on it and scaled to fit inside it. Being a child is what
 * makes the robot follow a dragged Pool for free, and what makes it disappear with a
 * deleted one.
 *
 * The robot is a PICTURE of the referenced scene, not a second copy of it: the meshes
 * carry no instance uuids and are never added to `dragObjects`, so nothing selects,
 * drags, saves or deletes them. The two raycasts that do walk children
 * (`onViewMode`, `onDrawingMode` in interaction-handler) only ask whether anything was
 * hit, so a click on the robot still resolves to its Pool.
 *
 * WHY IT ALSO RUNS ON THE HEARTBEAT. The pass is driven both by an attribute edit and by
 * the 1 Hz canvas tick. The tick is what heals the two cases an edit cannot see: a Pool
 * whose vizRep was re-run (editing "Width Pool" replaces the mesh the robot hung under,
 * and that refresh is fire-and-forget, so it can land after the edit's own pass), and a
 * flag a COLLABORATOR toggled. Reconciling is cheap by construction — an already-correct
 * Pool costs one attribute read and one parent check, and a robot is built at most once.
 */

/** What was drawn for one Pool, so a later pass can tell "already correct" from "stale". */
type PoolRobot = {
  /** The group hung under the Pool's object. */
  group: THREE.Group;
  /** The object it was attached to — a re-run vizRep replaces it, which is the stale case. */
  attachedTo: THREE.Object3D;
  /** The referenced scene it was built from, so re-pointing the reference rebuilds. */
  sceneInstanceUuid: string;
};

/** Marks the group so a pass can find one it did not put in its own cache. */
const ROBOT_GROUP_TAG = "bpmnPoolRobot";

/** How much of the Pool's footprint the robot is allowed to fill. */
const POOL_FILL = 0.8;

export class BpmnAlgorithms {
  private globalObjectInstance = globalObject;
  private instanceUtility = instanceUtility;
  private logger = logger;

  /** Drawn robots, by Pool instance uuid. */
  private robotsByPool = new Map<string, PoolRobot>();

  /** Pools whose robot is being built right now — the 1 Hz tick must not start a second. */
  private building = new Set<string>();

  /** Referenced scenes already fetched, by uuid: the tick must not re-fetch them. */
  private sceneCache = new Map<string, SceneInstance>();

  /**
   * Bring every Pool of the open scene in line with its flag: draw the robot for a Pool
   * that wants one and has none, drop the one a Pool no longer wants.
   *
   * Errors are per-Pool: one Pool pointing at a scene that has gone must not stop the
   * others from drawing.
   */
  async checkPoolRobots(sceneInstance: SceneInstance): Promise<void> {
    const pools = (sceneInstance?.class_instances ?? []).filter(
      (classInstance) => classInstance.uuid_class === POOL_CLASS_UUID,
    );

    for (const pool of pools) {
      try {
        if (showsRobot(pool)) await this.ensureRobot(pool);
        else this.removeRobot(pool.uuid);
      } catch (error) {
        this.logger.log(`Could not show the robot of a Pool: ${describeError(error)}`, "error");
      }
    }
  }

  /** Draw the Pool's robot unless the one it already has is still the right one. */
  private async ensureRobot(pool: ClassInstance): Promise<void> {
    const poolObject = this.globalObjectInstance.scene?.getObjectByProperty("uuid", pool.uuid);
    // A Pool that is not drawn yet (mid-import, say) is not an error: the next pass has
    // an object to hang the robot under.
    if (!poolObject) return;

    const referencedSceneUuid = referencedRoboticSceneUuid(pool);
    if (!referencedSceneUuid) return;

    const existing = this.robotsByPool.get(pool.uuid);
    if (
      existing &&
      existing.attachedTo === poolObject &&
      existing.group.parent === poolObject &&
      existing.sceneInstanceUuid === referencedSceneUuid
    ) {
      return; // Already correct — the common case on the 1 Hz tick.
    }

    if (this.building.has(pool.uuid)) return;
    this.building.add(pool.uuid);
    try {
      // Whatever was there is stale: a different scene, or a Pool object that was
      // replaced under it.
      this.removeRobot(pool.uuid);

      const robotScene = await this.loadRoboticScene(referencedSceneUuid);
      if (!robotScene) return;

      const group = await this.buildRobot(robotScene);
      if (!group) {
        this.logger.log(
          `The scene '${robotScene.name}' has no stored robot meshes to show. ` +
            `Open it, import the robot's .zip (File > Map file to SceneInstance) and save.`,
          "info",
        );
        return;
      }

      fitIntoPool(group, poolObject);
      poolObject.add(group);
      this.robotsByPool.set(pool.uuid, {
        group,
        attachedTo: poolObject,
        sceneInstanceUuid: referencedSceneUuid,
      });
      this.globalObjectInstance.render = true;
    } finally {
      this.building.delete(pool.uuid);
    }
  }

  /** Detach and free the Pool's robot, if it has one. */
  private removeRobot(poolUuid: string): void {
    const existing = this.robotsByPool.get(poolUuid);
    if (!existing) return;

    existing.group.removeFromParent();
    disposeGroup(existing.group);
    this.robotsByPool.delete(poolUuid);
    this.globalObjectInstance.render = true;
  }

  /**
   * The referenced Robotic system scene, fully hydrated. The scene tree holds it only
   * once its SceneType has been expanded, so a scene the user has never looked at is
   * fetched — which is the normal case for a reference into another model.
   */
  private async loadRoboticScene(uuid: string): Promise<SceneInstance | undefined> {
    const cached = this.sceneCache.get(uuid);
    if (cached) return cached;

    const local = await this.instanceUtility.getSceneInstance(uuid);
    const sceneInstance = local ?? (await backendService.sceneInstancesGET(uuid));
    if (!sceneInstance) return undefined;

    if (sceneInstance.uuid_scene_type !== ROBOTIC_SYSTEM_SCENETYPE_UUID) return undefined;

    this.sceneCache.set(uuid, sceneInstance);
    return sceneInstance;
  }

  /**
   * Build the robot's links as one group, each at the pose the robotic scene saved for
   * it — so the robot appears in whatever pose the simulation left it in.
   *
   * Returns undefined when not one link had a mesh to draw, which is what a robotic
   * scene saved before its meshes were stored looks like.
   */
  private async buildRobot(robotScene: SceneInstance): Promise<THREE.Group | undefined> {
    const group = new THREE.Group();
    group.userData[ROBOT_GROUP_TAG] = robotScene.uuid;

    for (const link of robotScene.class_instances ?? []) {
      const vizRep = await hydrateMesh(link);
      if (!vizRep) continue;

      // A private GraphicContext per link, for the same reason the ObjectSpace
      // algorithms use one: the shared context may be mid-draw for the open scene.
      const gc = new GraphicContext();
      await gc.resetInstance();
      if (vizRep.format === "stl") await gc.graphic_stl(vizRep.data as ArrayBuffer, vizRep.scale);
      else await gc.graphic_gltf(vizRep.data, 0, 0, 0, vizRep.scale);
      const mesh = await gc.getMergedObjects();
      await gc.resetInstance();
      if (!mesh) continue;

      mesh.position.set(link.coordinates_2d?.x ?? 0, link.coordinates_2d?.y ?? 0, link.coordinates_2d?.z ?? 0);
      const rotation = link.rotation;
      if (rotation) mesh.quaternion.set(rotation.x, rotation.y, rotation.z, rotation.w);
      // The robot is scenery: keep it out of every raycast, whether or not the caller
      // asked for a recursive one.
      mesh.raycast = () => undefined;
      group.add(mesh);
    }

    return group.children.length > 0 ? group : undefined;
  }
}

/** Whether this Pool's "Show referenced URDF system" attribute is on. */
function showsRobot(pool: ClassInstance): boolean {
  const flag = pool.attribute_instance?.find(
    (attributeInstance) =>
      attributeInstance.uuid_attribute === SHOW_REFERENCED_URDF_ATTRIBUTE_UUID ||
      attributeInstance.name?.toLowerCase() === SHOW_REFERENCED_URDF_ATTRIBUTE_NAME.toLowerCase(),
  );
  // A boolean is stored as the STRING "true" here (the Statechange pose flags do the
  // same); "1" and "yes" are accepted so a differently-configured enumeration still works.
  return ["true", "1", "yes"].includes(String(flag?.value ?? "").trim().toLowerCase());
}

/**
 * The scene instance this Pool references, if any. Found by SHAPE rather than by the
 * reference attribute's name or uuid: a reference records its target on the role
 * instance, so a Pool has at most one attribute carrying a scene reference and that is
 * the robot's scene. `loadRoboticScene` is what confirms the target is a robotic one.
 */
function referencedRoboticSceneUuid(pool: ClassInstance): string | undefined {
  for (const attributeInstance of pool.attribute_instance ?? []) {
    const referenced = attributeInstance.role_instance_from?.uuid_has_reference_scene_instance;
    if (referenced) return referenced;
  }
  return undefined;
}

/**
 * Centre the robot on the Pool and scale it to fit inside the Pool's footprint.
 *
 * Measured from the Pool OBJECT's bounding box rather than its "Width Pool" / "Height
 * Pool" attributes: the box is what the Pool actually occupies, and it stays right for a
 * Pool whose vizRep sizes itself some other way. The robot is dropped onto the Pool's top
 * face — z is up here, in the scene and in URDF alike — so it stands on the Pool instead
 * of being buried in it.
 */
function fitIntoPool(group: THREE.Group, poolObject: THREE.Object3D): void {
  const poolBox = new THREE.Box3().setFromObject(poolObject);
  const robotBox = new THREE.Box3().setFromObject(group);
  if (poolBox.isEmpty() || robotBox.isEmpty()) return;

  const poolSize = poolBox.getSize(new THREE.Vector3());
  const robotSize = robotBox.getSize(new THREE.Vector3());

  // Uniform, so the robot keeps its proportions; driven by the tighter of the two
  // footprint axes. A zero-extent axis (a perfectly flat robot) is not a constraint.
  const ratios = [
    robotSize.x > 0 ? (poolSize.x * POOL_FILL) / robotSize.x : Infinity,
    robotSize.y > 0 ? (poolSize.y * POOL_FILL) / robotSize.y : Infinity,
  ].filter((ratio) => Number.isFinite(ratio) && ratio > 0);
  const scale = ratios.length > 0 ? Math.min(...ratios) : 1;
  group.scale.setScalar(scale);

  // The group is a child of the Pool, so it is placed in the Pool's LOCAL space: the
  // offsets below are the robot's own box brought back to the Pool's centre and top.
  const robotCentre = robotBox.getCenter(new THREE.Vector3());
  const poolCentre = poolBox.getCenter(new THREE.Vector3());
  group.position.set(
    -robotCentre.x * scale,
    -robotCentre.y * scale,
    (poolBox.max.z - poolCentre.z) - robotBox.min.z * scale,
  );
}

/** Free the GPU resources of a group that is no longer shown. */
function disposeGroup(group: THREE.Group): void {
  group.traverse((object) => {
    const mesh = object as THREE.Mesh;
    mesh.geometry?.dispose?.();
    const material = mesh.material;
    if (Array.isArray(material)) material.forEach((entry) => entry.dispose?.());
    else material?.dispose?.();
  });
}

// Module singleton — one shared instance.
export const bpmnAlgorithms = new BpmnAlgorithms();
