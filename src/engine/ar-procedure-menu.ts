import * as THREE from "three";
import { Text } from "troika-three-text";
import { globalObject } from "@/engine/global-definition";
import { procedureUtility } from "@/resources/services/procedure-utility";
import { eventBus } from "@/resources/services/event-bus";
import { logger } from "@/resources/services/logger";
import { describeError } from "@/resources/util/describe-error";

/**
 * A floating 3D menu of the procedures ("algorithms") assigned to the open scene
 * type, for running them from inside an AR session — the HTML `AlgorithmDialog` is
 * a DOM overlay and the headset does not composite it into the immersive view.
 *
 * `ArInitiator` owns one instance: the A / X controller button toggles it
 * (`toggle`), a trigger press while it is open runs the row under that controller's
 * pointer ray (`handleSelect`), and the render loop tints the hovered row
 * (`updateHover`). Execution goes through `procedureUtility.execute("", name)` — the
 * assigned group only — then announces an undo step and a vizRep refresh over the
 * event bus (engine modules must not import `history-service` directly).
 */

const ROW_WIDTH = 0.44;
const ROW_HEIGHT = 0.07;
const ROW_GAP = 0.008;
const PANEL_PADDING = 0.03;
/** Metres in front of the viewer, and metres below eye level, the menu is placed on open. */
const MENU_DISTANCE = 0.6;
const MENU_DROP = 0.15;

const COLOR_PANEL = 0x11141c;
const COLOR_TITLE = 0x9fb4ff;
const COLOR_MUTED = 0x8892a6;
const COLOR_ROW = 0x232a3a;
const COLOR_ROW_HOVER = 0x3d6fe0;

export class ArProcedureMenu {
  private globalObjectInstance = globalObject;
  private group = new THREE.Group();
  private rows: THREE.Mesh[] = [];
  private raycaster = new THREE.Raycaster();
  private tempMatrix = new THREE.Matrix4();
  private _open = false;
  private building = false;

  constructor() {
    this.group.name = "arProcedureMenu";
    this.group.visible = false;
  }

  get open(): boolean {
    return this._open;
  }

  /** Show the menu (rebuilding its rows from the backend), or hide it if already open. */
  async toggle(): Promise<void> {
    if (this._open) {
      this.hide();
      return;
    }
    if (this.building) return;

    this.building = true;
    try {
      if (!this.group.parent && this.globalObjectInstance.scene) {
        this.globalObjectInstance.scene.add(this.group);
      }
      await this.buildRows();
      this.positionInFrontOfViewer();
      this.group.visible = true;
      this._open = true;
    } catch (error) {
      logger.log("could not open the AR procedure menu: " + describeError(error), "error");
    } finally {
      this.building = false;
    }
  }

  hide(): void {
    this.group.visible = false;
    this._open = false;
  }

  /** Tear the menu down — call on session end. */
  dispose(): void {
    this.hide();
    this.clearContent();
    this.group.removeFromParent();
  }

  /**
   * Trigger pressed while the menu is open: run the procedure whose row the
   * controller's pointer ray is on, then close. A miss does nothing.
   */
  handleSelect(controller: any): void {
    const name = this.raycastRows(controller)?.object.userData.procedureName as string | undefined;
    if (!name) return;
    this.hide();
    void this.run(name);
  }

  /** Per-frame: tint the row (if any) under either controller's pointer ray. */
  updateHover(controllers: any[]): void {
    if (!this._open) return;
    const hovered = new Set<THREE.Object3D>();
    for (const controller of controllers) {
      const hit = this.raycastRows(controller);
      if (hit) hovered.add(hit.object);
    }
    for (const row of this.rows) {
      (row.material as THREE.MeshBasicMaterial).color.setHex(hovered.has(row) ? COLOR_ROW_HOVER : COLOR_ROW);
    }
  }

  /** The menu row a controller's pointer ray is on (non-recursive: the row plane, not its label). */
  raycastRows(controller: any): THREE.Intersection | undefined {
    if (!this._open || this.rows.length === 0 || !controller) return undefined;
    controller.updateWorldMatrix(true, false);
    this.tempMatrix.identity().extractRotation(controller.matrixWorld);
    this.raycaster.ray.origin.setFromMatrixPosition(controller.matrixWorld);
    this.raycaster.ray.direction.set(0, 0, -1).applyMatrix4(this.tempMatrix);
    return this.raycaster.intersectObjects(this.rows, false)[0] as THREE.Intersection | undefined;
  }

