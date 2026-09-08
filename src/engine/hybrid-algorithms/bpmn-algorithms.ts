import * as THREE from "three";
import type { ClassInstance, SceneInstance } from "@gds";
import { globalObject } from "@/engine/global-definition";
import { GraphicContext } from "@/engine/graphic-context";
import { hydrateMesh, readInstanceMeta, restoreRobots } from "@/engine/hybrid-algorithms/urdf-persistence";
import { urdfPoseService } from "@/engine/hybrid-algorithms/urdf-pose-service";
import { instanceUtility } from "@/resources/services/instance-utility";
import { eventBus } from "@/resources/services/event-bus";
import { backendService } from "@/resources/services/backend-service";
import { logger } from "@/resources/services/logger";
import { describeError } from "@/resources/util/describe-error";
import {
  POOL_CLASS_UUID,
  POOL_TARGET_SYSTEM_ATTRIBUTE_UUID,
  ROBOTIC_SYSTEM_SCENETYPE_UUID,
  SHOW_REFERENCED_URDF_ATTRIBUTE_NAME,
  SHOW_REFERENCED_URDF_ATTRIBUTE_UUID,
  ROBOT_BASE_ATTRIBUTE_NAMES,
} from "@/constants";

/**
 * Hybrid algorithms for the BPMN metamodel, reached through `hybridAlgorithmsService`
 * and never directly.
 *
 * A Pool reaches its robot two references away — Pool ▶ Configuration system ▶ Robotic
 * system scene — and switches it on with its "Show referenced URDF system" attribute.
 * When it is on, that robot is built from the meshes the scene has STORED
 * (`urdf-persistence`) and hung under the Pool's own three.js object at TRUE SCALE —
 * 1 canvas unit is 1 metre here, as everywhere else in this client — at the base the
 * Configuration system declares. Being a child is what makes the robot follow a dragged
 * Pool for free, and what makes it disappear with a deleted one; and because the Pool's
 * position is therefore the robot's place in the cell, dragging the Pool is how the
 * model is kept in step with where the machine actually stands.
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
  /**
   * The mesh drawn for each link, by URDF LINK NAME.
   *
   * By name and not by instance, because the instance a copy is built from is not
   * necessarily the one that later moves. The same scene can exist twice in the client:
   * a Pool loads it from the server when the scene tree has not lazily loaded it yet,
   * and opening that scene in a tab then registers the robot against the TREE's own
   * objects. Holding the built-from instances made the copy follow an orphan and freeze.
   */
  meshesByLink: Map<string, THREE.Mesh>;
  /** The instances it was built from — used only while no robot is registered. */
  builtFrom: Map<string, ClassInstance>;
};

/** Marks the group so a pass can find one it did not put in its own cache. */
const ROBOT_GROUP_TAG = "bpmnPoolRobot";

export class BpmnAlgorithms {
  private globalObjectInstance = globalObject;
  private instanceUtility = instanceUtility;
  private logger = logger;

  constructor() {
    // Follow a moving robot at ITS pace, not the 1 Hz sweep's: a simulated move is a
    // few hundred milliseconds of animation, which a once-a-second copy renders as one
    // jump, or misses entirely. The sweep still runs — it is what heals a Pool whose
    // object was replaced — but it is no longer what carries the motion.
    eventBus.subscribe("robotPoseChanged", () => this.syncRobotPoses());
  }

  /** Drawn robots, by Pool instance uuid. */
  private robotsByPool = new Map<string, PoolRobot>();

  /** Pools whose robot is being built right now — the 1 Hz tick must not start a second. */
  private building = new Set<string>();

  /** Referenced scenes already fetched, by uuid: the tick must not re-fetch them. */
  private sceneCache = new Map<string, SceneInstance>();

  /** What a Configuration system leads to: its robotic scene, and the robot's base. */
  private deploymentByConfiguration = new Map<string, { sceneInstanceUuid: string; configuration?: ClassInstance }>();

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

    const deployment = await this.deploymentFor(pool);
    if (!deployment?.sceneInstanceUuid) return;
    const referencedSceneUuid = deployment.sceneInstanceUuid;

    const existing = this.robotsByPool.get(pool.uuid);
    if (
      existing &&
      existing.attachedTo === poolObject &&
      existing.group.parent === poolObject &&
      existing.sceneInstanceUuid === referencedSceneUuid
    ) {
      // Already the right robot on the right object. Its PLACE is re-read each pass:
      // the base frame is an attribute like any other, and editing it should move the
      // robot without rebuilding it.
      placeInPool(existing.group, poolObject, baseFrameOf(deployment.configuration));
      return; // The common case on the 1 Hz tick.
    }

