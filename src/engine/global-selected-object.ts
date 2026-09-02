import * as THREE from "three";
import { globalObject } from "@/engine/global-definition";

/**
 * The locally selected object, and the red box helper drawn around it.
 *
 * Selecting also publishes the selection over the active tab's awareness, so
 * collaborators can draw a presence box around the same object
 * (`RemoteSelectionRenderer` renders it). On a tab with no shared session the guard in
 * `publishSelection` makes that a no-op.
 */
export class GlobalSelectedObject {
  public object: THREE.Mesh = new THREE.Mesh();

  private globalObjectInstance = globalObject;

  getObject() {
    // Only refresh the box helper when there is actually something selected. After
    // `removeObject()` (e.g. clicking empty space) both `this.object` and the
    // boxHelper are undefined, so an unconditional `updateSelectionBoxHelper`
    // threw "Cannot read properties of undefined (reading 'setFromObject')" whenever a
    // rebuild read the selection (the React selection store triggers exactly that).
    if (this.object && this.globalObjectInstance.boxHelper) {
      this.updateSelectionBoxHelper(this.object);
    }
    return this.object;
  }

  setObject(object: THREE.Mesh) {
    this.removeObject();
    if (this.globalObjectInstance.boxHelper != undefined) {
      this.object = object;
      this.updateSelectionBoxHelper(object);
    } else {
      this.object = object;
      this.initSelectionBoxHelper(object);
    }
    // Broadcast the selection so collaborators see a box around the same object.
    this.publishSelection(object?.uuid ?? null);
  }

  removeObject() {
    this.object = undefined as unknown as THREE.Mesh;
    this.removeSelectionBoxHelper();
    // Tell collaborators we no longer have anything selected.
    this.publishSelection(null);
  }

  /**
   * Publish the locally-selected instance UUID over the active tab's shared-session
   * awareness so other clients can render a presence box (RemoteSelectionRenderer
   * consumes this field). A no-op when the active tab is not shared.
   */
  private publishSelection(uuid: string | null) {
    const sharedDocService = this.globalObjectInstance.sharedDocServiceRef;
    if (!sharedDocService) return;
    const session = sharedDocService.forTab(this.globalObjectInstance.selectedTab);
    if (!session) return;
    session.awareness.setLocalStateField("selection", { uuid });
  }

  initSelectionBoxHelper(object: THREE.Mesh) {
    this.globalObjectInstance.boxHelper = new THREE.BoxHelper(object, "red");
    this.globalObjectInstance.scene.add(this.globalObjectInstance.boxHelper);
    this.updateSelectionBoxHelper(object);
  }
  updateSelectionBoxHelper(object: THREE.Mesh) {
    this.globalObjectInstance.boxHelper.setFromObject(object);
    this.globalObjectInstance.boxHelper.update();
  }
  removeSelectionBoxHelper() {
    // Remove the box from whatever scene actually holds it — NOT from
    // `globalObject.scene`. Opening a new tab swaps `globalObject.scene` to a fresh
    // scene without first clearing the selection, so by the time this runs the box
    // can live in a different (previous) tab's scene; `scene.remove()` would then
    // miss it, strand it there, and null out the only reference to it — leaving a
    // red box that can never be cleared.
    this.globalObjectInstance.boxHelper?.removeFromParent();
    this.globalObjectInstance.boxHelper = undefined as unknown as THREE.BoxHelper;
  }
}

// Module singleton — one shared instance.
export const globalSelectedObject = new GlobalSelectedObject();
