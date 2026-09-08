// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest";
import * as THREE from "three";
import type { ClassInstance, SceneInstance } from "@gds";
import {
  BPMN_SCENETYPE_UUID,
  MESSAGE_FLOW_RELATIONCLASS_UUID,
  POOL_CLASS_UUID,
  TASK_CLASS_UUID,
  TASK_PRIMITIVE_CONFIG_ATTRIBUTE_UUID,
} from "@/constants";

/**
 * Asking the arm whether it can reach a Task where the Task has been placed.
 *
 * three.js is REAL, because the interesting part is the frame mapping: a Task's position
 * is on the BPMN canvas, while the solver works in the robot's own coordinates, and the
 * group the robot is drawn in (fit-to-Pool scale, centring, the Pool's own placement) is
 * what sits between them. The motion service is mocked so the target it is handed can be
 * inspected exactly.
 */

const mocks = vi.hoisted(() => ({
  bpmnAlgorithms: { robotViewOfPool: vi.fn((_uuid: string): unknown => undefined) },
  applyCartesianTarget: vi.fn(async (_t: unknown, _o: unknown) => ({ moved: 2, reached: true, error: 0 })),
  applyJointValues: vi.fn(async (_v: unknown, _o: unknown) => ({ moved: 2 })),
  readJointValues: vi.fn((_o: unknown) => ({ shoulder: 0.25 })),
  instanceUtility: {
    getOutgoingRelationsFromInstance: vi.fn(async (_u: string, _m: string): Promise<unknown[]> => []),
    getIncomingRelationsFromInstance: vi.fn(async (_u: string, _m: string): Promise<unknown[]> => []),
    getClassInstance: vi.fn(async (_u: string): Promise<unknown> => undefined),
  },
  backendService: { classesInstancesGET: vi.fn(async (_u: string): Promise<unknown> => undefined) },
  logger: { log: vi.fn() },
}));
vi.mock("@/engine/hybrid-algorithms/bpmn-algorithms", () => ({ bpmnAlgorithms: mocks.bpmnAlgorithms }));
vi.mock("@/engine/hybrid-algorithms/urdf-motion", () => ({
  applyCartesianTarget: mocks.applyCartesianTarget,
  applyJointValues: mocks.applyJointValues,
  readJointValues: mocks.readJointValues,
}));
vi.mock("@/resources/services/instance-utility", () => ({ instanceUtility: mocks.instanceUtility }));
vi.mock("@/resources/services/backend-service", () => ({ backendService: mocks.backendService }));
vi.mock("@/resources/services/logger", () => ({ logger: mocks.logger }));

const {
  toRobotFrame,
  capturePose,
  clearPrimitiveCache,
  findReachTasks,
  positionSignature,
  previewTaskReach,
  restorePose,
} = await import("@/engine/hybrid-algorithms/task-reach");

const POOL_UUID = "pool-1";
const ROBOT_SCENE_UUID = "robot-scene";

function task(uuid: string, name: string, x = 0, y = 0, z = 0, primitiveUuid?: string): ClassInstance {
  return {
    uuid,
    uuid_class: TASK_CLASS_UUID,
    coordinates_2d: { x, y, z },
    attribute_instance: [
      { uuid: `${uuid}-name`, name: "Name", uuid_attribute: "n", value: name },
      {
        uuid: `${uuid}-primitive`,
        name: "Primitive configuration",
        uuid_attribute: TASK_PRIMITIVE_CONFIG_ATTRIBUTE_UUID,
        value: "",
        role_instance_from: primitiveUuid
          ? { uuid_has_reference_class_instance: primitiveUuid }
          : undefined,
      },
    ],
  } as unknown as ClassInstance;
}

function bpmnScene(instances: ClassInstance[]): SceneInstance {
  return {
    uuid: "bpmn-scene",
    uuid_scene_type: BPMN_SCENETYPE_UUID,
    class_instances: [
      { uuid: POOL_UUID, uuid_class: POOL_CLASS_UUID, attribute_instance: [] },
      ...instances,
    ],
  } as unknown as SceneInstance;
}