    if (this.building.has(pool.uuid)) return;
    this.building.add(pool.uuid);
    try {
      // Whatever was there is stale: a different scene, or a Pool object that was
      // replaced under it.
      this.removeRobot(pool.uuid);

      const robotScene = await this.loadRoboticScene(referencedSceneUuid);
      if (!robotScene) return;

      const built = await this.buildRobot(robotScene);
      if (!built) {
        this.logger.log(
          `The scene '${robotScene.name}' has no stored robot meshes to show. ` +
            `Open it, import the robot's .zip (File > Map file to SceneInstance) and save.`,
          "info",
        );
        return;
      }

      placeInPool(built.group, poolObject, baseFrameOf(deployment.configuration));
      poolObject.add(built.group);
      this.robotsByPool.set(pool.uuid, {
        group: built.group,
        attachedTo: poolObject,
        sceneInstanceUuid: referencedSceneUuid,
        meshesByLink: built.meshesByLink,
        builtFrom: built.builtFrom,
      });
      this.globalObjectInstance.render = true;
    } finally {
      this.building.delete(pool.uuid);
    }
  }

  /**
   * The group a Pool's robot is drawn in, and the scene that robot belongs to.
   *
   * The group carries the whole mapping from the robot's own coordinates to the BPMN
   * canvas — the fit-to-Pool scale, the centring offset and the Pool's own placement —
   * so `group.worldToLocal(point)` turns somewhere on the canvas into somewhere in the
   * robot's frame. That is what lets a Task be placed in the model and asked of the arm.
   */
  robotViewOfPool(poolUuid: string): { group: THREE.Group; sceneInstanceUuid: string } | undefined {
    const robot = this.robotsByPool.get(poolUuid);
    return robot ? { group: robot.group, sceneInstanceUuid: robot.sceneInstanceUuid } : undefined;
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
   * The Robotic system scene behind a Pool, TWO references away.
   *
   *     Pool ──ref──▶ Configuration system ──ref──▶ Robotic system scene
   *
   * The Pool's "Target system entity" attribute is the reference that leads there, and
   * it is tried first. Its SIBLINGS are then tried too — a Pool also references a
   * Communication configuration, which leads nowhere, so the cost of an attribute
   * re-created under a new uuid is one wasted lookup rather than a Pool that shows
   * nothing. A Pool that names the scene directly is honoured as well: that is one hop
   * of the same walk.
   *
   * The HOP is cached, not the Pool's own reference: re-pointing a Pool at a different
   * configuration is seen on the next tick, while the fetch behind it happens once.
   */
  private async deploymentFor(
    pool: ClassInstance,
  ): Promise<{ sceneInstanceUuid: string; configuration?: ClassInstance } | undefined> {
    const direct = referencesOf(pool);
    if (direct.scenes.length > 0) return { sceneInstanceUuid: direct.scenes[0] };

    for (const configUuid of direct.classInstances) {
      const cached = this.deploymentByConfiguration.get(configUuid);
      if (cached !== undefined) {
        if (cached.sceneInstanceUuid) return cached;
        continue; // Known not to lead to a scene.
      }

      const configuration =
        (await this.instanceUtility.getClassInstance(configUuid).catch(() => undefined)) ??
        (await backendService.classesInstancesGET(configUuid));
      const sceneUuid = referencesOf(configuration as ClassInstance | undefined).scenes[0];
      // An empty uuid records a configuration that references no scene, so the next tick
      // does not fetch it again just to learn the same thing.
      const deployment = {
        sceneInstanceUuid: sceneUuid ?? "",
        configuration: configuration as ClassInstance | undefined,
      };
      this.deploymentByConfiguration.set(configUuid, deployment);
      if (sceneUuid) return deployment;
    }

    return undefined;
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

    // Register the robot even though this scene is not the open one. That is what puts
    // a URDF behind the Pool's copy: an executing process model can then drive its
    // joints (expressionUtility.setRobotJoints), and `syncRobotPoses` carries the
    // result onto the meshes below. Without it the Pool would show a robot that
    // nothing can move.
    await restoreRobots(sceneInstance);

    this.sceneCache.set(uuid, sceneInstance);
    return sceneInstance;
  }

  /**
   * Carry the link instances' current poses onto the meshes drawn for them.
   *
   * The Pool's robot is a copy, not the instances themselves, so a joint move — a
   * simulation slider, or a Task the execution procedure just ran — reaches it only
   * here. Cheap enough for the 1 Hz pass: a vector and a quaternion per link, and
   * nothing at all when the scene holds no Pool robot.
   */
  syncRobotPoses(): void {
    for (const robot of this.robotsByPool.values()) {
      // Read from whichever instances the pose service is moving RIGHT NOW, found
      // through the scene rather than the objects this copy was built from. That is
      // what keeps a Pool's robot alive after the same scene is opened in a tab and
      // re-registered against a different copy of its instances.
      const [robotKey] = urdfPoseService.robotKeysForScene(robot.sceneInstanceUuid);
      const live = robotKey ? urdfPoseService.linkInstancesOf(robotKey) : undefined;

      for (const [linkName, mesh] of robot.meshesByLink) {
        const link = live?.get(linkName) ?? robot.builtFrom.get(linkName);
        if (!link) continue;
        const position = link.coordinates_2d;
        if (position) mesh.position.set(position.x, position.y, position.z);
        const rotation = link.rotation;
        if (rotation) mesh.quaternion.set(rotation.x, rotation.y, rotation.z, rotation.w);
      }
    }
    if (this.robotsByPool.size > 0) this.globalObjectInstance.render = true;
  }

  /**
   * Build the robot's links as one group, each at the pose the robotic scene saved for
   * it — so the robot appears in whatever pose the simulation left it in.
   *
   * Returns undefined when not one link had a mesh to draw, which is what a robotic
   * scene saved before its meshes were stored looks like.
   */
  private async buildRobot(robotScene: SceneInstance): Promise<
    | {
        group: THREE.Group;
        meshesByLink: Map<string, THREE.Mesh>;
        builtFrom: Map<string, ClassInstance>;
      }
    | undefined
  > {
    const group = new THREE.Group();
    group.userData[ROBOT_GROUP_TAG] = robotScene.uuid;
    const meshesByLink = new Map<string, THREE.Mesh>();
    const builtFrom = new Map<string, ClassInstance>();

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
      // Keyed by the URDF link name, which is the same on every copy of the scene.
      const linkName = readInstanceMeta(link)?.name ?? link.uuid;
      meshesByLink.set(linkName, mesh);
      builtFrom.set(linkName, link);
    }

    return group.children.length > 0 ? { group, meshesByLink, builtFrom } : undefined;
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
 * The instances a reference on `instance` points at, by kind.
 *
 * The Pool's "Target system entity" reference comes FIRST among the class instances: a
 * Pool holds more than one reference now (the Configuration system and the
 * Communication configuration), and the target system is the one that leads to a robot.
 * The others are still followed after it, so an attribute re-created under a new uuid
 * only costs a fetch rather than the feature.
 */
function referencesOf(instance: ClassInstance | undefined): {
  scenes: string[];
  classInstances: string[];
} {
  const scenes: string[] = [];
  const classInstances: string[] = [];
  let targetSystem: string | undefined;

  for (const attributeInstance of instance?.attribute_instance ?? []) {
    const role = attributeInstance.role_instance_from;
    if (role?.uuid_has_reference_scene_instance) scenes.push(role.uuid_has_reference_scene_instance);
    if (!role?.uuid_has_reference_class_instance) continue;

    if (attributeInstance.uuid_attribute === POOL_TARGET_SYSTEM_ATTRIBUTE_UUID) {
      targetSystem = role.uuid_has_reference_class_instance;
    } else {
      classInstances.push(role.uuid_has_reference_class_instance);
    }
  }

  return { scenes, classInstances: targetSystem ? [targetSystem, ...classInstances] : classInstances };
}

/**
 * Centre the robot on the Pool and scale it to fit inside the Pool's footprint.
 *
 * Measured from the Pool OBJECT's bounding box rather than its "Width Pool" / "Height
 * Pool" attributes: the box is what the Pool actually occupies, and it stays right for a
 * Pool whose vizRep sizes itself some other way. The robot is dropped onto the Pool's top
 * face — z is up here, in the scene and in URDF alike — so it stands on the Pool instead
 * of being buried in it.
 *
 * Everything here is measured in the POOL'S OWN FRAME (`measureLocalBox`), never in world
 * space, because the group being placed is a child of the Pool: a scale and an offset
 * expressed in the Pool's local space have to be computed from sizes in that same space.
 * See `measureLocalBox` for what a world measurement did to a rotated Pool.
 */
/**
 * Place the robot in the Pool at TRUE SCALE.
 *
 * The client draws in metres — a URDF import writes URDF coordinates straight into the
 * canvas — so the robot is drawn 1:1 and put where the Configuration system says its
 * base stands. That is what makes the model a placement rather than a picture: a Task's
 * position relative to the robot is then a real distance, and a target read off the
 * canvas is a coordinate the machine can be sent.
 *
 * The base offset is read in the POOL's frame, because the group is the Pool's child and
 * the Pool's own position is the robot's place in the cell. `z` is measured from the
 * Pool's top face, so a base at 0 stands on it instead of being buried in it.
 */
function placeInPool(group: THREE.Group, poolObject: THREE.Object3D, frame: RobotBaseFrame): void {
  // A metre must stay a metre IN THE WORLD. The robot is the Pool's child, so a Pool the
  // engine has scaled would otherwise scale the robot with it and the model would no
  // longer measure anything.
  const poolScale = poolObject.getWorldScale(new THREE.Vector3());
  group.scale.setScalar(poolScale.x !== 0 ? 1 / poolScale.x : 1);

  group.quaternion.setFromAxisAngle(new THREE.Vector3(0, 0, 1), frame.yaw);

  const poolBox = measurePoolBox(poolObject, group);
  const topOfPool = poolBox ? poolBox.max.z : 0;
  group.position.set(frame.x, frame.y, topOfPool + frame.z);
}

/**
 * The Pool's own bounding box, in the POOL'S LOCAL SPACE, with `exclude` (its own robot)
 * left out.
 *
 * Local and not world, because a world axis-aligned box of a ROTATED Pool is not the
 * Pool's shape: stand a Pool upright and its world box's y extent collapses to the Pool's
 * thickness. The robot is placed in the Pool's frame anyway, so that is the frame to
 * measure in. Excluding the robot keeps a measurement from feeding the previous placement
 * back into the next one.
 */
function measurePoolBox(poolObject: THREE.Object3D, exclude?: THREE.Object3D): THREE.Box3 | undefined {
  const parent = exclude?.parent;
  if (parent === poolObject) exclude!.removeFromParent();

  poolObject.updateWorldMatrix(true, true);
  const intoPool = new THREE.Matrix4().copy(poolObject.matrixWorld).invert();
  const toPool = new THREE.Matrix4();
  const corner = new THREE.Vector3();
  const box = new THREE.Box3();

  poolObject.traverse((child) => {
    const geometry = (child as THREE.Mesh).geometry;
    if (!geometry) return;
    if (!geometry.boundingBox) geometry.computeBoundingBox();
    const bounds = geometry.boundingBox;
    if (!bounds) return;

    // Each mesh's own corners, brought into the Pool's frame — an axis-aligned box
    // cannot simply be rotated, so the corners are what has to be transformed.
    toPool.multiplyMatrices(intoPool, child.matrixWorld);
    for (let index = 0; index < 8; index++) {
      corner.set(
        index & 1 ? bounds.max.x : bounds.min.x,
        index & 2 ? bounds.max.y : bounds.min.y,
        index & 4 ? bounds.max.z : bounds.min.z,
      );
      box.expandByPoint(corner.applyMatrix4(toPool));
    }
  });

  if (parent === poolObject) parent.add(exclude!);
  return box.isEmpty() ? undefined : box;
}

/** Where a robot's base stands within its Pool, in metres and radians. */
type RobotBaseFrame = { x: number; y: number; z: number; yaw: number };

/**
 * The base frame declared on the Configuration system, defaulting to the Pool's own
 * origin facing 0 — which is what a deployment that has not been surveyed yet means.
 *
 * Attribute names are matched loosely (case, spaces, punctuation and any unit suffix are
 * ignored), because these are attributes added to a metamodel by hand: "Base X",
 * "Base X (m)" and "base_x" are all the same declaration.
 */
function baseFrameOf(configuration: ClassInstance | undefined): RobotBaseFrame {
  const read = (name: string): number => {
    const wanted = normaliseAttributeName(name);
    const attribute = configuration?.attribute_instance?.find(
      (candidate) => normaliseAttributeName(candidate?.name ?? "").startsWith(wanted),
    );
    const value = Number(attribute?.value);
    return Number.isFinite(value) ? value : 0;
  };

  return {
    x: read(ROBOT_BASE_ATTRIBUTE_NAMES.x),
    y: read(ROBOT_BASE_ATTRIBUTE_NAMES.y),
    z: read(ROBOT_BASE_ATTRIBUTE_NAMES.z),
    // Declared in degrees, applied in radians.
    yaw: read(ROBOT_BASE_ATTRIBUTE_NAMES.yaw) * (Math.PI / 180),
  };
}

function normaliseAttributeName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, "");
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