  private async run(name: string): Promise<void> {
    try {
      await procedureUtility.execute("", name);
      eventBus.publish("historyRecord", { label: `algorithm ${name}` });
      eventBus.publish("checkForVizRepUpdate");
      logger.log(`ran procedure "${name}"`, "info");
    } catch (error) {
      logger.log(`procedure "${name}" failed: ` + describeError(error), "error");
    }
  }

  private async buildRows(): Promise<void> {
    this.clearContent();

    const hasTab = this.globalObjectInstance.tabContext[this.globalObjectInstance.selectedTab] != undefined;
    const procedures = hasTab ? await procedureUtility.getAssignedProcedures() : [];

    const bodyRows = Math.max(procedures.length, 1); // reserve one line for the empty-state message
    const titleHeight = ROW_HEIGHT;
    const bodyHeight = bodyRows * ROW_HEIGHT + (bodyRows - 1) * ROW_GAP;
    const panelWidth = ROW_WIDTH + PANEL_PADDING * 2;
    const panelHeight = titleHeight + bodyHeight + PANEL_PADDING * 3;

    const panel = new THREE.Mesh(
      new THREE.PlaneGeometry(panelWidth, panelHeight),
      new THREE.MeshBasicMaterial({ color: COLOR_PANEL, transparent: true, opacity: 0.85, side: THREE.DoubleSide, depthWrite: false }),
    );
    panel.position.set(0, 0, -0.003);
    panel.renderOrder = 1000;
    this.group.add(panel);

    const top = panelHeight / 2 - PANEL_PADDING;

    const title = this.makeText("Procedures", 0.034, COLOR_TITLE);
    title.position.set(0, top - titleHeight / 2, 0.004);
    title.sync();
    this.group.add(title);

    const firstRowY = top - titleHeight - PANEL_PADDING - ROW_HEIGHT / 2;

    if (procedures.length === 0) {
      const empty = this.makeText(hasTab ? "none for this scene type" : "open a scene first", 0.026, COLOR_MUTED);
      empty.position.set(0, firstRowY, 0.004);
      empty.sync();
      this.group.add(empty);
      return;
    }

    procedures.forEach((procedure, index) => {
      const row = new THREE.Mesh(
        new THREE.PlaneGeometry(ROW_WIDTH, ROW_HEIGHT),
        new THREE.MeshBasicMaterial({ color: COLOR_ROW, transparent: true, opacity: 0.95, side: THREE.DoubleSide, depthWrite: false }),
      );
      row.position.set(0, firstRowY - index * (ROW_HEIGHT + ROW_GAP), 0.002);
      row.renderOrder = 1001;
      row.userData.procedureName = procedure.name;
      row.userData.isProcedureRow = true;

      const label = this.makeText(procedure.name, 0.028, 0xffffff);
      label.position.set(0, 0, 0.003);
      label.sync();
      row.add(label);

      this.group.add(row);
      this.rows.push(row);
    });
  }

  private makeText(text: string, fontSize: number, color: number): Text {
    const label = new Text();
    label.text = text;
    label.fontSize = fontSize;
    label.color = new THREE.Color(color);
    label.anchorX = "center";
    label.anchorY = "middle";
    label.maxWidth = ROW_WIDTH * 0.92;
    label.overflowWrap = "break-word";
    label.renderOrder = 1002;
    const material = label.material as THREE.Material | undefined;
    if (material) material.depthWrite = false;
    return label;
  }

  private clearContent(): void {
    for (const child of [...this.group.children]) {
      this.group.remove(child);
      const mesh = child as THREE.Mesh & { dispose?: () => void };
      mesh.geometry?.dispose?.();
      const material = mesh.material as THREE.Material | THREE.Material[] | undefined;
      if (Array.isArray(material)) material.forEach((m) => m.dispose());
      else material?.dispose?.();
      mesh.dispose?.(); // troika Text owns GPU resources beyond geometry / material
    }
    this.rows = [];
  }

  private positionInFrontOfViewer(): void {
    const camera = this.globalObjectInstance.renderer.xr.getCamera();
    const camPosition = new THREE.Vector3();
    const camQuaternion = new THREE.Quaternion();
    camera.getWorldPosition(camPosition);
    camera.getWorldQuaternion(camQuaternion);

    const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(camQuaternion);
    forward.y = 0;
    if (forward.lengthSq() < 1e-6) forward.set(0, 0, -1);
    forward.normalize();

    this.group.position.copy(camPosition).addScaledVector(forward, MENU_DISTANCE);
    this.group.position.y = camPosition.y - MENU_DROP;
    // Face the viewer, but stay upright (look at a point at the menu's own height).
    this.group.lookAt(camPosition.x, this.group.position.y, camPosition.z);
  }
}

// Module singleton — one shared instance, owned by ArInitiator.
export const arProcedureMenu = new ArProcedureMenu();
