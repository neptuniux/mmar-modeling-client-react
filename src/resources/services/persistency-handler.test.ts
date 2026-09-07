// @vitest-environment jsdom
//
// P7 unit tests for persistency-handler (plan §7: persist path + saveToTextfile).
// The handler reads the engine god object + several sibling services; importing the
// real ones would build a WebGLRenderer at module scope, so every engine module and
// service it depends on is replaced with a light fake. event-bus + logger stay real
// (pure). gds SceneInstance fixtures stay REAL (built via fromJS) so instanceof holds.
import { describe, it, expect, beforeEach, vi } from "vitest";
import { SceneInstance } from "@gds";

const mocks = vi.hoisted(() => ({
  globalObject: {} as any,
  globalStateObject: {} as any,
  graphicContext: { resetInstance: vi.fn() } as any,
  metaUtility: { getTabContextSceneType: vi.fn() } as any,
  instanceUtility: {
    getTabContextSceneInstance: vi.fn(),
    getAllOpenSceneInstances: vi.fn(),
    getAllPortInstancesOfTabContext: vi.fn(async () => []),
  } as any,
  snapshotService: {
    setSceneInstanceSnapshot: vi.fn(),
    restoreSceneInstanceToCurrentTab: vi.fn(),
  } as any,
  backendService: {
    sceneInstancesPATCH: vi.fn(),
    sceneInstancesPOST: vi.fn(),
  } as any,
  instanceCreationHandler: {
    createMissingSceneAttributeInstances: vi.fn(async () => []),
  } as any,
  urdfPersistence: {
    persistSceneAssets: vi.fn(async () => undefined),
    restoreRobots: vi.fn(async () => undefined),
    hydrateMesh: vi.fn(async () => undefined),
  } as any,
}));

vi.mock("@/engine/global-definition", () => ({ globalObject: mocks.globalObject }));
vi.mock("@/engine/global-state-object", () => ({ globalStateObject: mocks.globalStateObject }));
vi.mock("@/engine/graphic-context", () => ({
  GraphicContext: class {},
  graphicContext: mocks.graphicContext,
}));
vi.mock("@/engine/instance-creation-handler", () => ({
  instanceCreationHandler: mocks.instanceCreationHandler,
}));
vi.mock("./meta-utility", () => ({ metaUtility: mocks.metaUtility }));
vi.mock("./instance-utility", () => ({ instanceUtility: mocks.instanceUtility }));
vi.mock("./snapshot-service", () => ({ snapshotService: mocks.snapshotService }));
vi.mock("./backend-service", () => ({ backendService: mocks.backendService }));
vi.mock("@/engine/hybrid-algorithms/urdf-persistence", () => mocks.urdfPersistence);

import { persistencyHandler } from "./persistency-handler";
import { useLogStore } from "@/resources/store/logStore";
import { NOT_ALLOWED_MESSAGE } from "./metamodel-constraints";

function makeScene(uuid: string, name: string): SceneInstance {
  return SceneInstance.fromJS({
    uuid,
    name,
    uuid_scene_type: "st-1",
    class_instances: [],
    relationclasses_instances: [],
    role_instances: [],
    attribute_instances: [],
    port_instances: [],
  }) as SceneInstance;
}

beforeEach(() => {
  vi.clearAllMocks();
  Object.assign(mocks.globalObject, {
    selectedTab: 0,
    tabContext: [{}],
    autoSave: true,
  });
  useLogStore.setState({ logArray: [], snackbar: { open: false, message: "", severity: "info" } });
});

