// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest";
import * as THREE from "three";
import type { ClassInstance, SceneInstance } from "@gds";
import {
  BPMN_SCENETYPE_UUID,
  POOL_CLASS_UUID,
  POOL_TARGET_SYSTEM_ATTRIBUTE_UUID,
  ROBOTIC_SYSTEM_SCENETYPE_UUID,
  SHOW_REFERENCED_URDF_ATTRIBUTE_UUID,
} from "@/constants";

/**
 * A BPMN Pool showing the robot of the Robotic system scene it references.
 *
 * three.js is REAL — the placement maths (true scale, at the declared base, on the Pool's
 * top face) is the interesting part and runs fine in jsdom without WebGL. The GraphicContext is
 * mocked into a unit cube per link: turning mesh bytes into geometry is its job and has
 * its own tests, and what matters here is where the result lands and when it is rebuilt.
 */

const scene = new THREE.Scene();

const mocks = vi.hoisted(() => ({
  globalObject: { scene: undefined as unknown as THREE.Scene, render: false },
  hydrateMesh: vi.fn(async (_i: unknown): Promise<unknown> => ({
    format: "stl",
    data: new ArrayBuffer(8),
    scale: [1, 1, 1],
  })),
  restoreRobots: vi.fn(async (_s: unknown) => undefined),
  readInstanceMeta: vi.fn((i: unknown) => ({ name: (i as { uuid: string }).uuid, kind: "link" })),
  urdfPoseService: {
    robotKeysForScene: vi.fn((_uuid: string): string[] => []),
    linkInstancesOf: vi.fn((_key: string): Map<string, unknown> => new Map()),
  },
  instanceUtility: {
    getSceneInstance: vi.fn(async (_uuid: string): Promise<unknown> => undefined),
    getClassInstance: vi.fn(async (_uuid: string): Promise<unknown> => undefined),
  },
  backendService: {
    sceneInstancesGET: vi.fn(async (_uuid: string): Promise<unknown> => undefined),
    classesInstancesGET: vi.fn(async (_uuid: string): Promise<unknown> => undefined),
  },
  logger: { log: vi.fn() },
  graphicContextCalls: { count: 0 },
}));
mocks.globalObject.scene = scene;

vi.mock("@/engine/global-definition", () => ({ globalObject: mocks.globalObject }));
vi.mock("@/engine/hybrid-algorithms/urdf-persistence", () => ({
  hydrateMesh: mocks.hydrateMesh,
  restoreRobots: mocks.restoreRobots,
  readInstanceMeta: mocks.readInstanceMeta,
}));
vi.mock("@/engine/hybrid-algorithms/urdf-pose-service", () => ({ urdfPoseService: mocks.urdfPoseService }));
vi.mock("@/resources/services/instance-utility", () => ({ instanceUtility: mocks.instanceUtility }));
vi.mock("@/resources/services/backend-service", () => ({ backendService: mocks.backendService }));
vi.mock("@/resources/services/logger", () => ({ logger: mocks.logger }));
vi.mock("@/engine/graphic-context", () => ({
  GraphicContext: class {
    async resetInstance() {}
    async graphic_stl() {}
    async graphic_gltf() {}
    async getMergedObjects() {
      mocks.graphicContextCalls.count++;
      // A unit cube standing on z = 0, so the fitted group's own box is predictable.
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial());
      mesh.geometry.translate(0, 0, 0.5);
      return mesh;
    }
  },
}));

const { eventBus } = await import("@/resources/services/event-bus");
const { BpmnAlgorithms } = await import("@/engine/hybrid-algorithms/bpmn-algorithms");
type Algorithms = InstanceType<typeof BpmnAlgorithms>;

const ROBOT_SCENE_UUID = "robot-scene";

const CONFIG_UUID = "configuration-system";

/**
 * The Configuration system a Pool points at, which is what points at the robotic scene.
 */
