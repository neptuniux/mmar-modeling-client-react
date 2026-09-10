import * as THREE from "three";
import { XRControllerModelFactory } from "three/examples/jsm/webxr/XRControllerModelFactory.js";
import { OculusHandPointerModel } from "three/examples/jsm/webxr/OculusHandPointerModel.js";
import { XRHandModelFactory } from "three/examples/jsm/webxr/XRHandModelFactory.js";
import { FontLoader } from "three/examples/jsm/loaders/FontLoader.js";
import { TextGeometry } from "three/examples/jsm/geometries/TextGeometry.js";
import { globalObject } from "@/engine/global-definition";
import { animator } from "@/engine/animator";
import { logger } from "@/resources/services/logger";

/**
 * WebXR (AR / VR) support: session lifecycle, hand and controller models, grabbing
 * objects, recentering the world origin, and the world-origin axis marker.
 *
 * Input is wired on the two `getController(i)` objects, which raise `select*` for
 * both a physical controller's trigger and a tracked hand's pinch, plus `squeeze*`
 * for a physical controller's grip button. So both input modes work:
 *   - trigger / pinch on an object            → grab it
 *   - BOTH triggers / pinches held            → grab the whole canvas: it follows
 *     the two controllers (translation + yaw about their midpoint) until a trigger
 *     is released, then stays where it was left
 *   - grip button (controllers only)          → recenter the world origin here
 *   - trigger / pinch on empty space, held    → recenter the world origin here
 *     (the fallback for hand tracking, which has no grip button)
 *
 * Each controller carries a thin pointer ray with a reticle that snaps onto the
 * nearest grabbable object, so aiming with a physical controller is visible the way
 * the tracked-hand pointer already is.
 *
 * `enableXR()` is idempotent and is called from `engine.mount()` and when the XR entry
 * button is created, so a session started from either place runs through
 * `onSessionStarted` / `onSessionEnded`. Entering a session swaps the active camera to
 * `ARCamera`; leaving it swaps back.
 */

/** Font for the world-origin axis labels. Fetched on demand, only inside an XR session. */
const AXIS_LABEL_FONT_URL = "https://cdn.jsdelivr.net/gh/mrdoob/three.js/examples/fonts/helvetiker_regular.typeface.json";

/** localStorage key for the persisted AR world-origin offset (see {@link ArInitiator.setOrigin}). */
const ORIGIN_OFFSET_STORAGE_KEY = "mmar.ar.originOffset";

/**
 * How long a trigger / pinch on empty space must be held (ms) before it recenters
 * the world origin. Only this gesture uses the hold — the grip button is instant.
 */
const RECENTER_HOLD_MS = 1200;

/** Length (metres) of a controller's pointer ray while it is not hitting anything. */
const POINTER_RAY_LENGTH = 1.5;
/** Pointer ray / reticle colours: white while pointing at nothing, yellow on a hit. */
const POINTER_IDLE_COLOR = 0xffffff;
const POINTER_HIT_COLOR = 0xffe14d;

/**
 * Below this horizontal gap (metres) between the two controllers, the two-handed
 * canvas grab stops updating yaw — the direction between two near-coincident points
 * is too noisy to rotate by. Translation keeps tracking.
 */
const MIN_TWO_HAND_SEPARATION = 0.08;

const UP = new THREE.Vector3(0, 1, 0);
const ONE = new THREE.Vector3(1, 1, 1);

export class ArInitiator {
  controller1: any;
  controller2: any;
  controllerGrip1: any;
  hand1: any;
  controllerGrip2: any;
  hand2: any;
  handPointer1: any;
  handPointer2: any;

  raycaster = new THREE.Raycaster();
  tempMatrix = new THREE.Matrix4();

  xrSession: any = null;
  xrReferenceSpace: any = null;

  /**
   * The unmodified reference space the current XR session was granted, captured on
   * `sessionstart`. Every recenter is composed from this so the offset never drifts
   * with repeated calibration, and so `resetOrigin()` can restore it exactly.
   */
  private baseReferenceSpace: XRReferenceSpace | null = null;

  /**
   * The world-origin offset as a rigid transform (translation + yaw) that maps a
   * point in the *current* (offset) reference space back into `baseReferenceSpace`.
   * Identity means the graph origin sits on the headset's own origin. Source of
   * truth for both {@link applyOriginOffset} and persistence.
   */
  private originOffsetMatrix = new THREE.Matrix4();