/** A Message Flow drawn from `fromUuid` to `toUuid`. */
function messageFlow(fromUuid: string, toUuid: string) {
  return {
    uuid: `flow-${fromUuid}-${toUuid}`,
    uuid_relationclass: MESSAGE_FLOW_RELATIONCLASS_UUID,
    role_instance_from: { uuid_has_reference_class_instance: fromUuid },
    role_instance_to: { uuid_has_reference_class_instance: toUuid },
  };
}

/**
 * The Pool's robot group as `fitIntoPool` leaves it: scaled to the Pool and offset,
 * under a Pool object that sits somewhere on the canvas.
 */
function robotView(scale = 4, poolAt = new THREE.Vector3(10, 5, 0), groupOffset = new THREE.Vector3(0, 0, 0.05)) {
  const poolObject = new THREE.Object3D();
  poolObject.position.copy(poolAt);
  const group = new THREE.Group();
  group.scale.setScalar(scale);
  group.position.copy(groupOffset);
  poolObject.add(group);
  return { group, sceneInstanceUuid: ROBOT_SCENE_UUID };
}

/** The target handed to the solver by the last preview. */
function solvedTarget(): { x: number; y: number; z: number } {
  return mocks.applyCartesianTarget.mock.calls.at(-1)?.[0] as { x: number; y: number; z: number };
}

