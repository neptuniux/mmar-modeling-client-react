// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest";
import { ClassInstance } from "@gds";

/**
 * P12 tests for roboticsystem-algorithms — the URDF import that MapFromFileDialog runs
 * on a dropped .zip. Driven through the REAL urdf-loader against a fixture URDF (the
 * npm package ships no samples) and a FAKE zip index, because the interesting parts are
 * (a) that a URDF's links/joints become the right class instances at the right poses,
 * (b) that mesh references resolve against the in-memory archive, and (c) the zip-path
 * indexing, which is pure and full of normalisation edge cases.
 *
 * jsdom is REQUIRED: URDFLoader.parse() uses DOMParser (no such global in Node 20), and
 * the attribute mapping walks the parsed URDF's DOM (getElementsByTagName).
 *
 * The creation handler / persistency / meta-utility are mocked: instance creation is
 * covered by P5's own tests, and persistencyHandler.checkIfClassinstanceInScene() needs
 * WebGL. What is asserted here is what THIS file computes.
 */

const fakeGlobal = vi.hoisted(() => ({ globalObject: {} }));
vi.mock("@/engine/global-definition", () => fakeGlobal);

type CreatedInstance = ClassInstance & { urdfRobotKey?: string; urdfRef?: { kind: string; name: string } };

const mocks = vi.hoisted(() => {
  let counter = 0;
  return {
    resetCounter: () => (counter = 0),
    instanceCreationHandler: {
      create_UUID: vi.fn(() => `uuid-${++counter}`),
      createClassInstance: vi.fn(
        async (uuid: string, x: number, y: number, z: number, classUUID: string) =>
          ({
            uuid,
            name: "",
            uuid_class: classUUID,
            coordinates_2d: { x, y, z },
            rotation: { x: 0, y: 0, z: 0, w: 1 },
            attribute_instance: [],
          }) as unknown as ClassInstance,
      ),
      createAttributeInstance: vi.fn(
        async (attribute: { uuid: string; name: string }, _s: unknown, _c: unknown, value: string) => ({
          uuid: `attr-${++counter}`,
          name: attribute.name,
          uuid_attribute: attribute.uuid,
          value,
          table_attributes: [] as unknown[],
        }),
      ),
      createRoleInstance: vi.fn(async (uuid: string) => ({ uuid, name: "" })),
    },
    urdfPoseService: { registerRobot: vi.fn() },
    hybridAlgorithmsService: { checkHybridAlgorithms: vi.fn(async () => undefined) },
    persistencyHandler: { checkIfClassinstanceInScene: vi.fn(async () => undefined) },
    metaUtility: {
      getTabContextSceneType: vi.fn(async (): Promise<unknown> => undefined),
      getMetaClass: vi.fn(async (): Promise<unknown> => undefined),
    },
    instanceUtility: {
      getAttributeInstanceFromClassInstance: vi.fn(async (): Promise<unknown> => undefined),
      // The open scene is what the imported URDF is remembered against, for the next
      // save to upload; a tab with no scene simply skips that.
      getTabContextSceneInstance: vi.fn(async (): Promise<unknown> => ({ uuid: "scene-instance-uuid" })),
    },
    logger: { log: vi.fn() },
  };
});
vi.mock("@/engine/instance-creation-handler", () => ({ instanceCreationHandler: mocks.instanceCreationHandler }));
vi.mock("@/engine/hybrid-algorithms/urdf-pose-service", () => ({ urdfPoseService: mocks.urdfPoseService }));
vi.mock("@/engine/hybrid-algorithms/hybrid-algorithms-service", () => ({
  hybridAlgorithmsService: mocks.hybridAlgorithmsService,
}));
vi.mock("@/resources/services/persistency-handler", () => ({ persistencyHandler: mocks.persistencyHandler }));
vi.mock("@/resources/services/meta-utility", () => ({ metaUtility: mocks.metaUtility }));
vi.mock("@/resources/services/instance-utility", () => ({ instanceUtility: mocks.instanceUtility }));
vi.mock("@/resources/services/logger", () => ({ logger: mocks.logger }));

