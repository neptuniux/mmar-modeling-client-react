// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest";
import URDFLoader, { type URDFRobot } from "urdf-loader";
import type { ClassInstance } from "@gds";

/**
 * Driving the modelled robot from a command, as an executing process model does.
 *
 * The pose service is mocked down to the four things this file uses — its own maths has
 * its own tests — but the URDF is REAL, because which joints exist, in what order, and
 * what the IK solves against all come from a parsed robot.
 */

const mocks = vi.hoisted(() => ({
  urdfPoseService: {
    robotKeysForScene: vi.fn((_uuid: string): string[] => []),
    tryGetRobotJointValue: vi.fn((_i: unknown): number | undefined => undefined),
    registeredRobotKeys: vi.fn((): string[] => ["arm"]),
    robotOf: vi.fn((_key: string): unknown => undefined),
    jointInstancesOf: vi.fn((_key: string): Map<string, ClassInstance> => new Map()),
    tryUpdateRobotFromJointValue: vi.fn(async (_i: unknown, _v: number) => true),
  },
  recordJointValue: vi.fn(),
  logger: { log: vi.fn() },
}));
vi.mock("@/engine/hybrid-algorithms/urdf-pose-service", () => ({ urdfPoseService: mocks.urdfPoseService }));
vi.mock("@/engine/hybrid-algorithms/urdf-persistence", () => ({ recordJointValue: mocks.recordJointValue }));
vi.mock("@/resources/services/logger", () => ({ logger: mocks.logger }));

const { applyCartesianTarget, applyJointValues, readJointValues } = await import(
  "@/engine/hybrid-algorithms/urdf-motion"
);

const ARM = `<?xml version="1.0"?>
<robot name="arm">
  <link name="base_link"/>
  <link name="upper_arm"/>
  <link name="forearm"/>
  <link name="tool"/>
  <joint name="shoulder" type="revolute">
    <parent link="base_link"/><child link="upper_arm"/>
    <origin xyz="0 0 0"/><axis xyz="0 0 1"/>
    <limit lower="-3.14" upper="3.14" effort="10" velocity="2"/>
  </joint>
  <joint name="elbow" type="revolute">
    <parent link="upper_arm"/><child link="forearm"/>
    <origin xyz="1 0 0"/><axis xyz="0 0 1"/>
    <limit lower="-3.14" upper="3.14" effort="10" velocity="2"/>
  </joint>
  <joint name="wrist" type="fixed">
    <parent link="forearm"/><child link="tool"/>
    <origin xyz="1 0 0"/>
  </joint>
</robot>`;

function parseArm(): URDFRobot {
  const loader = new URDFLoader();
  loader.parseVisual = false;
  loader.parseCollision = false;
  const robot = loader.parse(ARM);
  robot.updateMatrixWorld(true);
  return robot;
}

/** The Joint instances the robot's joints map to, as registerRobot stores them. */
function jointInstances(): Map<string, ClassInstance> {
  return new Map([
    ["shoulder", { uuid: "joint-shoulder" } as unknown as ClassInstance],
    ["elbow", { uuid: "joint-elbow" } as unknown as ClassInstance],
  ]);
}

/** The value each joint instance was driven to. */
function applied(): Record<string, number> {
  const values: Record<string, number> = {};
  for (const [instance, value] of mocks.urdfPoseService.tryUpdateRobotFromJointValue.mock.calls) {
    values[(instance as ClassInstance).uuid] = value as number;
  }
  return values;
}