describe("task-reach", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearPrimitiveCache();
    mocks.bpmnAlgorithms.robotViewOfPool.mockReturnValue(robotView());
    mocks.applyCartesianTarget.mockResolvedValue({ moved: 2, reached: true, error: 0 });
    mocks.readJointValues.mockReturnValue({ shoulder: 0.25 });
    mocks.instanceUtility.getOutgoingRelationsFromInstance.mockResolvedValue([]);
    mocks.instanceUtility.getIncomingRelationsFromInstance.mockResolvedValue([]);
    mocks.instanceUtility.getClassInstance.mockResolvedValue(undefined);
    mocks.backendService.classesInstancesGET.mockResolvedValue(undefined);
  });

  describe("findReachTasks", () => {
    it("offers the Tasks that flow to a Pool which is showing its robot", async () => {
      const move = task("t1", "Move to pos");
      mocks.instanceUtility.getOutgoingRelationsFromInstance.mockResolvedValue([messageFlow("t1", POOL_UUID)]);

      const found = await findReachTasks(bpmnScene([move]));

      expect(found).toHaveLength(1);
      expect(found[0]).toMatchObject({ name: "Move to pos", poolUuid: POOL_UUID, sceneInstanceUuid: ROBOT_SCENE_UUID });
    });

    it("finds the Pool when the Message Flow is drawn the other way round", async () => {
      mocks.instanceUtility.getIncomingRelationsFromInstance.mockResolvedValue([messageFlow(POOL_UUID, "t1")]);

      expect(await findReachTasks(bpmnScene([task("t1", "Move")]))).toHaveLength(1);
    });

    it("leaves out a Task whose Pool is not showing a robot", async () => {
      mocks.instanceUtility.getOutgoingRelationsFromInstance.mockResolvedValue([messageFlow("t1", POOL_UUID)]);
      mocks.bpmnAlgorithms.robotViewOfPool.mockReturnValue(undefined);

      expect(await findReachTasks(bpmnScene([task("t1", "Move")]))).toEqual([]);
    });

    it("leaves out a Task that flows to no Pool at all", async () => {
      expect(await findReachTasks(bpmnScene([task("t1", "Lonely")]))).toEqual([]);
    });

    // The list is NOT filtered by Motion effect — the target is where the Task sits, not
    // anything in its command — but the effect is reported so the panel can show it.
    it("reports what the Task's Primitive says it does, when it says anything", async () => {
      mocks.instanceUtility.getOutgoingRelationsFromInstance.mockResolvedValue([messageFlow("t1", POOL_UUID)]);
      mocks.instanceUtility.getClassInstance.mockResolvedValue({
        uuid: "primitive-1",
        attribute_instance: [{ uuid: "p-effect", name: "Motion effect", value: "cartesian-mm" }],
      });

      const [found] = await findReachTasks(bpmnScene([task("t1", "Move", 0, 0, 0, "primitive-1")]));

      expect(found.motionEffect).toBe("cartesian-mm");
    });

    // The name is typed into a metamodel by hand. An exact match meant "Motion Effect"
    // read as no motion at all — silently, since a Task that declares nothing is the
    // ordinary case — and the robot simply never moved.
    it.each(["Motion Effect", "motion effect", "motion_effect", " Motion effect "])(
      "reads the effect from an attribute named %j",
      async (attributeName) => {
        mocks.instanceUtility.getOutgoingRelationsFromInstance.mockResolvedValue([messageFlow("t1", POOL_UUID)]);
        mocks.instanceUtility.getClassInstance.mockResolvedValue({
          uuid: "primitive-1",
          attribute_instance: [{ uuid: "p-effect", name: attributeName, value: "cartesian-mm" }],
        });
        clearPrimitiveCache();

        const [found] = await findReachTasks(bpmnScene([task("t1", "Move", 0, 0, 0, "primitive-1")]));

        expect(found.motionEffect).toBe("cartesian-mm");
      },
    );

    it("still ignores an attribute that is a different declaration", async () => {
      mocks.instanceUtility.getOutgoingRelationsFromInstance.mockResolvedValue([messageFlow("t1", POOL_UUID)]);
      mocks.instanceUtility.getClassInstance.mockResolvedValue({
        uuid: "primitive-1",
        attribute_instance: [{ uuid: "p-effect", name: "Motion effect notes", value: "cartesian-mm" }],
      });

      const [found] = await findReachTasks(bpmnScene([task("t1", "Move", 0, 0, 0, "primitive-1")]));

      expect(found.motionEffect).toBeUndefined();
    });

    it("treats an unset or 'none' Motion effect as no motion", async () => {
      mocks.instanceUtility.getOutgoingRelationsFromInstance.mockResolvedValue([messageFlow("t1", POOL_UUID)]);
      mocks.instanceUtility.getClassInstance.mockResolvedValue({
        uuid: "primitive-1",
        attribute_instance: [{ uuid: "p-effect", name: "Motion effect", value: "not defined" }],
      });

      const [found] = await findReachTasks(bpmnScene([task("t1", "Suction", 0, 0, 0, "primitive-1")]));

      expect(found.motionEffect).toBeUndefined();
    });
  });

  describe("previewTaskReach", () => {
    async function reachTaskAt(x: number, y: number, z: number) {
      mocks.instanceUtility.getOutgoingRelationsFromInstance.mockResolvedValue([messageFlow("t1", POOL_UUID)]);
      const [found] = await findReachTasks(bpmnScene([task("t1", "Move", x, y, z)]));
      return found;
    }

    // THE MAPPING. The Pool sits at (10, 5, 0) and its robot is drawn 4x with the group
    // 0.05 up, so a Task at (14, 5, 0.05) on the canvas is 1 metre out along x in the
    // robot's own frame — which is the number the solver must be given.
    it("asks the solver for the Task's place in the ROBOT's frame, not the canvas's", async () => {
      const found = await reachTaskAt(14, 5, 0.05);

      const result = await previewTaskReach(found);

      expect(solvedTarget().x).toBeCloseTo(1);
      expect(solvedTarget().y).toBeCloseTo(0);
      expect(solvedTarget().z).toBeCloseTo(0);
      // Named by scene, so the right arm moves when the model holds several.
      expect(mocks.applyCartesianTarget.mock.calls.at(-1)?.[1]).toEqual({ sceneInstanceUuid: ROBOT_SCENE_UUID });
      expect(result).toMatchObject({ reached: true, error: 0 });
    });

    it("reports a Task the arm cannot get to, and how far short it stopped", async () => {
      mocks.applyCartesianTarget.mockResolvedValue({ moved: 2, reached: false, error: 0.42 });

      expect(await previewTaskReach(await reachTaskAt(99, 5, 0))).toMatchObject({ reached: false, error: 0.42 });
    });

    it("says so when the Pool stopped showing its robot mid-preview", async () => {
      const found = await reachTaskAt(14, 5, 0);
      mocks.bpmnAlgorithms.robotViewOfPool.mockReturnValue(undefined);

      const result = await previewTaskReach(found);

      expect(result.reached).toBe(false);
      expect(result.problem).toContain("not showing its robot");
      expect(mocks.applyCartesianTarget).not.toHaveBeenCalled();
    });
  });

  // Dragging a Task around to find the edge of the workspace must not quietly leave the
  // robot somewhere new, so the pose before the preview is put back on clear.
  describe("capture / restore", () => {
    it("puts the joints back where the preview found them", async () => {
      mocks.instanceUtility.getOutgoingRelationsFromInstance.mockResolvedValue([messageFlow("t1", POOL_UUID)]);
      const [found] = await findReachTasks(bpmnScene([task("t1", "Move", 14, 5, 0)]));

      const snapshot = capturePose(found);
      expect(snapshot).toEqual({ sceneInstanceUuid: ROBOT_SCENE_UUID, jointValues: { shoulder: 0.25 } });

      await restorePose(snapshot);

      expect(mocks.applyJointValues).toHaveBeenCalledWith(
        { shoulder: 0.25 },
        { sceneInstanceUuid: ROBOT_SCENE_UUID },
      );
    });

    it("has nothing to restore when no robot answered", async () => {
      await restorePose({ sceneInstanceUuid: ROBOT_SCENE_UUID, jointValues: {} });
      await restorePose(null);

      expect(mocks.applyJointValues).not.toHaveBeenCalled();
    });
  });

  it("changes its position signature when the Task is dragged", async () => {
    mocks.instanceUtility.getOutgoingRelationsFromInstance.mockResolvedValue([messageFlow("t1", POOL_UUID)]);
    const [found] = await findReachTasks(bpmnScene([task("t1", "Move", 1, 2, 3)]));

    expect(positionSignature(found)).toBe("1,2,3");
    (found.instance as unknown as { coordinates_2d: unknown }).coordinates_2d = { x: 4, y: 2, z: 3 };
    expect(positionSignature(found)).toBe("4,2,3");
  });

  // THE UNITS PROBLEM. The canvas is metres; a controller's move command is commonly
  // millimetres. A Task placed 0.2 m in front of the robot has to reach the machine as
  // 200 — the same placement, spoken in the machine's units.
  describe("toRobotFrame", () => {
    it("converts a canvas point into the robot's frame, in metres", () => {
      // The robot is drawn life-size, standing on a Pool at (10, 5, 0).
      mocks.bpmnAlgorithms.robotViewOfPool.mockReturnValue(
        robotView(1, new THREE.Vector3(10, 5, 0), new THREE.Vector3(0, 0, 0.05)),
      );

      expect(toRobotFrame(POOL_UUID, { x: 10.2, y: 5, z: 0.2 })).toMatchObject({
        x: expect.closeTo(0.2, 6),
        y: expect.closeTo(0, 6),
        z: expect.closeTo(0.15, 6),
      });
    });

    it("converts the same point to millimetres when the controller speaks them", () => {
      mocks.bpmnAlgorithms.robotViewOfPool.mockReturnValue(
        robotView(1, new THREE.Vector3(10, 5, 0), new THREE.Vector3(0, 0, 0.05)),
      );

      // The case that started this: 0.2 / 0 / 0.15 on the canvas is 200 / 0 / 150 to send.
      expect(toRobotFrame(POOL_UUID, { x: 10.2, y: 5, z: 0.2 }, { millimetres: true })).toMatchObject({
        x: expect.closeTo(200, 3),
        y: expect.closeTo(0, 3),
        z: expect.closeTo(150, 3),
      });
    });

    // The robot's own facing is part of the frame: a Task in front of a robot turned 90
    // degrees is not at the same coordinates as one in front of an unturned robot.
    it("takes the robot's yaw into account", () => {
      const view = robotView(1, new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, 0));
      view.group.quaternion.setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI / 2);
      mocks.bpmnAlgorithms.robotViewOfPool.mockReturnValue(view);

      // A point one metre along the world's +x is one metre along the robot's -y once
      // the robot has been turned a quarter turn.
      expect(toRobotFrame(POOL_UUID, { x: 1, y: 0, z: 0 })).toMatchObject({
        x: expect.closeTo(0, 6),
        y: expect.closeTo(-1, 6),
        z: expect.closeTo(0, 6),
      });
    });

    it("says nothing at all when the Pool is not showing its robot", () => {
      mocks.bpmnAlgorithms.robotViewOfPool.mockReturnValue(undefined);

      expect(toRobotFrame(POOL_UUID, { x: 1, y: 2, z: 3 })).toBeUndefined();
    });
  });
});