function configurationSystem(
  sceneUuid: string | null = ROBOT_SCENE_UUID,
  base?: { x?: number; y?: number; z?: number; yaw?: number },
): ClassInstance {
  return {
    uuid: CONFIG_UUID,
    attribute_instance: [
      {
        uuid: "config-robot-ref",
        name: "Robotic system",
        role_instance_from: sceneUuid ? { uuid_has_reference_scene_instance: sceneUuid } : undefined,
      },
      // Written the way a hand-made metamodel writes them, units in the name included.
      ...(base
        ? [
            { uuid: "c-x", name: "Base X (m)", value: String(base.x ?? 0) },
            { uuid: "c-y", name: "Base Y (m)", value: String(base.y ?? 0) },
            { uuid: "c-z", name: "Base Z (m)", value: String(base.z ?? 0) },
            { uuid: "c-yaw", name: "Base yaw (deg)", value: String(base.yaw ?? 0) },
          ]
        : []),
    ],
  } as unknown as ClassInstance;
}

/**
 * A Pool instance: `shows` drives the flag, `references` the CONFIGURATION SYSTEM it
 * points at — `null` for a Pool that references nothing (NOT `undefined`, which the
 * default would swallow).
 */
function pool(uuid: string, shows: boolean, references: string | null = CONFIG_UUID): ClassInstance {
  return {
    uuid,
    uuid_class: POOL_CLASS_UUID,
    attribute_instance: [
      {
        uuid: `${uuid}-flag`,
        name: "Show referenced URDF system",
        uuid_attribute: SHOW_REFERENCED_URDF_ATTRIBUTE_UUID,
        value: shows ? "true" : "false",
      },
      {
        uuid: `${uuid}-ref`,
        name: "Target system entity",
        uuid_attribute: POOL_TARGET_SYSTEM_ATTRIBUTE_UUID,
        value: "Robot A",
        role_instance_from: references ? { uuid_has_reference_class_instance: references } : undefined,
      },
    ],
  } as unknown as ClassInstance;
}

function bpmnScene(pools: ClassInstance[]): SceneInstance {
  return { uuid: "bpmn-scene", uuid_scene_type: BPMN_SCENETYPE_UUID, class_instances: pools } as unknown as SceneInstance;
}

/** A robotic scene whose links sit 1 unit apart along x. */
function roboticScene(linkCount = 2): SceneInstance {
  return {
    uuid: ROBOT_SCENE_UUID,
    name: "Robot A",
    uuid_scene_type: ROBOTIC_SYSTEM_SCENETYPE_UUID,
    class_instances: Array.from({ length: linkCount }, (_, index) => ({
      uuid: `link-${index}`,
      coordinates_2d: { x: index, y: 0, z: 0 },
      rotation: { x: 0, y: 0, z: 0, w: 1 },
      custom_variables: {},
    })),
  } as unknown as SceneInstance;
}

/** Draws a Pool object of the given footprint, as its vizRep would. */
function drawPoolObject(uuid: string, width = 8, height = 4): THREE.Mesh {
  const object = new THREE.Mesh(new THREE.BoxGeometry(width, height, 0.1), new THREE.MeshBasicMaterial());
  object.uuid = uuid;
  scene.add(object);
  return object;
}

function robotGroupOf(poolObject: THREE.Object3D): THREE.Group | undefined {
  return poolObject.children.find((child) => child instanceof THREE.Group) as THREE.Group | undefined;
}

