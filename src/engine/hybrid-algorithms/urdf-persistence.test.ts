// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest";
import type { ClassInstance, SceneInstance } from "@gds";

/**
 * The save/reload round trip of an imported robot — what used to be lost entirely,
 * because neither the mesh nor the URDF linkage is a gds field.
 *
 * The file store and the pose service are mocked (both are covered by their own tests);
 * what is asserted here is that a save moves the bulk OUT of the scene and leaves a
 * reference IN it, and that a reload turns that reference back into a drawable mesh and
 * a registered robot.
 *
 * jsdom is REQUIRED: `File`/`Blob` are used for the upload and read back, and
 * `URDFLoader.parse()` needs DOMParser.
 */

const mocks = vi.hoisted(() => ({
  backendService: {
    postFile: vi.fn(async (_file: File): Promise<unknown> => ({ uuid: "file-uuid" })),
    getFileByUUID: vi.fn(async (_uuid: string): Promise<File | undefined> => undefined),
  },
  metaUtility: {
    Files: new Map<string, [File, string]>(),
    setFile: vi.fn(async (_uuid: string, _file: File) => undefined),
  },
  urdfPoseService: { registerRobot: vi.fn() },
  logger: { log: vi.fn() },
}));
vi.mock("@/resources/services/backend-service", () => ({ backendService: mocks.backendService }));
vi.mock("@/resources/services/meta-utility", () => ({ metaUtility: mocks.metaUtility }));
vi.mock("@/engine/hybrid-algorithms/urdf-pose-service", () => ({ urdfPoseService: mocks.urdfPoseService }));
vi.mock("@/resources/services/logger", () => ({ logger: mocks.logger }));

const {
  clearPendingUrdfSources,
  hydrateMesh,
  persistSceneAssets,
  readInstanceMeta,
  recordJointValue,
  rememberUrdfSource,
  restoreRobots,
  tagInstance,
} = await import("@/engine/hybrid-algorithms/urdf-persistence");

const FIXTURE_URDF = `<?xml version="1.0"?>
<robot name="test_arm">
  <link name="base_link"/>
  <link name="forearm_link"/>
  <joint name="shoulder_to_forearm" type="revolute">
    <parent link="base_link"/>
    <child link="forearm_link"/>
    <origin xyz="0 0 0.5" rpy="0 0 0"/>
    <axis xyz="0 0 1"/>
    <!-- urdf-loader clamps setJointValue() to the joint's limits, so a revolute joint
         without them is pinned at 0 and no replayed value would ever take. -->
    <limit lower="-1.5" upper="1.5" effort="10" velocity="2"/>
  </joint>
</robot>`;

type MeshedInstance = ClassInstance & {
  urdfVizRep?: { format: string; data: string | ArrayBuffer; scale: number[] };
  urdfRobotKey?: string;
  urdfRef?: { kind: string; name: string };
};

function makeInstance(uuid: string): MeshedInstance {
  return { uuid, custom_variables: {} } as unknown as MeshedInstance;
}

function makeScene(classInstances: ClassInstance[]): SceneInstance {
  return {
    uuid: "scene-uuid",
    custom_variables: {},
    class_instances: classInstances,
  } as unknown as SceneInstance;
}