describe("persistency-handler.persistSceneInstanceToDB", () => {
  it("PATCHes the active scene instance and snapshots it", async () => {
    const scene = makeScene("s-1", "Scene 1");
    mocks.instanceUtility.getTabContextSceneInstance.mockResolvedValue(scene);
    mocks.metaUtility.getTabContextSceneType.mockResolvedValue({ uuid: "st-1" });
    mocks.backendService.sceneInstancesPATCH.mockResolvedValue(scene);

    await persistencyHandler.persistSceneInstanceToDB();

    expect(mocks.backendService.sceneInstancesPATCH).toHaveBeenCalledWith("s-1", scene);
    expect(mocks.snapshotService.setSceneInstanceSnapshot).toHaveBeenCalledWith(scene);
    expect(mocks.backendService.sceneInstancesPOST).not.toHaveBeenCalled();
  });

  it("creates a freshly-created scene with a single PATCH (server upsert, no POST fallback)", async () => {
    // The server PATCH is an upsert, so the first save of a new scene succeeds with a
    // single PATCH — no PATCH -> 404 -> POST dance. POST must never be called.
    const scene = makeScene("s-new", "Second Scene");
    mocks.instanceUtility.getTabContextSceneInstance.mockResolvedValue(scene);
    mocks.metaUtility.getTabContextSceneType.mockResolvedValue({ uuid: "st-1" });
    mocks.backendService.sceneInstancesPATCH.mockResolvedValue(scene);

    await persistencyHandler.persistSceneInstanceToDB();

    expect(mocks.backendService.sceneInstancesPATCH).toHaveBeenCalledWith("s-new", scene);
    expect(mocks.backendService.sceneInstancesPOST).not.toHaveBeenCalled();
    expect(mocks.snapshotService.setSceneInstanceSnapshot).toHaveBeenCalledWith(scene);
  });

  it("reverts to the last snapshot when PATCH is rejected with 403 (read-only shared scene)", async () => {
    const scene = makeScene("s-3", "Shared Scene");
    mocks.instanceUtility.getTabContextSceneInstance.mockResolvedValue(scene);
    mocks.metaUtility.getTabContextSceneType.mockResolvedValue({ uuid: "st-1" });
    mocks.backendService.sceneInstancesPATCH.mockRejectedValue(
      Object.assign(new Error("You are not authorized to update this scene instance"), { status: 403 }),
    );
    const alertSpy = vi.spyOn(window, "alert").mockImplementation(() => undefined);

    await persistencyHandler.persistSceneInstanceToDB();

    expect(mocks.backendService.sceneInstancesPOST).not.toHaveBeenCalled();
    expect(mocks.snapshotService.restoreSceneInstanceToCurrentTab).toHaveBeenCalled();
    expect(mocks.snapshotService.setSceneInstanceSnapshot).not.toHaveBeenCalled();
    // Reported through the snackbar; the blocking window.alert is gone.
    expect(alertSpy).not.toHaveBeenCalled();
    expect(useLogStore.getState().snackbar.message).toContain("authorization");

    alertSpy.mockRestore();
  });

  // The rule engine answers a broken metamodel rule with the SAME 403 as a missing
  // access right, so the message is what tells them apart. Saying "not authorized" for
  // a value that simply does not match its attribute type's regex sent users looking
  // for a permissions problem that was not there.
  it("reports a refused metamodel rule as such, not as an authorization problem", async () => {
    const scene = makeScene("s-4", "My Scene");
    mocks.instanceUtility.getTabContextSceneInstance.mockResolvedValue(scene);
    mocks.metaUtility.getTabContextSceneType.mockResolvedValue({ uuid: "st-1" });
    mocks.backendService.sceneInstancesPATCH.mockRejectedValue(
      Object.assign(
        new Error("The rule error was fired for the attribute ai-1: abc does not match the regex /^[0-9]+$/gmi"),
        { status: 403 },
      ),
    );

    await persistencyHandler.persistSceneInstanceToDB();

    expect(useLogStore.getState().snackbar.message).toBe(NOT_ALLOWED_MESSAGE);
    expect(mocks.snapshotService.restoreSceneInstanceToCurrentTab).toHaveBeenCalled();
    // The server's own wording is kept for the log window.
    expect(useLogStore.getState().logArray.some((entry) => entry.value.includes("does not match the regex"))).toBe(true);
  });

  // An imported robot's meshes and URDF live outside the scene payload, in the file
  // store, and the uuids that point at them are written onto the scene here. Uploading
  // AFTER the PATCH would save a scene that references files it does not have yet.
  it("stores the robot's files before the scene that references them", async () => {
    const scene = makeScene("s-robot", "Robot Scene");
    mocks.instanceUtility.getTabContextSceneInstance.mockResolvedValue(scene);
    mocks.metaUtility.getTabContextSceneType.mockResolvedValue({ uuid: "st-1" });
    mocks.backendService.sceneInstancesPATCH.mockResolvedValue(scene);

    await persistencyHandler.persistSceneInstanceToDB();

    expect(mocks.urdfPersistence.persistSceneAssets).toHaveBeenCalledWith(scene);
    expect(mocks.urdfPersistence.persistSceneAssets.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.backendService.sceneInstancesPATCH.mock.invocationCallOrder[0],
    );
  });

  it("still saves the scene when the robot's files cannot be stored", async () => {
    const scene = makeScene("s-robot", "Robot Scene");
    mocks.instanceUtility.getTabContextSceneInstance.mockResolvedValue(scene);
    mocks.metaUtility.getTabContextSceneType.mockResolvedValue({ uuid: "st-1" });
    mocks.backendService.sceneInstancesPATCH.mockResolvedValue(scene);
    mocks.urdfPersistence.persistSceneAssets.mockRejectedValueOnce(new Error("file store down"));

    await persistencyHandler.persistSceneInstanceToDB();

    expect(mocks.backendService.sceneInstancesPATCH).toHaveBeenCalledWith("s-robot", scene);
  });

  it("logs and skips when there is no active scene instance", async () => {
    mocks.instanceUtility.getTabContextSceneInstance.mockResolvedValue(undefined);

    await persistencyHandler.persistSceneInstanceToDB();

    expect(mocks.backendService.sceneInstancesPATCH).not.toHaveBeenCalled();
    expect(mocks.snapshotService.setSceneInstanceSnapshot).not.toHaveBeenCalled();
  });
});