describe("bpmn-algorithms: a Pool that shows its referenced robot", () => {
  let algorithms: Algorithms;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.graphicContextCalls.count = 0;
    scene.clear();
    algorithms = new BpmnAlgorithms();
    // Re-stated per test, not left to the hoisted defaults: clearAllMocks() clears CALLS,
    // not implementations, so a mockResolvedValue set by one test outlives it.
    mocks.instanceUtility.getSceneInstance.mockResolvedValue(roboticScene());
    mocks.instanceUtility.getClassInstance.mockResolvedValue(configurationSystem());
    mocks.backendService.sceneInstancesGET.mockResolvedValue(undefined);
    mocks.backendService.classesInstancesGET.mockResolvedValue(undefined);
    mocks.hydrateMesh.mockResolvedValue({ format: "stl", data: new ArrayBuffer(8), scale: [1, 1, 1] });
    mocks.restoreRobots.mockResolvedValue(undefined);
    mocks.readInstanceMeta.mockImplementation((i) => ({ name: (i as { uuid: string }).uuid, kind: "link" }));
    // No robot registered by default: the copy then reads the instances it was built
    // from, which is the single-copy case.
    mocks.urdfPoseService.robotKeysForScene.mockReturnValue([]);
    mocks.urdfPoseService.linkInstancesOf.mockReturnValue(new Map());
  });

  // TRUE SCALE. This client draws in metres everywhere else — a URDF import writes URDF
  // coordinates straight into the canvas — so a robot fitted to the swimlane was a
  // picture rather than a placement: distances inside it meant nothing, and a Task's
  // position relative to it could not be a real coordinate.
  it("draws the robot at 1:1 metres, standing on the Pool", async () => {
    const poolObject = drawPoolObject("pool-1");
    poolObject.position.set(12, 5, 0); // a Pool somewhere out in the scene

    await algorithms.checkPoolRobots(bpmnScene([pool("pool-1", true)]));

    const group = robotGroupOf(poolObject)!;
    expect(group).toBeDefined();
    expect(group.children).toHaveLength(2);
    // Not scaled to anything: a metre is a metre.
    expect(group.scale.x).toBe(1);
    // At the Pool's origin, on its top face (half of the 0.1 thickness).
    expect(group.position.x).toBeCloseTo(0);
    expect(group.position.y).toBeCloseTo(0);
    expect(group.position.z).toBeCloseTo(0.05);

    // Scenery, not model: every mesh opts out of picking, so the recursive raycasts
    // (onViewMode / onDrawingMode) cannot hit the robot instead of its Pool.
    expect(group.children.every((child) => child.raycast !== THREE.Mesh.prototype.raycast)).toBe(true);
  });

  // The base frame is what ties the model to the real cell: where in the Pool the robot
  // is bolted down, and which way it faces.
  it("stands the robot where the Configuration system says its base is", async () => {
    const poolObject = drawPoolObject("pool-1");
    mocks.instanceUtility.getClassInstance.mockResolvedValue(
      configurationSystem(ROBOT_SCENE_UUID, { x: 1.5, y: -0.5, z: 0.2, yaw: 90 }),
    );

    await algorithms.checkPoolRobots(bpmnScene([pool("pool-1", true)]));

    const group = robotGroupOf(poolObject)!;
    expect(group.position.x).toBeCloseTo(1.5);
    expect(group.position.y).toBeCloseTo(-0.5);
    // Measured from the Pool's top face, so a base at 0.2 stands 0.2 above it.
    expect(group.position.z).toBeCloseTo(0.05 + 0.2);
    // Declared in degrees, applied in radians.
    expect(new THREE.Euler().setFromQuaternion(group.quaternion).z).toBeCloseTo(Math.PI / 2);
  });

  // The Pool shows a robot from a scene that is NOT open, so nothing else registers its
  // URDF. Without that registration the robot is a still picture: the simulation and an
  // executing process model would both have nothing to drive.
  it("registers the referenced robot so its joints can be driven", async () => {
    drawPoolObject("pool-1");

    await algorithms.checkPoolRobots(bpmnScene([pool("pool-1", true)]));

    expect(mocks.restoreRobots).toHaveBeenCalledTimes(1);
    expect(mocks.restoreRobots.mock.calls[0][0]).toMatchObject({ uuid: ROBOT_SCENE_UUID });
  });

  it("carries a moved joint onto the copy drawn in the Pool", async () => {
    const poolObject = drawPoolObject("pool-1");
    const robotScene = roboticScene();
    mocks.instanceUtility.getSceneInstance.mockResolvedValue(robotScene);

    await algorithms.checkPoolRobots(bpmnScene([pool("pool-1", true)]));
    const group = robotGroupOf(poolObject)!;
    const drawnAtStart = group.children.map((child) => child.position.clone());

    // What the pose service does when a joint moves: it writes the new pose onto the
    // link INSTANCES. The Pool holds copies of their meshes, not the instances.
    const link = robotScene.class_instances[1] as unknown as {
      coordinates_2d: { x: number; y: number; z: number };
      rotation: { x: number; y: number; z: number; w: number };
    };
    link.coordinates_2d = { x: 4, y: 1, z: 2 };
    link.rotation = { x: 0, y: 0, z: 1, w: 0 };

    algorithms.syncRobotPoses();

    expect(group.children[1].position.toArray()).toEqual([4, 1, 2]);
    expect(group.children[1].quaternion.toArray()).toEqual([0, 0, 1, 0]);
    // The link that did not move stayed where it was drawn.
    expect(group.children[0].position).toEqual(drawnAtStart[0]);
  });

  // A simulated move animates over a few hundred milliseconds. Waiting for the 1 Hz
  // sweep to carry it renders that as a single jump, or misses it entirely — so the
  // copy follows the pose change itself.
  it("follows a robot pose change as it happens, not on the next sweep", async () => {
    const poolObject = drawPoolObject("pool-1");
    const robotScene = roboticScene();
    mocks.instanceUtility.getSceneInstance.mockResolvedValue(robotScene);
    await algorithms.checkPoolRobots(bpmnScene([pool("pool-1", true)]));
    const group = robotGroupOf(poolObject)!;

    // What urdf-pose-service does: write the new pose onto the link instance, then say so.
    (robotScene.class_instances[1] as unknown as { coordinates_2d: unknown }).coordinates_2d = {
      x: 7,
      y: 0,
      z: 3,
    };
    eventBus.publish("robotPoseChanged");

    expect(group.children[1].position.toArray()).toEqual([7, 0, 3]);
  });

  // THE FREEZE. The Pool loads the robotic scene from the server when the scene tree
  // has not lazily loaded it; opening that same scene in a tab afterwards registers the
  // robot against the TREE's own instance objects. A copy that held the instances it was
  // built from then followed an orphan and never moved again — with the sliders (which
  // need that tab open) and with an executing process model alike.
  it("follows the instances the pose service is moving, not the ones it was built from", async () => {
    const poolObject = drawPoolObject("pool-1");
    const builtFrom = roboticScene();
    mocks.instanceUtility.getSceneInstance.mockResolvedValue(builtFrom);
    await algorithms.checkPoolRobots(bpmnScene([pool("pool-1", true)]));
    const group = robotGroupOf(poolObject)!;

    // A second copy of the same scene, as opening it in a tab produces. Same link
    // names, different objects — and these are the ones that now move.
    const reopened = roboticScene();
    (reopened.class_instances[1] as unknown as { coordinates_2d: unknown }).coordinates_2d = {
      x: 5,
      y: 6,
      z: 7,
    };
    mocks.urdfPoseService.robotKeysForScene.mockReturnValue(["base_link"]);
    mocks.urdfPoseService.linkInstancesOf.mockReturnValue(
      new Map(reopened.class_instances.map((link) => [(link as unknown as { uuid: string }).uuid, link])),
    );

    eventBus.publish("robotPoseChanged");

    expect(group.children[1].position.toArray()).toEqual([5, 6, 7]);
    expect(mocks.urdfPoseService.robotKeysForScene).toHaveBeenCalledWith(ROBOT_SCENE_UUID);
  });

  // A Pool caught mid-redraw has no footprint to measure. Nothing is invented from it:
  // the robot sits at the Pool's origin until the Pool is whole, and is then stood on it.
  it("copes with a Pool that has no geometry yet", async () => {
    const poolObject = new THREE.Object3D() as unknown as THREE.Mesh;
    poolObject.uuid = "pool-1";
    scene.add(poolObject);
    const bpmn = bpmnScene([pool("pool-1", true)]);

    await algorithms.checkPoolRobots(bpmn);
    const group = robotGroupOf(poolObject)!;
    expect(group).toBeDefined();
    expect(group.scale.x).toBe(1);
    expect(group.position.z).toBe(0);

    poolObject.add(new THREE.Mesh(new THREE.BoxGeometry(8, 4, 0.1), new THREE.MeshBasicMaterial()));
    await algorithms.checkPoolRobots(bpmn);

    expect(robotGroupOf(poolObject)!.position.z).toBeCloseTo(0.05);
  });

  // Resizing a Pool changes the cell it draws, not the size of the machine standing in
  // it: at true scale the robot is unmoved by the Pool's dimensions.
  it("does not resize the robot when the Pool is resized", async () => {
    const poolObject = drawPoolObject("pool-1", 8, 4);
    const bpmn = bpmnScene([pool("pool-1", true)]);
    await algorithms.checkPoolRobots(bpmn);
    expect(robotGroupOf(poolObject)!.scale.x).toBe(1);

    poolObject.geometry = new THREE.BoxGeometry(2, 1, 0.1);
    await algorithms.checkPoolRobots(bpmn);

    expect(robotGroupOf(poolObject)!.scale.x).toBe(1);
    expect(robotGroupOf(poolObject)!.position.z).toBeCloseTo(0.05);
  });

  // A world axis-aligned box of a ROTATED Pool is not the Pool's shape: stand one upright
  // and its world box's y extent collapses to the Pool's thickness. The Pool is measured
  // in its OWN frame, which is also the frame the robot is placed in.
  it("stands the robot on the Pool however the Pool is rotated", async () => {
    const poolObject = drawPoolObject("pool-1", 8, 4);
    const bpmn = bpmnScene([pool("pool-1", true)]);

    const rotations: [number, number, number][] = [
      [0, 0, 0],
      [Math.PI / 2, 0, 0],
      [0, 0, Math.PI / 4],
    ];
    for (const [x, y, z] of rotations) {
      poolObject.rotation.set(x, y, z);
      await algorithms.checkPoolRobots(bpmn);
      expect(robotGroupOf(poolObject)!.position.z).toBeCloseTo(0.05);
      expect(robotGroupOf(poolObject)!.scale.x).toBe(1);
    }
  });

  // The robot is the Pool's child, so a Pool the engine has scaled would scale the robot
  // with it — and a metre would stop being a metre.
  it("keeps the robot at true world scale inside a scaled Pool", async () => {
    const poolObject = drawPoolObject("pool-1", 8, 4);
    poolObject.scale.setScalar(3);
    const bpmn = bpmnScene([pool("pool-1", true)]);

    await algorithms.checkPoolRobots(bpmn);

    // A third the size in the Pool's frame is life-size in the world's.
    const group = robotGroupOf(poolObject)!;
    expect(group.scale.x).toBeCloseTo(1 / 3);
    expect(group.getWorldScale(new THREE.Vector3()).x).toBeCloseTo(1);

    for (let pass = 0; pass < 3; pass++) await algorithms.checkPoolRobots(bpmn);
    expect(robotGroupOf(poolObject)!.getWorldScale(new THREE.Vector3()).x).toBeCloseTo(1);
  });

  it("places the robot identically however many times the pass runs", async () => {
    const poolObject = drawPoolObject("pool-1");
    const bpmn = bpmnScene([pool("pool-1", true)]);
    await algorithms.checkPoolRobots(bpmn);
    const first = robotGroupOf(poolObject)!.position.clone();

    for (let pass = 0; pass < 5; pass++) await algorithms.checkPoolRobots(bpmn);

    expect(robotGroupOf(poolObject)!.position.toArray()).toEqual(first.toArray());
  });

  it("draws nothing while the flag is off, and takes the robot away when it is switched off", async () => {
    const poolObject = drawPoolObject("pool-1");

    await algorithms.checkPoolRobots(bpmnScene([pool("pool-1", false)]));
    expect(robotGroupOf(poolObject)).toBeUndefined();
    expect(mocks.hydrateMesh).not.toHaveBeenCalled();

    await algorithms.checkPoolRobots(bpmnScene([pool("pool-1", true)]));
    expect(robotGroupOf(poolObject)).toBeDefined();

    await algorithms.checkPoolRobots(bpmnScene([pool("pool-1", false)]));
    expect(robotGroupOf(poolObject)).toBeUndefined();
  });

  // The pass runs once a second. A Pool that is already right must not rebuild its robot,
  // or the canvas would churn through mesh loads forever.
  it("leaves an already-correct Pool alone on the next pass", async () => {
    const poolObject = drawPoolObject("pool-1");
    const scene1 = bpmnScene([pool("pool-1", true)]);

    await algorithms.checkPoolRobots(scene1);
    const group = robotGroupOf(poolObject);
    expect(mocks.graphicContextCalls.count).toBe(2);

    await algorithms.checkPoolRobots(scene1);
    await algorithms.checkPoolRobots(scene1);

    expect(robotGroupOf(poolObject)).toBe(group);
    expect(mocks.graphicContextCalls.count).toBe(2);
    // The referenced scene is fetched once, not once per tick.
    expect(mocks.instanceUtility.getSceneInstance).toHaveBeenCalledTimes(1);
  });

  // Editing "Width Pool" re-runs the Pool's vizRep, which REPLACES the object the robot
  // was hanging under. The 1 Hz pass is what puts the robot back.
  it("re-attaches the robot when the Pool's object is replaced by a vizRep re-run", async () => {
    const first = drawPoolObject("pool-1");
    const bpmn = bpmnScene([pool("pool-1", true)]);
    await algorithms.checkPoolRobots(bpmn);
    expect(robotGroupOf(first)).toBeDefined();

    scene.remove(first);
    const second = drawPoolObject("pool-1", 4, 2);

    await algorithms.checkPoolRobots(bpmn);

    expect(robotGroupOf(second)).toBeDefined();
    // Rebuilt on the new object, still life-size.
    expect(robotGroupOf(second)!.scale.x).toBe(1);
  });

  it("waits for the Pool to be drawn instead of failing", async () => {
    await expect(algorithms.checkPoolRobots(bpmnScene([pool("undrawn", true)]))).resolves.toBeUndefined();
    expect(mocks.hydrateMesh).not.toHaveBeenCalled();
  });

  it("fetches a referenced scene the scene tree has not loaded yet", async () => {
    drawPoolObject("pool-1");
    mocks.instanceUtility.getSceneInstance.mockResolvedValue(undefined);
    mocks.backendService.sceneInstancesGET.mockResolvedValue(roboticScene());

    await algorithms.checkPoolRobots(bpmnScene([pool("pool-1", true)]));

    expect(mocks.backendService.sceneInstancesGET).toHaveBeenCalledWith(ROBOT_SCENE_UUID);
    expect(robotGroupOf(scene.getObjectByProperty("uuid", "pool-1")!)).toBeDefined();
  });

  it("ignores a reference that does not point at a robotic scene", async () => {
    const poolObject = drawPoolObject("pool-1");
    mocks.instanceUtility.getSceneInstance.mockResolvedValue({
      uuid: ROBOT_SCENE_UUID,
      uuid_scene_type: "some-other-scene-type",
      class_instances: [],
    });

    await algorithms.checkPoolRobots(bpmnScene([pool("pool-1", true)]));

    expect(robotGroupOf(poolObject)).toBeUndefined();
  });

  // Pool -> Configuration system -> Robotic system scene. The Pool no longer names the
  // scene itself, so the walk has to go through the configuration to find the robot.
  it("follows the Pool through its Configuration system to the robotic scene", async () => {
    const poolObject = drawPoolObject("pool-1");

    await algorithms.checkPoolRobots(bpmnScene([pool("pool-1", true)]));

    expect(mocks.instanceUtility.getClassInstance).toHaveBeenCalledWith(CONFIG_UUID);
    expect(mocks.instanceUtility.getSceneInstance).toHaveBeenCalledWith(ROBOT_SCENE_UUID);
    expect(robotGroupOf(poolObject)).toBeDefined();
  });

  // A Pool references its Communication configuration too, and that one leads nowhere.
  // Following the Target system entity first is what stops the walk wasting a lookup on
  // it — and, if the comm config were followed and cached as fruitless, still finding
  // the robot afterwards.
  it("follows the Target system entity ahead of the Pool's other references", async () => {
    const poolObject = drawPoolObject("pool-1");
    const withCommConfig = pool("pool-1", true);
    withCommConfig.attribute_instance.unshift({
      uuid: "pool-1-comm",
      name: "Communication configuration",
      uuid_attribute: "0675ab76-ce54-42c9-b6ec-5f29a8e5cc62",
      value: "xArm",
      role_instance_from: { uuid_has_reference_class_instance: "comm-config" },
    } as unknown as (typeof withCommConfig.attribute_instance)[number]);

    await algorithms.checkPoolRobots(bpmnScene([withCommConfig]));

    expect(robotGroupOf(poolObject)).toBeDefined();
    expect(mocks.instanceUtility.getClassInstance).toHaveBeenCalledTimes(1);
    expect(mocks.instanceUtility.getClassInstance).toHaveBeenCalledWith(CONFIG_UUID);
  });

  it("fetches a Configuration system that is not in a loaded scene", async () => {
    const poolObject = drawPoolObject("pool-1");
    mocks.instanceUtility.getClassInstance.mockResolvedValue(undefined);
    mocks.backendService.classesInstancesGET.mockResolvedValue(configurationSystem());

    await algorithms.checkPoolRobots(bpmnScene([pool("pool-1", true)]));

    expect(mocks.backendService.classesInstancesGET).toHaveBeenCalledWith(CONFIG_UUID);
    expect(robotGroupOf(poolObject)).toBeDefined();
  });

  it("looks through a Configuration system only once, however many ticks pass", async () => {
    drawPoolObject("pool-1");
    const bpmn = bpmnScene([pool("pool-1", true)]);

    await algorithms.checkPoolRobots(bpmn);
    await algorithms.checkPoolRobots(bpmn);
    await algorithms.checkPoolRobots(bpmn);

    expect(mocks.instanceUtility.getClassInstance).toHaveBeenCalledTimes(1);
  });

  it("stops at a Configuration system that references no robotic scene", async () => {
    const poolObject = drawPoolObject("pool-1");
    mocks.instanceUtility.getClassInstance.mockResolvedValue(configurationSystem(null));

    await algorithms.checkPoolRobots(bpmnScene([pool("pool-1", true)]));

    expect(robotGroupOf(poolObject)).toBeUndefined();
    expect(mocks.instanceUtility.getSceneInstance).not.toHaveBeenCalled();
  });

  // One hop of the same walk: a Pool wired straight to the scene still works, which
  // matters while a model is half migrated.
  it("still honours a Pool that names the robotic scene directly", async () => {
    const poolObject = drawPoolObject("pool-1");
    const direct = pool("pool-1", true, null);
    (direct.attribute_instance[1] as unknown as { role_instance_from: unknown }).role_instance_from = {
      uuid_has_reference_scene_instance: ROBOT_SCENE_UUID,
    };

    await algorithms.checkPoolRobots(bpmnScene([direct]));

    expect(robotGroupOf(poolObject)).toBeDefined();
    expect(mocks.instanceUtility.getClassInstance).not.toHaveBeenCalled();
  });

  it("does nothing for a Pool that references nothing", async () => {
    const poolObject = drawPoolObject("pool-1");

    await algorithms.checkPoolRobots(bpmnScene([pool("pool-1", true, null)]));

    expect(robotGroupOf(poolObject)).toBeUndefined();
    expect(mocks.instanceUtility.getClassInstance).not.toHaveBeenCalled();
  });

  // A robotic scene saved before its meshes were stored has links but nothing to draw.
  // Silence there looks like a broken flag, so it says what to do about it.
  it("explains a referenced scene that has no stored meshes", async () => {
    const poolObject = drawPoolObject("pool-1");
    mocks.hydrateMesh.mockResolvedValue(undefined);

    await algorithms.checkPoolRobots(bpmnScene([pool("pool-1", true)]));

    expect(robotGroupOf(poolObject)).toBeUndefined();
    expect(mocks.logger.log).toHaveBeenCalledWith(expect.stringContaining("Robot A"), "info");
  });

  it("keeps drawing the other Pools when one of them fails", async () => {
    const broken = drawPoolObject("pool-broken");
    const fine = drawPoolObject("pool-fine");
    fine.position.set(20, 0, 0);
    // The first Pool's lookup throws; the second gets a scene.
    mocks.instanceUtility.getSceneInstance.mockRejectedValueOnce(new Error("scene lookup exploded"));
    mocks.instanceUtility.getSceneInstance.mockResolvedValue(roboticScene());

    await algorithms.checkPoolRobots(bpmnScene([pool("pool-broken", true), pool("pool-fine", true)]));

    expect(robotGroupOf(broken)).toBeUndefined();
    expect(robotGroupOf(fine)).toBeDefined();
    expect(mocks.logger.log).toHaveBeenCalledWith(expect.stringContaining("scene lookup exploded"), "error");
  });
});
