// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest";
import * as THREE from "three";
import type { ClassInstance, SceneInstance } from "@gds";
import {
  BPMN_SCENETYPE_UUID,
  POOL_CLASS_UUID,
  ROBOTIC_SYSTEM_SCENETYPE_UUID,
  SHOW_REFERENCED_URDF_ATTRIBUTE_UUID,
} from "@/constants";

/**
 * A BPMN Pool showing the robot of the Robotic system scene it references.
 *
 * three.js is REAL — the placement maths (centre on the Pool, scale to its footprint) is
 * the interesting part and runs fine in jsdom without WebGL. The GraphicContext is
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
  instanceUtility: { getSceneInstance: vi.fn(async (_uuid: string): Promise<unknown> => undefined) },
  backendService: { sceneInstancesGET: vi.fn(async (_uuid: string): Promise<unknown> => undefined) },
  logger: { log: vi.fn() },
  graphicContextCalls: { count: 0 },
}));
mocks.globalObject.scene = scene;

vi.mock("@/engine/global-definition", () => ({ globalObject: mocks.globalObject }));
vi.mock("@/engine/hybrid-algorithms/urdf-persistence", () => ({ hydrateMesh: mocks.hydrateMesh }));
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

const { BpmnAlgorithms } = await import("@/engine/hybrid-algorithms/bpmn-algorithms");
type Algorithms = InstanceType<typeof BpmnAlgorithms>;

const ROBOT_SCENE_UUID = "robot-scene";

/**
 * A Pool instance: `shows` drives the flag, `references` the scene it points at — `null`
 * for a Pool that references nothing (NOT `undefined`, which the default would swallow).
 */
function pool(uuid: string, shows: boolean, references: string | null = ROBOT_SCENE_UUID): ClassInstance {
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
        name: "Referenced system",
        uuid_attribute: "some-reference-attribute",
        value: "Robot A",
        role_instance_from: references ? { uuid_has_reference_scene_instance: references } : undefined,
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
    mocks.backendService.sceneInstancesGET.mockResolvedValue(undefined);
    mocks.hydrateMesh.mockResolvedValue({ format: "stl", data: new ArrayBuffer(8), scale: [1, 1, 1] });
  });

  it("hangs the referenced robot under the Pool, centred on it and scaled to its footprint", async () => {
    const poolObject = drawPoolObject("pool-1");
    poolObject.position.set(12, 5, 0); // a Pool somewhere out in the scene

    await algorithms.checkPoolRobots(bpmnScene([pool("pool-1", true)]));

    const group = robotGroupOf(poolObject);
    expect(group).toBeDefined();
    // One drawn mesh per link of the referenced scene.
    expect(group!.children).toHaveLength(2);

    // Two unit cubes at x = 0 and x = 1 span 2 x 1 in the footprint; the Pool is 8 x 4,
    // so the tighter axis is y: 4 * 0.8 / 1 = 3.2.
    expect(group!.scale.x).toBeCloseTo(3.2);

    // Centred: the robot's own centre (x = 0.5) is pulled back to the Pool's centre.
    expect(group!.position.x).toBeCloseTo(-0.5 * 3.2);
    expect(group!.position.y).toBeCloseTo(0);
    // Standing ON the Pool: its base lands on the top face, half the Pool's thickness up.
    expect(group!.position.z).toBeCloseTo(0.05);

    // Scenery, not model: every mesh opts out of picking, so the recursive raycasts
    // (onViewMode / onDrawingMode) cannot hit the robot instead of its Pool.
    expect(group!.children.every((child) => child.raycast !== THREE.Mesh.prototype.raycast)).toBe(true);
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
    // Rebuilt against the NEW footprint: 2 * 0.8 / 1 = 1.6.
    expect(robotGroupOf(second)!.scale.x).toBeCloseTo(1.6);
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

  it("does nothing for a Pool that references nothing", async () => {
    const poolObject = drawPoolObject("pool-1");

    await algorithms.checkPoolRobots(bpmnScene([pool("pool-1", true, null)]));

    expect(robotGroupOf(poolObject)).toBeUndefined();
    expect(mocks.instanceUtility.getSceneInstance).not.toHaveBeenCalled();
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