const { RoboticsystemAlgorithms } = await import("@/engine/hybrid-algorithms/roboticsystem-algorithms");
type Algorithms = InstanceType<typeof RoboticsystemAlgorithms>;

const LINK_META_UUID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const JOINT_META_UUID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const FIXTURE_URDF = `<?xml version="1.0"?>
<robot name="test_arm">
  <link name="base_link">
    <inertial>
      <mass value="2.5"/>
      <origin xyz="0 0 0.1" rpy="0 0 0"/>
      <inertia ixx="1" ixy="0" ixz="0" iyy="2" iyz="0" izz="3"/>
    </inertial>
    <visual name="base_visual">
      <origin xyz="0 0 0" rpy="0 0 0"/>
      <geometry><mesh filename="package://test_arm/meshes/base.stl" scale="0.5 0.5 0.5"/></geometry>
      <material name="grey"><color rgba="0.5 0.5 0.5 1"/></material>
    </visual>
    <collision name="base_collision">
      <origin xyz="0 0 0" rpy="0 0 0"/>
      <geometry><box size="1 1 1"/></geometry>
    </collision>
  </link>
  <link name="forearm_link"/>
  <joint name="shoulder_to_forearm" type="revolute">
    <parent link="base_link"/>
    <child link="forearm_link"/>
    <origin xyz="0 0 0.5" rpy="0 0 0"/>
    <axis xyz="0 0 1"/>
    <limit lower="-1.5" upper="1.5" effort="10" velocity="2"/>
  </joint>
</robot>`;

/** A fake unzipit entry map: the real one exposes text()/arrayBuffer()/blob() per entry. */
function makeZipEntries(files: Record<string, string>) {
  const entries: Record<string, { text: () => Promise<string>; arrayBuffer: () => Promise<ArrayBuffer> }> = {};
  for (const [path, content] of Object.entries(files)) {
    entries[path] = {
      text: async () => content,
      arrayBuffer: async () => new TextEncoder().encode(content).buffer as ArrayBuffer,
    };
  }
  return entries;
}

