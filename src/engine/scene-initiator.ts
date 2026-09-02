import * as THREE from "three";
import { TransformControls } from "three/examples/jsm/controls/TransformControls.js";
import { globalObject } from "@/engine/global-definition";
import { globalSelectedObject } from "@/engine/global-selected-object";
import { transformControlsEvents } from "@/engine/transform-control-events";

/**
 * Builds a fresh THREE.Scene for a tab: transform controls, lights, the modelling
 * plane, the pointer sphere and the two grid helpers.
 *
 * `initTransformControls` re-registers the canvas `pointerdown` listener around
 * creating the controls, and the order matters: the transform controls must claim the
 * event first, so the interaction handler's listener is removed and added back after.
 */
export class SceneInitiator {
  private globalObjectInstance = globalObject;
  private transformControlsEvents = transformControlsEvents;

  async sceneInit() {
    if (this.globalObjectInstance.elementContainer) {
      // Clear any live selection BEFORE swapping in the new scene, while
      // `globalObject.scene` still points at the outgoing one. Otherwise the red
      // selection box (and its refs) are stranded in the old scene and can never
      // be removed. `switchToTab` already does this for tab switches; opening a
      // brand-new scene/tab goes straight through here instead.
      globalSelectedObject.removeObject();
      this.globalObjectInstance.transformControls?.detach();

      this.globalObjectInstance.scene = new THREE.Scene();

      //-------------------------------
      //set up controls
      //-------------------------------
      //add transformcontrols to scene
      await this.initTransformControls();

      this.globalObjectInstance.scene.add(this.globalObjectInstance.mousePointer3d);

      await this.initLights();

      this.globalObjectInstance.scene.add(this.globalObjectInstance.plane);

      // add grid
      const helper = new THREE.GridHelper(1000, 1000);
      helper.position.z = this.globalObjectInstance.localZPlane;
      helper.material.opacity = 0.1;
      helper.material.transparent = true;
      //rotate the grid so that it is horizontal
      helper.rotateX(Math.PI / 2);
      this.globalObjectInstance.scene.add(helper);

      const helper2 = new THREE.GridHelper(1000, 100);
      helper2.position.z = this.globalObjectInstance.localZPlane;
      helper2.material.opacity = 0.05;
      helper2.material.transparent = true;
      //rotate the grid so that it is horizontal
      this.globalObjectInstance.scene.add(helper2);
    }
  }

  async initTransformControls() {
    // Tear down the controls that belonged to the previously-active tab.
    //
    // What gets added to the scene is `getHelper()` — a `TransformControlsRoot`,
    // NOT a `TransformControls` (three >=0.169 split them; `TransformControls`
    // extends `Controls`, not `Object3D`, so it is never in the scene graph at
    // all). The old `instanceof TransformControls` sweep below therefore never
    // matched anything, so every tab switch stranded the previous tab's gizmo —
    // still `attach()`ed to its object and still `visible` — in the old scene,
    // and leaked the three `pointer*` listeners its constructor put on the canvas.
    const previous = this.globalObjectInstance.transformControls;
    if (previous) {
      previous.detach(); // hides the helper root
      previous.getHelper().removeFromParent(); // pull it out of whatever scene holds it
      previous.disconnect(); // drop the canvas pointer listeners the constructor added
    }

    // Belt and braces: remove any stranded gizmo roots left in the target scene
    // by an earlier build that didn't clean up.
    const staleRoots: THREE.Object3D[] = [];
    this.globalObjectInstance.scene.traverse((child: THREE.Object3D) => {
      if ((child as { isTransformControlsRoot?: boolean }).isTransformControlsRoot) {
        staleRoots.push(child);
      }
    });
    staleRoots.forEach((root) => root.removeFromParent());

    this.globalObjectInstance.transformControls = new TransformControls(this.globalObjectInstance.camera, this.globalObjectInstance.renderer.domElement);

    // this.globalObjectInstance.scene.add(this.globalObjectInstance.transformControls);
    this.globalObjectInstance.scene.add(this.globalObjectInstance.transformControls.getHelper());
    this.globalObjectInstance.transformControls.setMode("scale");

    //remove event listener for onDocumentMouseDown
    //this is important, since the transformControls event listener must be registered before the pointerdown event listener
    //thus, we remove it before we initialize the transformControls and add it again after the transformControls are initialized
    this.globalObjectInstance.renderer.domElement.removeEventListener("pointerdown", this.globalObjectInstance.onDocumentMouseDownEventListener);

    //add event listener for transformControls
    this.globalObjectInstance.transformControls.addEventListener("change", () => this.transformControlsEvents.onTransformControlsPropertyChange());
    (this.globalObjectInstance.transformControls as any).addEventListener("mouseUp", async () => await this.transformControlsEvents.onTransformControlsMouseUp());

    //add again event listener for pointerdown
    this.globalObjectInstance.renderer.domElement.addEventListener("pointerdown", this.globalObjectInstance.onDocumentMouseDownEventListener);
  }

  async initLights() {
    //create two directional lights pointing at the point 0,0,0
    const light1 = new THREE.DirectionalLight(0xffffff, 1.3);
    light1.position.set(10, 10, 10);
    this.globalObjectInstance.scene.add(light1);

    const light2 = new THREE.DirectionalLight(0xffffff, 1.3);
    light2.position.set(-10, -10, 0);
    this.globalObjectInstance.scene.add(light2);
  }
}

// Module singleton — one shared instance.
export const sceneInitiator = new SceneInitiator();
