// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest";
import * as THREE from "three";

/**
 * The in-AR procedure menu: the A / X button opens a floating 3D list of the
 * procedures assigned to the open scene type, and a trigger press while it is open
 * runs the row the pointer ray is on (`procedureUtility.execute("", name)`), then
 * announces an undo step + a vizRep refresh over the event bus.
 *
 * global-definition, procedure-utility, event-bus and logger are faked; troika's
 * `Text` runs for real (it degrades to a warning without a GPU, as in the other
 * engine tests).
 */
const camera = new THREE.PerspectiveCamera();
camera.updateMatrixWorld(true);

const fakeGlobal = vi.hoisted(() => ({
  globalObject: {
    scene: null as unknown,
    selectedTab: 0,
    tabContext: [{}] as unknown[],
    renderer: { xr: { getSession: () => null, getCamera: () => camera } },
  },
}));
vi.mock("@/engine/global-definition", () => fakeGlobal);

const mocks = vi.hoisted(() => ({
  procedureUtility: {
    getAssignedProcedures: vi.fn(async () => [{ name: "Layout" }, { name: "Colourise" }]),
    execute: vi.fn(async () => {}),
  },
  eventBus: { publish: vi.fn() },
}));
vi.mock("@/resources/services/procedure-utility", () => ({ procedureUtility: mocks.procedureUtility }));
vi.mock("@/resources/services/event-bus", () => ({ eventBus: mocks.eventBus }));
vi.mock("@/resources/services/logger", () => ({ logger: { log: vi.fn() } }));

const { arProcedureMenu } = await import("@/engine/ar-procedure-menu");

type Internal = { rows: THREE.Mesh[]; group: THREE.Group };
const internal = arProcedureMenu as unknown as Internal;

/** A controller Object3D whose local -Z ray points straight at a world point. */
function controllerAimedAt(target: THREE.Vector3): THREE.Object3D {
  const controller = new THREE.Object3D();
  controller.position.set(target.x, target.y, target.z + 0.3);
  controller.updateMatrixWorld(true);
  return controller;
}

describe("ArProcedureMenu", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.procedureUtility.getAssignedProcedures.mockResolvedValue([{ name: "Layout" }, { name: "Colourise" }]);
    fakeGlobal.globalObject.scene = new THREE.Scene();
    fakeGlobal.globalObject.tabContext = [{}];
    arProcedureMenu.hide();
  });

  it("opens with one row per assigned procedure and toggles shut", async () => {
    await arProcedureMenu.toggle();

    expect(arProcedureMenu.open).toBe(true);
    expect(internal.rows.map((r) => r.userData.procedureName)).toEqual(["Layout", "Colourise"]);
    expect(internal.group.visible).toBe(true);

    await arProcedureMenu.toggle();
    expect(arProcedureMenu.open).toBe(false);
    expect(internal.group.visible).toBe(false);
  });

  it("runs the procedure under the pointer ray and closes", async () => {
    await arProcedureMenu.toggle();

    const rowWorld = new THREE.Vector3();
    internal.rows[1].getWorldPosition(rowWorld);
    arProcedureMenu.handleSelect(controllerAimedAt(rowWorld));

    await Promise.resolve();
    await Promise.resolve();

    expect(mocks.procedureUtility.execute).toHaveBeenCalledWith("", "Colourise");
    expect(mocks.eventBus.publish).toHaveBeenCalledWith("historyRecord", { label: "algorithm Colourise" });
    expect(mocks.eventBus.publish).toHaveBeenCalledWith("checkForVizRepUpdate");
    expect(arProcedureMenu.open).toBe(false);
  });

  it("ignores a trigger that is not pointing at any row", async () => {
    await arProcedureMenu.toggle();
    arProcedureMenu.handleSelect(controllerAimedAt(new THREE.Vector3(5, 5, 5)));

    expect(mocks.procedureUtility.execute).not.toHaveBeenCalled();
    expect(arProcedureMenu.open).toBe(true);
  });

  it("raycastRows returns nothing while the menu is closed", () => {
    expect(arProcedureMenu.raycastRows(controllerAimedAt(new THREE.Vector3(0, 0, -0.6)))).toBeUndefined();
  });

  it("still opens (with no rows) when the scene type has no assigned procedures", async () => {
    mocks.procedureUtility.getAssignedProcedures.mockResolvedValue([]);
    await arProcedureMenu.toggle();

    expect(arProcedureMenu.open).toBe(true);
    expect(internal.rows).toHaveLength(0);
  });
});