describe("roboticsystem-algorithms", () => {
  let algorithms: Algorithms;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resetCounter();
    algorithms = new RoboticsystemAlgorithms();

    mocks.metaUtility.getTabContextSceneType.mockResolvedValue({
      uuid: "scene-type",
      classes: [
        { uuid: LINK_META_UUID, name: "Link", attributes: [] },
        { uuid: JOINT_META_UUID, name: "Joint", attributes: [] },
      ],
    });
  });

  describe("createZipIndex", () => {
    it("normalises paths and indexes by path + lowercase path + base name", () => {
      const index = algorithms.createZipIndex(
        makeZipEntries({
          "./robot/urdf/arm.urdf": "<robot/>",
          "robot\\meshes\\Base.STL": "stl",
          "/leading/slash.txt": "x",
        }),
      );

      expect(index.byPath.has("robot/urdf/arm.urdf")).toBe(true);
      // Backslashes become forward slashes; the leading ./ and / are trimmed.
      expect(index.byPath.has("robot/meshes/Base.STL")).toBe(true);
      expect(index.byPath.has("leading/slash.txt")).toBe(true);
      // Case-insensitive lookup is a separate map.
      expect(index.byPathLower.has("robot/meshes/base.stl")).toBe(true);
      expect(index.entries.find((e) => e.baseNameLower === "base.stl")).toBeDefined();
    });

    it("skips directory entries", () => {
      const index = algorithms.createZipIndex(makeZipEntries({ "robot/urdf/": "", "robot/urdf/arm.urdf": "<robot/>" }));
      expect(index.entries).toHaveLength(1);
      expect(index.entries[0].path).toBe("robot/urdf/arm.urdf");
    });
  });

  describe("processZipUrdf", () => {
    it("logs and bails when the archive holds no .urdf", async () => {
      await algorithms.processZipUrdf(algorithms.createZipIndex(makeZipEntries({ "readme.txt": "hi" })));

      expect(mocks.logger.log).toHaveBeenCalledWith("No URDF file found in extracted archive", "info");
      expect(mocks.instanceCreationHandler.createClassInstance).not.toHaveBeenCalled();
    });

    it("creates a class instance per link and joint, at their URDF world poses", async () => {
      await algorithms.processZipUrdf(
        algorithms.createZipIndex(makeZipEntries({ "robot/urdf/arm.urdf": FIXTURE_URDF })),
      );

      const calls = mocks.instanceCreationHandler.createClassInstance.mock.calls;
      // 2 links + 1 joint
      expect(calls).toHaveLength(3);

      const links = calls.filter((c) => c[4] === LINK_META_UUID);
      const joints = calls.filter((c) => c[4] === JOINT_META_UUID);
      expect(links).toHaveLength(2);
      expect(joints).toHaveLength(1);

      // The joint's origin is 0.5m up from base_link -> that is its world pose.
      const [, jx, jy, jz] = joints[0];
      expect(jx).toBeCloseTo(0);
      expect(jy).toBeCloseTo(0);
      expect(jz).toBeCloseTo(0.5);
    });

    it("tags every created instance with the robot key + urdf ref, and registers the robot", async () => {
      await algorithms.processZipUrdf(
        algorithms.createZipIndex(makeZipEntries({ "robot/urdf/arm.urdf": FIXTURE_URDF })),
      );

      expect(mocks.urdfPoseService.registerRobot).toHaveBeenCalledTimes(1);
      const [robotKey, , scaleFactor, linkInstances, jointInstances] = mocks.urdfPoseService.registerRobot.mock
        .calls[0] as [string, unknown, number, CreatedInstance[], CreatedInstance[]];

      // PINS A MISNOMER, FAITHFULLY (see state.json → discoveries, P12): the "robot key"
      // is `robot.urdfName || robot.name || 'robot'`, and urdf-loader's URDFRobot EXTENDS
      // URDFLink and IS the root link — so urdfName holds the ROOT LINK's name
      // ('base_link'), not the <robot name="test_arm"> (that is `robot.robotName`, which
      // the old client never reads). Harmless as an identity (registerRobot and the
      // instance tags use the same value), but two robots sharing a root link name — and
      // 'base_link' is a near-universal convention — collide in robotsByKey.
      expect(robotKey).toBe("base_link");
      expect(scaleFactor).toBe(1);
      expect(linkInstances).toHaveLength(2);
      expect(jointInstances).toHaveLength(1);

      // The tags are what let a later slider/Origin edit find its joint again.
      expect(jointInstances[0].urdfRobotKey).toBe(robotKey);
      expect(jointInstances[0].urdfRef).toEqual({ kind: "joint", name: "shoulder_to_forearm" });
      expect(linkInstances.map((l) => l.urdfRef?.name).sort()).toEqual(["base_link", "forearm_link"]);
    });

    it("attaches the referenced mesh from the zip as urdfVizRep, resolved via package:// and base name", async () => {
      // NOTE the URDF says `package://test_arm/meshes/base.stl` but the archive stores it
      // under a different top-level folder — the base-name fallback is what saves it.
      await algorithms.processZipUrdf(
        algorithms.createZipIndex(
          makeZipEntries({ "robot/urdf/arm.urdf": FIXTURE_URDF, "some_other_root/meshes/base.stl": "STL-BYTES" }),
        ),
      );

      const [, , , linkInstances] = mocks.urdfPoseService.registerRobot.mock.calls[0] as [
        string,
        unknown,
        number,
        (CreatedInstance & { urdfVizRep?: { format: string; scale: number[]; data: unknown } })[],
        CreatedInstance[],
      ];
      const baseLink = linkInstances.find((l) => l.urdfRef?.name === "base_link");

      expect(baseLink?.urdfVizRep?.format).toBe("stl");
      // `scale="0.5 0.5 0.5"` on the <mesh> is parsed for the GraphicContext.
      expect(baseLink?.urdfVizRep?.scale).toEqual([0.5, 0.5, 0.5]);
      // .stl is binary -> read as an ArrayBuffer, not text. NOT `toBeInstanceOf(
      // ArrayBuffer)`: under jsdom the buffer is minted in Node's realm while the test's
      // `ArrayBuffer` global is jsdom's, so instanceof is false across the realm boundary
      // even though the value is correct. The brand check is realm-independent.
      expect(Object.prototype.toString.call(baseLink?.urdfVizRep?.data)).toBe("[object ArrayBuffer]");

      // forearm_link has no <visual>, so it gets no mesh.
      expect(linkInstances.find((l) => l.urdfRef?.name === "forearm_link")?.urdfVizRep).toBeUndefined();
    });

    it("caches each mesh read once per import and clears on demand", async () => {
      const entries = makeZipEntries({ "robot/urdf/arm.urdf": FIXTURE_URDF, "meshes/base.stl": "STL" });
      const spy = vi.spyOn(entries["meshes/base.stl"], "arrayBuffer");

      await algorithms.processZipUrdf(algorithms.createZipIndex(entries));
      expect(spy).toHaveBeenCalledTimes(1);
      expect(algorithms.meshCache.size).toBe(1);

      // A second import of the same archive re-uses the cache rather than re-reading.
      await algorithms.processZipUrdf(algorithms.createZipIndex(entries));
      expect(spy).toHaveBeenCalledTimes(1);

      algorithms.meshCache.clear();
      await algorithms.processZipUrdf(algorithms.createZipIndex(entries));
      expect(spy).toHaveBeenCalledTimes(2);
    });

    it("prefers a URDF inside a /urdf/ directory over one elsewhere", async () => {
      // The decoy's single link is named differently, so the robot key tells us which
      // of the two archives' URDFs was actually parsed.
      const decoy = `<?xml version="1.0"?><robot name="decoy"><link name="decoy_link"/></robot>`;
      await algorithms.processZipUrdf(
        algorithms.createZipIndex(makeZipEntries({ "top.urdf": decoy, "robot/urdf/arm.urdf": FIXTURE_URDF })),
      );

      expect(mocks.urdfPoseService.registerRobot.mock.calls[0][0]).toBe("base_link");
      expect(mocks.instanceCreationHandler.createClassInstance).toHaveBeenCalledTimes(3);
    });

    it("falls back to a .urdf outside /urdf/ when that is all there is", async () => {
      const decoy = `<?xml version="1.0"?><robot name="decoy"><link name="decoy_link"/></robot>`;
      await algorithms.processZipUrdf(algorithms.createZipIndex(makeZipEntries({ "top.urdf": decoy })));

      expect(mocks.urdfPoseService.registerRobot.mock.calls[0][0]).toBe("decoy_link");
    });

    it("draws the new instances and reports a parse failure without throwing", async () => {
      await algorithms.processZipUrdf(
        algorithms.createZipIndex(makeZipEntries({ "robot/urdf/arm.urdf": FIXTURE_URDF })),
      );
      expect(mocks.persistencyHandler.checkIfClassinstanceInScene).toHaveBeenCalledTimes(1);

      vi.clearAllMocks();
      mocks.metaUtility.getTabContextSceneType.mockResolvedValue(undefined);

      await expect(
        algorithms.processZipUrdf(algorithms.createZipIndex(makeZipEntries({ "a.urdf": FIXTURE_URDF }))),
      ).resolves.toBeUndefined();
      expect(mocks.logger.log).toHaveBeenCalledWith("No scene type in current tab context", "error");
    });
  });
});