describe("urdf-motion", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.urdfPoseService.registeredRobotKeys.mockReturnValue(["arm"]);
    mocks.urdfPoseService.robotOf.mockReturnValue(parseArm());
    mocks.urdfPoseService.jointInstancesOf.mockReturnValue(jointInstances());
    mocks.urdfPoseService.tryUpdateRobotFromJointValue.mockResolvedValue(true);
    mocks.urdfPoseService.robotKeysForScene.mockReturnValue([]);
  });

  describe("applyJointValues", () => {
    it("matches a bare array against the robot's own movable joints, in URDF order", async () => {
      // What a controller's `angles: [j1, j2]` means. The fixed wrist is not a value.
      const result = await applyJointValues([0.5, -0.25]);

      expect(result.moved).toBe(2);
      expect(applied()).toEqual({ "joint-shoulder": 0.5, "joint-elbow": -0.25 });
    });

    it("takes joints by name too", async () => {
      await applyJointValues({ elbow: 1.5 });

      expect(applied()).toEqual({ "joint-elbow": 1.5 });
    });

    // The trap this exists for: xArm's set_servo_angle is degrees unless is_radian is
    // set, and a URDF holds radians. 90 degrees read as radians is 14 turns.
    it("converts degrees when the controller speaks degrees", async () => {
      await applyJointValues({ shoulder: 90 }, { degrees: true });

      expect(applied()["joint-shoulder"]).toBeCloseTo(Math.PI / 2);
    });

    it("records what it applied, so the pose survives a save", async () => {
      await applyJointValues({ shoulder: 0.3 });

      expect(mocks.recordJointValue).toHaveBeenCalledWith(
        expect.objectContaining({ uuid: "joint-shoulder" }),
        0.3,
      );
    });

    it("does not record a value the robot refused", async () => {
      mocks.urdfPoseService.tryUpdateRobotFromJointValue.mockResolvedValue(false);

      const result = await applyJointValues({ shoulder: 0.3 });

      expect(result.moved).toBe(0);
      expect(mocks.recordJointValue).not.toHaveBeenCalled();
    });

    it("moves the joints it knows and reports the ones it does not", async () => {
      const result = await applyJointValues({ shoulder: 0.2, gripper: 0.9 });

      expect(result.moved).toBe(1);
      expect(mocks.logger.log).toHaveBeenCalledWith(expect.stringContaining("gripper"), "info");
    });

    it("skips a value that is not a number", async () => {
      const result = await applyJointValues({ shoulder: NaN, elbow: 0.1 });

      expect(result.moved).toBe(1);
      expect(applied()).toEqual({ "joint-elbow": 0.1 });
    });
  });

  describe("choosing which robot to drive", () => {
    it("says so when no robot is loaded", async () => {
      mocks.urdfPoseService.registeredRobotKeys.mockReturnValue([]);

      const result = await applyJointValues([0.5]);

      expect(result.moved).toBe(0);
      expect(result.problem).toContain("no robot is loaded");
    });

    // Moving the wrong arm is worse than moving none, so several loaded robots is a
    // question for the caller rather than a guess.
    it("refuses to guess between several, and takes the one it is given", async () => {
      mocks.urdfPoseService.registeredRobotKeys.mockReturnValue(["arm", "gantry"]);

      const ambiguous = await applyJointValues([0.5]);
      expect(ambiguous.problem).toContain("2 robots");

      const named = await applyJointValues([0.5], { robotKey: "arm" });
      expect(named.moved).toBe(1);
    });

    // How a process model names a robot: it walks Pool -> Configuration system ->
    // Robotic system scene, and knows that scene's uuid. The URDF's own robot key is a
    // name the model never sees.
    it("takes the robot of a named scene, ahead of any other rule", async () => {
      mocks.urdfPoseService.registeredRobotKeys.mockReturnValue(["arm", "gantry"]);
      mocks.urdfPoseService.robotKeysForScene.mockReturnValue(["gantry"]);

      const result = await applyJointValues([0.5], { sceneInstanceUuid: "robot-scene" });

      expect(result.moved).toBe(1);
      expect(mocks.urdfPoseService.robotKeysForScene).toHaveBeenCalledWith("robot-scene");
      expect(mocks.urdfPoseService.jointInstancesOf).toHaveBeenCalledWith("gantry");
    });

    // THE PHANTOM. A scene that lists a robot whose instances are gone (an import that
    // was replaced) registers one with no joints. Taking it because it came first made
    // every solve report that it moved nothing.
    it("passes over a robot with no joints in favour of one that can move", async () => {
      mocks.urdfPoseService.robotKeysForScene.mockReturnValue(["dummy_link", "link_base"]);
      mocks.urdfPoseService.jointInstancesOf.mockImplementation((key) =>
        key === "link_base" ? jointInstances() : new Map(),
      );

      const result = await applyJointValues([0.5, 0.25], { sceneInstanceUuid: "robot-scene" });

      expect(result.moved).toBe(2);
      expect(mocks.urdfPoseService.robotOf).toHaveBeenCalledWith("link_base");
    });

    it("says so when the scene's only robot has no joints to drive", async () => {
      mocks.urdfPoseService.robotKeysForScene.mockReturnValue(["dummy_link"]);
      mocks.urdfPoseService.jointInstancesOf.mockReturnValue(new Map());

      const result = await applyJointValues([0.5], { sceneInstanceUuid: "robot-scene" });

      expect(result.moved).toBe(0);
      expect(result.problem).toContain("no joints");
    });

    it("says which scene has no robot loaded, rather than driving another one", async () => {
      mocks.urdfPoseService.registeredRobotKeys.mockReturnValue(["arm"]);
      mocks.urdfPoseService.robotKeysForScene.mockReturnValue([]);

      const result = await applyJointValues([0.5], { sceneInstanceUuid: "other-scene" });

      expect(result.moved).toBe(0);
      expect(result.problem).toContain("other-scene");
      expect(mocks.urdfPoseService.tryUpdateRobotFromJointValue).not.toHaveBeenCalled();
    });

    it("reports a robotKey that is not loaded", async () => {
      mocks.urdfPoseService.robotOf.mockReturnValue(undefined);

      const result = await applyJointValues([0.5], { robotKey: "ghost" });

      expect(result.problem).toContain("no robot 'ghost'");
    });
  });

  // What a simulation steps FROM: animating a joint move needs its starting value.
  describe("readJointValues", () => {
    it("reads the model's joints back by URDF joint name", () => {
      mocks.urdfPoseService.tryGetRobotJointValue.mockImplementation((instance) =>
        (instance as ClassInstance).uuid === "joint-shoulder" ? 0.4 : -1.2,
      );

      expect(readJointValues()).toEqual({ shoulder: 0.4, elbow: -1.2 });
    });

    it("reads a joint the robot cannot answer for as zero, not as a hole", () => {
      mocks.urdfPoseService.tryGetRobotJointValue.mockReturnValue(undefined);

      expect(readJointValues()).toEqual({ shoulder: 0, elbow: 0 });
    });

    it("has nothing to read when no robot is loaded", () => {
      mocks.urdfPoseService.registeredRobotKeys.mockReturnValue([]);

      expect(readJointValues()).toEqual({});
    });
  });

  describe("applyCartesianTarget", () => {
    it("solves for the joints that put the tool on the target, and drives them", async () => {
      const result = await applyCartesianTarget({ x: 1.2, y: 0.9, z: 0 });

      expect(result.reached).toBe(true);
      expect(result.moved).toBe(2);
      // Radians, whatever units the target arrived in.
      const values = applied();
      expect(Number.isFinite(values["joint-shoulder"])).toBe(true);
      expect(Number.isFinite(values["joint-elbow"])).toBe(true);
    });

    // A controller that reports millimetres would otherwise send the arm 1000x too far.
    it("converts a target given in millimetres", async () => {
      const metres = await applyCartesianTarget({ x: 1.2, y: 0.9, z: 0 });
      vi.clearAllMocks();
      mocks.urdfPoseService.robotOf.mockReturnValue(parseArm());
      mocks.urdfPoseService.jointInstancesOf.mockReturnValue(jointInstances());
      mocks.urdfPoseService.tryUpdateRobotFromJointValue.mockResolvedValue(true);
      mocks.urdfPoseService.registeredRobotKeys.mockReturnValue(["arm"]);

      const millimetres = await applyCartesianTarget({ x: 1200, y: 900, z: 0 }, { millimetres: true });

      expect(millimetres.reached).toBe(true);
      expect(millimetres.error).toBeCloseTo(metres.error!, 6);
    });

    it("moves as far as it can toward an unreachable point, and says it did not get there", async () => {
      const result = await applyCartesianTarget({ x: 9, y: 0, z: 0 });

      expect(result.reached).toBe(false);
      expect(result.moved).toBeGreaterThan(0);
      expect(mocks.logger.log).toHaveBeenCalledWith(expect.stringContaining("cannot reach"), "info");
    });

    it("reports a robot with no movable chain instead of pretending to solve", async () => {
      const loader = new URDFLoader();
      mocks.urdfPoseService.robotOf.mockReturnValue(
        loader.parse(`<?xml version="1.0"?><robot name="post"><link name="base_link"/></robot>`),
      );

      const result = await applyCartesianTarget({ x: 1, y: 0, z: 0 });

      expect(result.moved).toBe(0);
      expect(result.problem).toContain("no movable chain");
    });
  });
});