describe("urdf-persistence", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.metaUtility.Files.clear();
    clearPendingUrdfSources();
    let counter = 0;
    mocks.backendService.postFile.mockImplementation(async () => ({ uuid: `file-${++counter}` }));
  });

  describe("persistSceneAssets", () => {
    it("uploads a link's mesh and leaves only its file reference on the instance", async () => {
      const link = makeInstance("link-1");
      tagInstance(link, { robotKey: "base_link", kind: "link", name: "base_link" });
      link.urdfVizRep = { format: "stl", data: new ArrayBuffer(8), scale: [0.5, 0.5, 0.5] };

      await persistSceneAssets(makeScene([link]));

      expect(mocks.backendService.postFile).toHaveBeenCalledTimes(1);
      expect(readInstanceMeta(link)?.mesh).toEqual({
        fileUuid: "file-1",
        format: "stl",
        scale: [0.5, 0.5, 0.5],
      });
      // The bytes themselves stay OUT of the instance: what the PATCH carries is the uuid.
      expect(JSON.stringify(link.custom_variables)).not.toContain("ArrayBuffer");
    });

    it("uploads a shared mesh once, however many links reference it", async () => {
      // The import hands every link that resolves to the same mesh file the SAME
      // UrdfVizRep object (roboticsystem-algorithms caches by path), which is what makes
      // object identity the right key here.
      const shared = { format: "stl" as const, data: new ArrayBuffer(4), scale: [1, 1, 1] };
      const first = makeInstance("link-1");
      const second = makeInstance("link-2");
      for (const [index, link] of [first, second].entries()) {
        tagInstance(link, { robotKey: "r", kind: "link", name: `link_${index}` });
        link.urdfVizRep = shared;
      }

      await persistSceneAssets(makeScene([first, second]));

      expect(mocks.backendService.postFile).toHaveBeenCalledTimes(1);
      expect(readInstanceMeta(first)?.mesh?.fileUuid).toBe("file-1");
      expect(readInstanceMeta(second)?.mesh?.fileUuid).toBe("file-1");
    });

    it("does not re-upload a mesh that is already stored", async () => {
      const link = makeInstance("link-1");
      tagInstance(link, { robotKey: "r", kind: "link", name: "base_link" });
      link.urdfVizRep = { format: "stl", data: new ArrayBuffer(4), scale: [1, 1, 1] };

      const scene = makeScene([link]);
      await persistSceneAssets(scene);
      await persistSceneAssets(scene);

      expect(mocks.backendService.postFile).toHaveBeenCalledTimes(1);
    });

    it("uploads the imported URDF and references it on the scene", async () => {
      const scene = makeScene([]);
      rememberUrdfSource(scene.uuid, "base_link", FIXTURE_URDF);

      await persistSceneAssets(scene);

      const [uploaded] = mocks.backendService.postFile.mock.calls[0] as [File];
      expect(uploaded.name).toBe("base_link.urdf");
      expect((scene.custom_variables as Record<string, unknown>)["urdfRobots"]).toEqual([
        { robotKey: "base_link", fileUuid: "file-1" },
      ]);

      // A second save has nothing left to upload.
      await persistSceneAssets(scene);
      expect(mocks.backendService.postFile).toHaveBeenCalledTimes(1);
    });

    it("keeps the URDF pending and reports it when the upload fails", async () => {
      mocks.backendService.postFile.mockResolvedValueOnce(undefined);
      const scene = makeScene([]);
      rememberUrdfSource(scene.uuid, "base_link", FIXTURE_URDF);

      await persistSceneAssets(scene);
      expect((scene.custom_variables as Record<string, unknown>)["urdfRobots"]).toBeUndefined();
      expect(mocks.logger.log).toHaveBeenCalledWith(expect.stringContaining("base_link"), "error");

      // The next save tries again rather than dropping the robot's source on the floor.
      await persistSceneAssets(scene);
      expect((scene.custom_variables as Record<string, unknown>)["urdfRobots"]).toEqual([
        { robotKey: "base_link", fileUuid: "file-1" },
      ]);
    });
  });

  describe("hydrateMesh", () => {
    it("rebuilds a stored binary mesh from the file store and caches it on the instance", async () => {
      const link = makeInstance("link-1");
      (link.custom_variables as Record<string, unknown>)["urdf"] = {
        robotKey: "r",
        kind: "link",
        name: "base_link",
        mesh: { fileUuid: "file-9", format: "stl", scale: [2, 2, 2] },
      };
      mocks.backendService.getFileByUUID.mockResolvedValue(
        new File([new Uint8Array([1, 2, 3])], "base.stl", { type: "application/octet-stream" }),
      );

      const vizRep = await hydrateMesh(link);

      expect(vizRep?.format).toBe("stl");
      expect(vizRep?.scale).toEqual([2, 2, 2]);
      expect(new Uint8Array(vizRep!.data as ArrayBuffer)).toEqual(new Uint8Array([1, 2, 3]));
      // Stamped back on, so the second draw pass of the same scene costs no fetch.
      expect(link.urdfVizRep).toBe(vizRep);
      await hydrateMesh(link);
      expect(mocks.backendService.getFileByUUID).toHaveBeenCalledTimes(1);
    });

    it("reads a stored glTF as text", async () => {
      const link = makeInstance("link-1");
      (link.custom_variables as Record<string, unknown>)["urdf"] = {
        robotKey: "r",
        kind: "link",
        name: "base_link",
        mesh: { fileUuid: "file-9", format: "gltf", scale: [1, 1, 1] },
      };
      mocks.backendService.getFileByUUID.mockResolvedValue(
        new File(['{"asset":{}}'], "base.gltf", { type: "model/gltf+json" }),
      );

      expect((await hydrateMesh(link))?.data).toBe('{"asset":{}}');
    });

    it("returns the in-memory mesh untouched, and nothing at all for a plain instance", async () => {
      const imported = makeInstance("link-1");
      imported.urdfVizRep = { format: "stl", data: new ArrayBuffer(1), scale: [1, 1, 1] };
      expect(await hydrateMesh(imported)).toBe(imported.urdfVizRep);

      expect(await hydrateMesh(makeInstance("plain"))).toBeUndefined();
      expect(mocks.backendService.getFileByUUID).not.toHaveBeenCalled();
    });

    it("ignores a mesh-shaped value with no mesh in it and refetches", async () => {
      // What a JSON round trip makes of a binary mesh: `{}` where an ArrayBuffer was.
      // Drawing from that leaves the link with neither a URDF mesh nor a vizRep.
      const link = makeInstance("link-1");
      link.urdfVizRep = {} as unknown as { format: string; data: string; scale: number[] };
      (link.custom_variables as Record<string, unknown>)["urdf"] = {
        robotKey: "r",
        kind: "link",
        name: "base_link",
        mesh: { fileUuid: "file-9", format: "stl", scale: [1, 1, 1] },
      };
      mocks.backendService.getFileByUUID.mockResolvedValue(
        new File([new Uint8Array([7])], "base.stl", { type: "application/octet-stream" }),
      );

      expect((await hydrateMesh(link))?.format).toBe("stl");
    });
  });

  describe("restoreRobots", () => {
    it("re-parses the stored URDF and registers it with the scene's link and joint instances", async () => {
      const link = makeInstance("link-1");
      const joint = makeInstance("joint-1");
      tagInstance(link, { robotKey: "base_link", kind: "link", name: "base_link" });
      tagInstance(joint, { robotKey: "base_link", kind: "joint", name: "shoulder_to_forearm" });
      const scene = makeScene([link, joint]);
      (scene.custom_variables as Record<string, unknown>)["urdfRobots"] = [
        { robotKey: "base_link", fileUuid: "file-9" },
      ];
      mocks.backendService.getFileByUUID.mockResolvedValue(
        new File([FIXTURE_URDF], "base_link.urdf", { type: "text/xml" }),
      );

      await restoreRobots(scene);

      // The in-memory tags are back — the pose service and the table dialog steer by them.
      expect(link.urdfRobotKey).toBe("base_link");
      expect(joint.urdfRef).toEqual({ kind: "joint", name: "shoulder_to_forearm" });

      const [robotKey, robot, scaleFactor, links, joints] = mocks.urdfPoseService.registerRobot.mock
        .calls[0] as [string, { joints: Record<string, unknown> }, number, ClassInstance[], ClassInstance[]];
      expect(robotKey).toBe("base_link");
      expect(scaleFactor).toBe(1);
      expect(Object.keys(robot.joints)).toEqual(["shoulder_to_forearm"]);
      expect(links).toEqual([link]);
      expect(joints).toEqual([joint]);
    });

    // A saved robot is drawn at the pose the simulation left it in, but the URDF behind
    // it declares the REST pose. Registering the robot at rest makes the first slider
    // drag snap every link back there — the saved pose is on screen but not in the robot.
    it("replays the saved joint values onto the re-parsed robot", async () => {
      const joint = makeInstance("joint-1");
      tagInstance(joint, { robotKey: "base_link", kind: "joint", name: "shoulder_to_forearm" });
      recordJointValue(joint, 0.9);

      const scene = makeScene([joint]);
      (scene.custom_variables as Record<string, unknown>)["urdfRobots"] = [
        { robotKey: "base_link", fileUuid: "file-9" },
      ];
      mocks.backendService.getFileByUUID.mockResolvedValue(
        new File([FIXTURE_URDF], "base_link.urdf", { type: "text/xml" }),
      );

      await restoreRobots(scene);

      const [, robot] = mocks.urdfPoseService.registerRobot.mock.calls[0] as [
        string,
        { joints: Record<string, { jointValue: number | number[] }> },
      ];
      const restored = robot.joints["shoulder_to_forearm"].jointValue;
      expect(Array.isArray(restored) ? restored[0] : restored).toBeCloseTo(0.9);
    });

    it("records a joint value only for a joint that came from a URDF import", async () => {
      const link = makeInstance("link-1");
      tagInstance(link, { robotKey: "r", kind: "link", name: "base_link" });
      recordJointValue(link, 0.5);
      expect(readInstanceMeta(link)?.jointValue).toBeUndefined();

      const plain = makeInstance("plain");
      recordJointValue(plain, 0.5);
      expect(readInstanceMeta(plain)).toBeUndefined();
    });

    // A replaced import leaves its entry in the scene's list with no instances behind
    // it. Registering that would put a robot with no joints where the real one belongs.
    it("ignores a listed robot the scene has no instances for", async () => {
      const link = makeInstance("link-1");
      tagInstance(link, { robotKey: "link_base", kind: "link", name: "base_link" });
      const scene = makeScene([link]);
      (scene.custom_variables as Record<string, unknown>)["urdfRobots"] = [
        { robotKey: "dummy_link", fileUuid: "file-stale" },
        { robotKey: "link_base", fileUuid: "file-9" },
      ];
      mocks.backendService.getFileByUUID.mockResolvedValue(
        new File([FIXTURE_URDF], "base_link.urdf", { type: "text/xml" }),
      );

      await restoreRobots(scene);

      expect(mocks.urdfPoseService.registerRobot).toHaveBeenCalledTimes(1);
      expect(mocks.urdfPoseService.registerRobot.mock.calls[0][0]).toBe("link_base");
      expect(mocks.logger.log).toHaveBeenCalledWith(expect.stringContaining("dummy_link"), "info");
      // The stale entry costs no fetch either.
      expect(mocks.backendService.getFileByUUID).toHaveBeenCalledTimes(1);
    });

    it("reports a robot whose URDF is gone instead of failing the load", async () => {
      // The scene HAS instances for this robot — otherwise it is a phantom entry and is
      // skipped before the file is ever looked for, which is a different case.
      const link = makeInstance("link-1");
      tagInstance(link, { robotKey: "base_link", kind: "link", name: "base_link" });
      const scene = makeScene([link]);
      (scene.custom_variables as Record<string, unknown>)["urdfRobots"] = [
        { robotKey: "base_link", fileUuid: "file-9" },
      ];
      mocks.backendService.getFileByUUID.mockResolvedValue(undefined);

      await expect(restoreRobots(scene)).resolves.toBeUndefined();
      expect(mocks.urdfPoseService.registerRobot).not.toHaveBeenCalled();
      expect(mocks.logger.log).toHaveBeenCalledWith(expect.stringContaining("base_link"), "error");
    });

    it("does nothing for a scene that holds no robot", async () => {
      await restoreRobots(makeScene([makeInstance("plain")]));
      expect(mocks.backendService.getFileByUUID).not.toHaveBeenCalled();
      expect(mocks.urdfPoseService.registerRobot).not.toHaveBeenCalled();
    });
  });
});
