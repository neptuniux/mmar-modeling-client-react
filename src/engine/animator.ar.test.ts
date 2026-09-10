import { describe, it, expect, beforeEach, vi } from "vitest";
import * as THREE from "three";

/**
 * The animator's normal-camera block (move detection → relation re-routing) is gated
 * by `camera == normalCamera`, so in an AR session it never ran: an object grabbed
 * with a controller moved, but its relation lines stayed put. `updateMovedObjectsInAr`
 * closes that gap. These tests pin the gate — a moved draggable re-routes every line,
 * a still scene does not — and that grabbing (reparenting under the controller, which
 * freezes `element.position`) is still detected because world position is compared.
 *
 * global-definition is faked (importing it for real builds a WebGLRenderer at module
 * scope); every collaborator the animator imports is stubbed to a no-op.
 */
const fakeGlobal = vi.hoisted(() => ({
  globalObject: {
    camera: null as unknown,
    ARCamera: { isARCamera: true } as unknown,
    normalCamera: { isNormalCamera: true } as unknown,
    render: false,
    runMechanism: false,
    objectScaled: false,
    tabContext: [] as unknown[],
    selectedTab: 0,
    dragObjects: [] as THREE.Object3D[],
    updateLinesArray: [] as unknown[],
    allPositions: [] as number[],
    renderer: { render: vi.fn() },
  },
}));
vi.mock("@/engine/global-definition", () => fakeGlobal);

const stubs = vi.hoisted(() => ({
  globalStateObject: { activeStateLine: false },
  rayHelper: {},
  mechanismUtility: { executeAllMechanisms: vi.fn() },
  coordinatesUpdater: {
    updateCoordinates2DonClassAndPortInstance: vi.fn(),
    updateRotationOnClassAndPortInstance: vi.fn(),
    updateScaleOnClassAndPortInstance: vi.fn(),
  },
  remoteSelectionRenderer: { refreshBoxes: vi.fn() },
  remoteCursorRenderer: { refreshCursors: vi.fn() },
  instanceUtility: { getTabContextSceneInstance: vi.fn() },
}));
vi.mock("@/engine/global-state-object", () => ({ globalStateObject: stubs.globalStateObject }));
vi.mock("@/engine/ray-helper", () => ({ rayHelper: stubs.rayHelper }));
vi.mock("@/resources/services/mechanism-utility", () => ({ mechanismUtility: stubs.mechanismUtility }));
vi.mock("@/engine/coordinates-updater", () => ({ coordinatesUpdater: stubs.coordinatesUpdater }));
vi.mock("@/resources/collaboration/remote-selection-renderer", () => ({ remoteSelectionRenderer: stubs.remoteSelectionRenderer }));
vi.mock("@/resources/collaboration/remote-cursor-renderer", () => ({ remoteCursorRenderer: stubs.remoteCursorRenderer }));
vi.mock("@/resources/services/instance-utility", () => ({ instanceUtility: stubs.instanceUtility }));

const { animator } = await import("@/engine/animator");

function fakeLine(relObjCount: number) {
  return { userData: { relObj: new Array(relObjCount).fill({}) } };
}

describe("animator — AR relation following", () => {
  beforeEach(() => {
    const g = fakeGlobal.globalObject;
    g.camera = g.ARCamera;
    g.render = false;
    g.objectScaled = false;
    g.tabContext = [{}];
    g.dragObjects = [];
    g.updateLinesArray = [];
    g.allPositions = [];
    stubs.globalStateObject.activeStateLine = false;
    // @ts-expect-error reset the private AR snapshot between tests
    animator.arLastWorldPositions = [];
    vi.spyOn(animator, "setPos").mockResolvedValue(undefined);
  });

  it("re-routes every relation line when a draggable object has moved", async () => {
    const obj = new THREE.Object3D();
    obj.position.set(0, 0, 0);
    fakeGlobal.globalObject.dragObjects = [obj];
    fakeGlobal.globalObject.updateLinesArray = [fakeLine(2), fakeLine(2)];

    // First frame seeds the snapshot.
    await animator.animate();
    (animator.setPos as ReturnType<typeof vi.fn>).mockClear();

    // Object moves in world space (as it would while grabbed).
    obj.position.set(1, 0.5, 0);
    await animator.animate();

    expect(animator.setPos).toHaveBeenCalledTimes(2);
  });

  it("does not re-route lines when nothing moved", async () => {
    const obj = new THREE.Object3D();
    fakeGlobal.globalObject.dragObjects = [obj];
    fakeGlobal.globalObject.updateLinesArray = [fakeLine(2)];

    await animator.animate();
    (animator.setPos as ReturnType<typeof vi.fn>).mockClear();
    await animator.animate();

    expect(animator.setPos).not.toHaveBeenCalled();
  });

  it("detects a grabbed object by world position even when its local position is frozen", async () => {
    // Simulate controller.attach: the object is a child of a moving parent, and its
    // own local position never changes.
    const controller = new THREE.Object3D();
    const obj = new THREE.Object3D();
    controller.add(obj);
    obj.position.set(0, 0, 0);
    fakeGlobal.globalObject.dragObjects = [obj];
    fakeGlobal.globalObject.updateLinesArray = [fakeLine(2)];

    await animator.animate();
    (animator.setPos as ReturnType<typeof vi.fn>).mockClear();

    controller.position.set(2, 0, 0); // hand moves; obj.position stays (0,0,0)
    await animator.animate();

    expect(animator.setPos).toHaveBeenCalledTimes(1);
  });

  it("skips the AR path entirely when there is no tab context", async () => {
    fakeGlobal.globalObject.tabContext = [];
    const obj = new THREE.Object3D();
    fakeGlobal.globalObject.dragObjects = [obj];
    fakeGlobal.globalObject.updateLinesArray = [fakeLine(2)];

    await animator.animate();
    obj.position.set(5, 5, 5);
    await animator.animate();

    expect(animator.setPos).not.toHaveBeenCalled();
  });
});