  /**
   * Live state of the two-handed canvas grab (both triggers held), or null when it
   * is not active. `originStart` / `handStart` are the origin offset and the
   * midpoint-between-controllers frame (both in base space) captured when the grab
   * began; each frame the canvas is moved by however far that frame has travelled
   * since. `lastYaw` carries the last usable yaw across frames where the controllers
   * are too close together to derive one; `yawAnchored` is whether `handStart`'s yaw
   * has been set from a trustworthy (well-separated) reading yet.
   */
  private twoHandDrag: { originStart: THREE.Matrix4; handStart: THREE.Matrix4; lastYaw: number; yawAnchored: boolean } | null = null;

  private xrListenersRegistered = false;

  private globalObjectInstance = globalObject;
  private animator = animator;
  private logger = logger;

  /** Turn WebXR on and wire the session lifecycle. Idempotent. */
  enableXR() {
    const renderer = this.globalObjectInstance.renderer;
    renderer.xr.enabled = true;
    if (!this.xrListenersRegistered) {
      renderer.xr.addEventListener("sessionstart", () => void this.onSessionStarted());
      renderer.xr.addEventListener("sessionend", () => this.onSessionEnded());
      this.xrListenersRegistered = true;
    }
  }

  /**
   * The renderer's animation-loop callback. The `timestamp` / `frame` arguments are
   * unused here but are the hook for XR frame data (e.g. image tracking).
   */
  render(_timestamp?: number, _frame?: any) {
    // XR requires a fresh render every frame; the desktop dirty-flag optimisation
    // (animator only draws when render===true, and onSessionStarted sets it false)
    // would otherwise freeze the AR view. Force it true while presenting.
    if (this.globalObjectInstance.renderer.xr.isPresenting) {
      this.globalObjectInstance.render = true;
      this.updateCanvasDrag();
      this.updatePointerRays();
    }

    void this.animator.animate();
  }

  async onSessionStarted() {
    this.globalObjectInstance.camera = this.globalObjectInstance.ARCamera;
    this.globalObjectInstance.render = false;
    this.logger.log("ar camera active", "info");

    // Capture the fresh, unmodified reference space for this session (three resets
    // any custom one at session start), then reapply a persisted origin offset so
    // the graph lands back on the same real-world spot as the previous session.
    this.baseReferenceSpace = this.globalObjectInstance.renderer.xr.getReferenceSpace() as XRReferenceSpace | null;
    this.loadPersistedOrigin();
    this.applyOriginOffset();

    this.createWorldOriginMarker();

    this.initControllersAndHands();
  }

  onSessionEnded() {
    this.globalObjectInstance.camera = this.globalObjectInstance.normalCamera;
    this.globalObjectInstance.render = true;
    this.logger.log("normal camera active", "info");

    this.baseReferenceSpace = null;
    this.twoHandDrag = null;
    if (this.controller1) this.controller1.userData.selecting = false;
    if (this.controller2) this.controller2.userData.selecting = false;
    this.removeWorldOriginMarker();
  }

  /** Build the controller and hand models and wire grab + recenter input on both hands. */
  initControllersAndHands() {
    this.controller1 = this.globalObjectInstance.renderer.xr.getController(0);
    this.globalObjectInstance.scene.add(this.controller1);
    this.wireController(this.controller1);

    this.controller2 = this.globalObjectInstance.renderer.xr.getController(1);
    this.globalObjectInstance.scene.add(this.controller2);
    this.wireController(this.controller2);

    const controllerModelFactory = new XRControllerModelFactory();
    const handModelFactory = new XRHandModelFactory();

    // Hand 1
    this.controllerGrip1 = this.globalObjectInstance.renderer.xr.getControllerGrip(0);
    this.controllerGrip1.add(controllerModelFactory.createControllerModel(this.controllerGrip1));
    this.globalObjectInstance.scene.add(this.controllerGrip1);

    this.hand1 = this.globalObjectInstance.renderer.xr.getHand(0);
    this.hand1.add(handModelFactory.createHandModel(this.hand1));
    this.handPointer1 = new OculusHandPointerModel(this.hand1, this.controller1);
    this.hand1.add(this.handPointer1);

    this.globalObjectInstance.scene.add(this.hand1);

    // Hand 2
    this.controllerGrip2 = this.globalObjectInstance.renderer.xr.getControllerGrip(1);
    this.controllerGrip2.add(controllerModelFactory.createControllerModel(this.controllerGrip2));
    this.globalObjectInstance.scene.add(this.controllerGrip2);

    this.hand2 = this.globalObjectInstance.renderer.xr.getHand(1);
    this.hand2.add(handModelFactory.createHandModel(this.hand2));
    this.handPointer2 = new OculusHandPointerModel(this.hand2, this.controller2);
    this.hand2.add(this.handPointer2);

    this.globalObjectInstance.scene.add(this.hand2);
  }