describe("persistency-handler.loadPersistedModel", () => {
  // A scene saved before scene-type attributes were instantiated has none, so loading
  // one is where the missing ones get created — that is what puts a model's own
  // attributes in the attribute window for existing scenes.
  it("instantiates the scene type's missing attributes for the loaded scene", async () => {
    const scene = makeScene("s-3", "Scene 3");
    mocks.instanceUtility.getTabContextSceneInstance.mockResolvedValue(scene);

    await persistencyHandler.loadPersistedModel(scene);

    expect(mocks.instanceCreationHandler.createMissingSceneAttributeInstances).toHaveBeenCalledWith(scene);
  });

  // Without this a reopened robotic scene draws its robot but cannot move it: the pose
  // service and the simulation sliders both need a parsed URDF behind the instances.
  it("re-registers the robots a saved robotic scene points at", async () => {
    const scene = makeScene("s-robot", "Robot Scene");
    mocks.instanceUtility.getTabContextSceneInstance.mockResolvedValue(scene);

    await persistencyHandler.loadPersistedModel(scene);

    expect(mocks.urdfPersistence.restoreRobots).toHaveBeenCalledWith(scene);
  });

  it("still loads the scene when a robot cannot be restored", async () => {
    const scene = makeScene("s-robot", "Robot Scene");
    mocks.instanceUtility.getTabContextSceneInstance.mockResolvedValue(scene);
    mocks.urdfPersistence.restoreRobots.mockRejectedValueOnce(new Error("urdf gone"));

    await expect(persistencyHandler.loadPersistedModel(scene)).resolves.toBeUndefined();
    expect(mocks.instanceCreationHandler.createMissingSceneAttributeInstances).toHaveBeenCalled();
  });

  it("still loads the scene when the attribute instantiation fails", async () => {
    const scene = makeScene("s-4", "Scene 4");
    mocks.instanceUtility.getTabContextSceneInstance.mockResolvedValue(scene);
    mocks.instanceCreationHandler.createMissingSceneAttributeInstances.mockRejectedValueOnce(
      new Error("boom"),
    );

    await expect(persistencyHandler.loadPersistedModel(scene)).resolves.toBeUndefined();
  });
});

describe("persistency-handler.saveToTextfile", () => {
  it("serialises the active scene to a downloadable JSON blob", async () => {
    const scene = makeScene("s-2", "MyScene");
    mocks.instanceUtility.getTabContextSceneInstance.mockResolvedValue(scene);
    mocks.globalObject.tabContext = [{}];

    const createObjectURL = vi.fn((blob: Blob) => `blob:${blob.size}`);
    const revokeObjectURL = vi.fn();
    (window.URL as any).createObjectURL = createObjectURL;
    (window.URL as any).revokeObjectURL = revokeObjectURL;
    const clickSpy = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(() => undefined);

    await persistencyHandler.saveToTextfile();

    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(createObjectURL.mock.calls[0][0]).toBeInstanceOf(Blob);
    expect(clickSpy).toHaveBeenCalledTimes(1);

    clickSpy.mockRestore();
  });

  it("does nothing when no tab is open", async () => {
    mocks.globalObject.tabContext = [];
    const createObjectURL = vi.fn(() => "blob:mock");
    (window.URL as any).createObjectURL = createObjectURL;

    await persistencyHandler.saveToTextfile();

    expect(createObjectURL).not.toHaveBeenCalled();
  });
});
