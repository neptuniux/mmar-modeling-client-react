// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest";
import * as THREE from "three";

/**
 * The two-handed canvas grab: holding BOTH controller triggers grabs the whole
 * "canvas" (the world-origin offset) so it follows the controllers — translating
 * with their midpoint and turning about it — until a trigger is released, at which
 * point the offset is persisted.
 *
 * global-definition / animator / logger are faked (the real ones pull in a
 * WebGLRenderer and the whole engine graph). `applyOriginOffset` is inert here
 * because no `baseReferenceSpace` is set, so the test asserts on the persisted
 * offset that `endCanvasDrag` writes to localStorage.
 */
const fakeGlobal = vi.hoisted(() => ({
  globalObject: {
    dragObjects: [] as THREE.Object3D[],
    renderer: { xr: { isPresenting: false, getReferenceSpace: () => null, setReferenceSpace: vi.fn() } },
  },
}));
vi.mock("@/engine/global-definition", () => fakeGlobal);
vi.mock("@/engine/animator", () => ({ animator: { animate: vi.fn() } }));
vi.mock("@/resources/services/logger", () => ({ logger: { log: vi.fn() } }));

const { arInitiator } = await import("@/engine/ar-initiator");

const STORAGE_KEY = "mmar.ar.originOffset";

function persistedOffset() {
  const raw = window.localStorage.getItem(STORAGE_KEY);
  return raw ? (JSON.parse(raw) as { x: number; y: number; z: number; yaw: number }) : null;
}

function placeController(c: THREE.Object3D, x: number, y: number, z: number) {
  c.position.set(x, y, z);
  c.updateMatrixWorld(true);
}

describe("ArInitiator — two-handed canvas grab", () => {
  let c1: THREE.Object3D;
  let c2: THREE.Object3D;

  beforeEach(() => {
    window.localStorage.clear();
    c1 = new THREE.Object3D();
    c2 = new THREE.Object3D();
    c1.userData = {};
    c2.userData = {};
    arInitiator.controller1 = c1;
    arInitiator.controller2 = c2;
    // @ts-expect-error reset private drag state between tests
    arInitiator.twoHandDrag = null;
    // @ts-expect-error the offset matrix is private
    arInitiator.originOffsetMatrix.identity();
  });

  const step = () => (arInitiator as unknown as { updateCanvasDrag: () => void }).updateCanvasDrag();

  it("does not start a grab while only one trigger is held", () => {
    placeController(c1, -0.3, 0, 0);
    placeController(c2, 0.3, 0, 0);

    arInitiator.onSelectStart(c1);

    expect((arInitiator as unknown as { twoHandDrag: unknown }).twoHandDrag).toBeNull();
  });

  it("translates the canvas by the controllers' shared motion", () => {
    placeController(c1, -0.3, 0, 0);
    placeController(c2, 0.3, 0, 0);

    arInitiator.onSelectStart(c1);
    arInitiator.onSelectStart(c2); // both triggers -> grab starts
    expect((arInitiator as unknown as { twoHandDrag: unknown }).twoHandDrag).not.toBeNull();

    // Both hands move +1 on X, +0.5 on Y.
    placeController(c1, 0.7, 0.5, 0);
    placeController(c2, 1.3, 0.5, 0);
    step();

    arInitiator.onSelectEnd(c1); // release -> persist

    const offset = persistedOffset();
    expect(offset).not.toBeNull();
    expect(offset!.x).toBeCloseTo(1, 2);
    expect(offset!.y).toBeCloseTo(0.5, 2);
    expect(offset!.yaw).toBeCloseTo(0, 3);
    expect((arInitiator as unknown as { twoHandDrag: unknown }).twoHandDrag).toBeNull();
  });

  it("turns the canvas about the controllers' midpoint when they rotate", () => {
    // Start: controllers spread along X (midpoint at origin).
    placeController(c1, -0.3, 0, 0);
    placeController(c2, 0.3, 0, 0);
    arInitiator.onSelectStart(c1);
    arInitiator.onSelectStart(c2);

    // Rotate the pair 90° about vertical: now spread along Z, same midpoint.
    placeController(c1, 0, 0, -0.3);
    placeController(c2, 0, 0, 0.3);
    step();

    arInitiator.onSelectEnd(c2);

    const offset = persistedOffset();
    expect(offset).not.toBeNull();
    expect(Math.abs(offset!.x)).toBeLessThan(0.05);
    expect(Math.abs(offset!.z)).toBeLessThan(0.05);
    expect(Math.abs(offset!.yaw)).toBeCloseTo(Math.PI / 2, 2);
  });

  it("releasing either trigger ends the grab", () => {
    placeController(c1, -0.3, 0, 0);
    placeController(c2, 0.3, 0, 0);
    arInitiator.onSelectStart(c1);
    arInitiator.onSelectStart(c2);

    arInitiator.onSelectEnd(c1);
    expect((arInitiator as unknown as { twoHandDrag: unknown }).twoHandDrag).toBeNull();

    // A later release of the other trigger is a harmless no-op.
    expect(() => arInitiator.onSelectEnd(c2)).not.toThrow();
  });
});