  /**
   * Wire grab + recenter on one `getController(i)` object. These events fire for a
   * physical controller's trigger / grip and for a tracked hand's pinch alike, so
   * both input modes go through the same path.
   */
  private wireController(controller: any) {
    controller.addEventListener("selectstart", () => this.onSelectStart(controller));
    controller.addEventListener("selectend", () => this.onSelectEnd(controller));
    // Grip button — physical controllers only; tracked hands never raise squeeze.
    controller.addEventListener("squeezestart", () => this.recenterToController(controller));
    this.attachPointerRay(controller);
  }

  /**
   * A thin line down the controller's local -Z with a small reticle at the tip, so
   * aiming a physical controller is visible (tracked hands get this from
   * `OculusHandPointerModel`). Both parts are flagged `isPointerHelper` so the grab
   * code never mistakes them for a grabbable child.
   */
  private attachPointerRay(controller: any) {
    const geometry = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, -1)]);
    const ray = new THREE.Line(geometry, new THREE.LineBasicMaterial({ color: POINTER_IDLE_COLOR, transparent: true, opacity: 0.6, depthTest: false }));
    ray.name = "pointerRay";
    ray.scale.z = POINTER_RAY_LENGTH;
    ray.renderOrder = 999;
    ray.userData.isPointerHelper = true;

    const reticle = new THREE.Mesh(new THREE.SphereGeometry(0.012, 12, 12), new THREE.MeshBasicMaterial({ color: POINTER_HIT_COLOR, depthTest: false }));
    reticle.name = "pointerReticle";
    reticle.renderOrder = 999;
    reticle.visible = false;
    reticle.userData.isPointerHelper = true;

    controller.add(ray, reticle);
    controller.userData.pointerRay = ray;
    controller.userData.pointerReticle = reticle;
  }

  /**
   * Per-frame: trim each controller's pointer ray to the nearest grabbable object and
   * show its reticle there, or extend it to its rest length when it points at nothing.
   * While a controller is holding an object the ray just sits at rest length (the held
   * object would otherwise be the thing its own ray hits).
   */
  private updatePointerRays() {
    for (const controller of [this.controller1, this.controller2]) {
      const ray = controller?.userData.pointerRay as THREE.Line | undefined;
      const reticle = controller?.userData.pointerReticle as THREE.Mesh | undefined;
      if (!ray || !reticle) continue;

      const hit = controller.userData.selected || this.twoHandDrag ? undefined : this.intersectDragObjects(controller)[0];
      if (hit) {
        ray.scale.z = hit.distance;
        reticle.position.set(0, 0, -hit.distance);
        reticle.visible = true;
        (ray.material as THREE.LineBasicMaterial).color.setHex(POINTER_HIT_COLOR);
      } else {
        ray.scale.z = POINTER_RAY_LENGTH;
        reticle.visible = false;
        (ray.material as THREE.LineBasicMaterial).color.setHex(POINTER_IDLE_COLOR);
      }
    }
  }

  /**
   * Trigger / pinch start: grab the object the controller is aimed at. On empty
   * space, arm a hold-to-recenter (the hand-tracking fallback for the grip button).
   * When the OTHER trigger is already down, hand off to the two-handed canvas grab.
   */
  onSelectStart(controller: any) {
    controller.userData.selecting = true;

    const otherController = controller === this.controller1 ? this.controller2 : this.controller1;

    if (otherController?.userData.selecting) {
      this.beginCanvasDrag();
      return;
    }

    const intersection = this.intersectDragObjects(controller)[0];

    // Nothing to grab: holding here means "put the world origin at this pose" — snap
    // graph (0,0,0) onto the controller so the model lines up with a real-world
    // reference (e.g. a robot base).
    if (!intersection) {
      controller.userData.recenterTimer = window.setTimeout(() => {
        controller.userData.recenterTimer = undefined;
        this.recenterToController(controller);
      }, RECENTER_HOLD_MS);
      return;
    }

    // Already held by the other hand / controller — leave it there.
    if (intersection.object.parent === otherController) return;

    const object = intersection.object;
    // Remember where it came from so onSelectEnd can put it back.
    controller.userData.objectParent = object.parent;
    controller.attach(object);
    controller.userData.selected = object;
  }

  /** Trigger / pinch end: end a canvas grab, or cancel a pending recenter and drop any held object. */
  onSelectEnd(controller: any) {
    controller.userData.selecting = false;

    // Released before the recenter hold elapsed — cancel it.
    if (controller.userData.recenterTimer !== undefined) {
      window.clearTimeout(controller.userData.recenterTimer);
      controller.userData.recenterTimer = undefined;
    }

    // The two-handed canvas grab needs both triggers; releasing either one ends it.
    if (this.twoHandDrag) {
      this.endCanvasDrag();
      return;
    }

    this.releaseHeld(controller);
  }

  /** Re-attach whatever object a controller is holding back to its original parent. */
  private releaseHeld(controller: any) {
    // `selected` is the normal case; falling back to the first non-helper child covers
    // an object that ended up on the controller without a matching select-start (the
    // pointer ray + reticle are always children too, so skip those).
    const object = controller.userData.selected ?? controller.children.find((child: any) => !child.userData?.isPointerHelper);
    if (!object) return;

    controller.userData.objectParent?.attach(object);
    controller.userData.objectParent = undefined;
    controller.userData.selected = undefined;
  }

  /** Objects under the ray a controller / hand points along its local -Z. */
  private intersectDragObjects(controller: any): THREE.Intersection[] {
    controller.updateWorldMatrix(true, false);
    this.tempMatrix.identity().extractRotation(controller.matrixWorld);
    this.raycaster.ray.origin.setFromMatrixPosition(controller.matrixWorld);
    this.raycaster.ray.direction.set(0, 0, -1).applyMatrix4(this.tempMatrix);
    return this.raycaster.intersectObjects(this.globalObjectInstance.dragObjects, false) as THREE.Intersection[];
  }

  // ---------------------------------------------------------------------------
  // World-origin calibration
  //
  // The graph is rendered at fixed scene coordinates whose (0,0,0) is wherever the
  // headset placed the session's reference-space origin. To line the graph up with
  // something real (a robot base, a floor marker), we replace the reference space
  // with an offset one: everything in the scene — grid, model, the origin marker,
  // and the controllers/hands — moves together as one rigid "canvas", so grabbing
  // and ray hits stay aligned. Only the yaw of the calibration pose is used, so the
  // model always stays level regardless of how the hand/controller is tilted.
  //
  // Three ways in: `recenterToController` snaps the origin to one pose (grip button /
  // hold gesture); `setOrigin` takes explicit numbers; and the two-handed grab
  // (`beginCanvasDrag` / `updateCanvasDrag` / `endCanvasDrag`) lets the canvas follow
  // both controllers freely while both triggers are held. All three end up writing
  // `originOffsetMatrix` and calling `applyOriginOffset`.
  // ---------------------------------------------------------------------------

  /**
   * Snap the world origin to a controller's / hand's current pose (position + yaw).
   * Called by the grip button and the hold-to-recenter gesture; also safe to call
   * directly (e.g. from a UI button, passing `arInitiator.controller1`).
   */
  recenterToController(controller: any): void {
    if (!controller || this.twoHandDrag) return;
    controller.updateWorldMatrix(true, false);
    // The controller pose is in the *current* (already-offset) space; compose it
    // back through the active offset to express the new origin in base space.
    const poseInBase = this.originOffsetMatrix.clone().multiply(controller.matrixWorld);
    const position = new THREE.Vector3();
    const quaternion = new THREE.Quaternion();
    poseInBase.decompose(position, quaternion, new THREE.Vector3());
    const yaw = new THREE.Euler().setFromQuaternion(quaternion, "YXZ").y;
    this.setOrigin(position.x, position.y, position.z, yaw);
  }

  /**
   * Start the two-handed canvas grab: from now until a trigger is released, the whole
   * canvas follows the two controllers. Any in-progress single-hand gesture (a held
   * object, a pending recenter) is cancelled first so the two flows never overlap.
   */
  private beginCanvasDrag(): void {
    for (const controller of [this.controller1, this.controller2]) {
      if (controller?.userData.recenterTimer !== undefined) {
        window.clearTimeout(controller.userData.recenterTimer);
        controller.userData.recenterTimer = undefined;
      }
      this.releaseHeld(controller);
    }

    const { position, yaw, separated } = this.readTwoHandFrame();
    this.twoHandDrag = {
      originStart: this.originOffsetMatrix.clone(),
      handStart: new THREE.Matrix4().compose(position, this.yawQuat(separated ? yaw : 0), ONE),
      lastYaw: separated ? yaw : 0,
      yawAnchored: separated,
    };
    this.logger.log("ar canvas grab started", "info");
  }

  /** Per-frame while both triggers are held: move the canvas by how far the two-hand frame has travelled. */
  private updateCanvasDrag(): void {
    const drag = this.twoHandDrag;
    if (!drag) return;

    const { position, yaw, separated } = this.readTwoHandFrame();

    // First frame with a trustworthy heading: re-anchor the start frame (and the
    // origin baseline) to "now", so spreading the hands apart after the grab began
    // does not snap-rotate the canvas. All movement applied so far is already baked
    // into `originOffsetMatrix`, so copying it into `originStart` keeps it.
    if (separated && !drag.yawAnchored) {
      drag.originStart.copy(this.originOffsetMatrix);
      drag.handStart.compose(position, this.yawQuat(yaw), ONE);
      drag.lastYaw = yaw;
      drag.yawAnchored = true;
      return;
    }
    // Hands back together: freeze the heading and let it re-anchor on the next spread.
    if (!separated) drag.yawAnchored = false;

    const currentYaw = separated ? yaw : drag.lastYaw;
    drag.lastYaw = currentYaw;

    const handNow = new THREE.Matrix4().compose(position, this.yawQuat(currentYaw), ONE);
    // delta (base space) = handNow ∘ handStart⁻¹ ; new offset = delta ∘ originStart.
    // With handNow / handStart sharing a translation this conjugation is a rotation
    // about the hands' midpoint, so the canvas turns under the user's hands rather
    // than about the far-away scene origin.
    const delta = handNow.multiply(drag.handStart.clone().invert());
    this.originOffsetMatrix.multiplyMatrices(delta, drag.originStart);
    this.applyOriginOffset();
  }

  private yawQuat(yaw: number): THREE.Quaternion {
    return new THREE.Quaternion().setFromAxisAngle(UP, yaw);
  }

  /** End the two-handed canvas grab and persist wherever the canvas was left. */
  private endCanvasDrag(): void {
    if (!this.twoHandDrag) return;
    this.twoHandDrag = null;

    const position = new THREE.Vector3();
    const quaternion = new THREE.Quaternion();
    this.originOffsetMatrix.decompose(position, quaternion, new THREE.Vector3());
    const yaw = new THREE.Euler().setFromQuaternion(quaternion, "YXZ").y;
    // Re-normalise to a clean yaw-only offset so float drift from the per-frame
    // matrix chain cannot accumulate a sliver of pitch / roll.
    this.setOrigin(position.x, position.y, position.z, yaw);
    this.logger.log("ar canvas grab ended", "info");
  }

  /**
   * The frame midway between the two controllers, in BASE space: position is their
   * midpoint, `yaw` is the heading of the line between them (only meaningful when
   * `separated`), `separated` is whether they are far enough apart to trust that yaw.
   */
  private readTwoHandFrame(): { position: THREE.Vector3; yaw: number; separated: boolean } {
    const p1 = this.controllerPositionInBase(this.controller1);
    const p2 = this.controllerPositionInBase(this.controller2);
    const between = p2.clone().sub(p1);
    return {
      position: p1.add(p2).multiplyScalar(0.5),
      yaw: Math.atan2(between.x, between.z),
      separated: Math.hypot(between.x, between.z) >= MIN_TWO_HAND_SEPARATION,
    };
  }

  /** A controller's position expressed in base space (undoes the active origin offset). */
  private controllerPositionInBase(controller: any): THREE.Vector3 {
    controller.updateWorldMatrix(true, false);
    const poseInBase = this.originOffsetMatrix.clone().multiply(controller.matrixWorld);
    return new THREE.Vector3().setFromMatrixPosition(poseInBase);
  }

  /**
   * Set the world origin explicitly, in metres and radians, relative to the
   * session's native reference-space origin. Persisted across sessions.
   *
   * @param yaw rotation of the graph about the vertical axis, in radians.
   */
  setOrigin(x: number, y: number, z: number, yaw = 0): void {
    this.originOffsetMatrix.compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromAxisAngle(UP, yaw), ONE);
    this.persistOrigin(x, y, z, yaw);
    this.applyOriginOffset();
    this.logger.log(`ar world origin set to x=${x.toFixed(3)} y=${y.toFixed(3)} z=${z.toFixed(3)} yaw=${THREE.MathUtils.radToDeg(yaw).toFixed(1)}°`, "info");
  }

  /** Drop any calibration and put the origin back on the headset's native origin. */
  resetOrigin(): void {
    this.originOffsetMatrix.identity();
    try {
      window.localStorage.removeItem(ORIGIN_OFFSET_STORAGE_KEY);
    } catch {
      /* storage unavailable — nothing to clear */
    }
    this.applyOriginOffset();
    this.logger.log("ar world origin reset", "info");
  }

  /** Push the current {@link originOffsetMatrix} onto the renderer as an offset reference space. */
  private applyOriginOffset(): void {
    const renderer = this.globalObjectInstance.renderer;
    if (!this.baseReferenceSpace || !renderer.xr.isPresenting) return;

    if (this.isIdentity(this.originOffsetMatrix)) {
      renderer.xr.setReferenceSpace(this.baseReferenceSpace);
      return;
    }

    const position = new THREE.Vector3();
    const quaternion = new THREE.Quaternion();
    this.originOffsetMatrix.decompose(position, quaternion, new THREE.Vector3());
    const offset = new XRRigidTransform(
      { x: position.x, y: position.y, z: position.z },
      { x: quaternion.x, y: quaternion.y, z: quaternion.z, w: quaternion.w },
    );
    renderer.xr.setReferenceSpace(this.baseReferenceSpace.getOffsetReferenceSpace(offset));
  }

  private isIdentity(m: THREE.Matrix4): boolean {
    const e = m.elements;
    return e[12] === 0 && e[13] === 0 && e[14] === 0 && e[0] === 1 && e[5] === 1 && e[10] === 1 && e[1] === 0 && e[2] === 0 && e[4] === 0 && e[6] === 0 && e[8] === 0 && e[9] === 0;
  }

  private persistOrigin(x: number, y: number, z: number, yaw: number): void {
    try {
      window.localStorage.setItem(ORIGIN_OFFSET_STORAGE_KEY, JSON.stringify({ x, y, z, yaw }));
    } catch {
      /* storage unavailable — offset just won't survive a reload */
    }
  }

  private loadPersistedOrigin(): void {
    let raw: string | null = null;
    try {
      raw = window.localStorage.getItem(ORIGIN_OFFSET_STORAGE_KEY);
    } catch {
      raw = null;
    }
    if (!raw) {
      this.originOffsetMatrix.identity();
      return;
    }
    try {
      const { x, y, z, yaw } = JSON.parse(raw) as { x: number; y: number; z: number; yaw: number };
      this.originOffsetMatrix.compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromAxisAngle(UP, yaw ?? 0), ONE);
    } catch {
      this.originOffsetMatrix.identity();
    }
  }

  /** Draw the world origin as an axis cross with a labelled tip on each axis. */
  createWorldOriginMarker() {
    const worldOriginMarker = new THREE.AxesHelper(0.3);
    worldOriginMarker.position.set(0, 0, 0);
    worldOriginMarker.name = "worldOriginMarker";
    this.globalObjectInstance.scene.add(worldOriginMarker);

    const axes: { label: string; color: number; position: [number, number, number] }[] = [
      { label: "+X", color: 0xff0000, position: [0.3, 0, 0] },
      { label: "+Y", color: 0x00ff00, position: [0, 0.3, 0] },
      { label: "+Z", color: 0x0000ff, position: [0, 0, 0.3] },
    ];

    const loader = new FontLoader();
    loader.load(AXIS_LABEL_FONT_URL, (font: any) => {
      for (const axis of axes) {
        const geometry = new TextGeometry(axis.label, { font, size: 0.05, height: 0.01 });
        const text = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ color: axis.color }));
        text.position.set(...axis.position);
        worldOriginMarker.add(text);
      }
    });
  }

  removeWorldOriginMarker() {
    const marker = this.globalObjectInstance.scene.getObjectByName("worldOriginMarker");
    if (marker) {
      this.globalObjectInstance.scene.remove(marker);
    }
  }
}

// Module singleton — one shared instance.
export const arInitiator = new ArInitiator();
