import { AttributeInstance, ClassInstance, RelationclassInstance, UUID } from "@gds";
import { globalObject } from "@/engine/global-definition";
import {
  applyCartesianTarget,
  applyJointValues,
  readJointValues,
  type JointValues,
  type MotionOptions,
  type MotionResult,
} from "@/engine/hybrid-algorithms/urdf-motion";
import type { IkTarget } from "@/engine/hybrid-algorithms/urdf-ik";
import { toRobotFrame } from "@/engine/hybrid-algorithms/task-reach";
import { instanceUtility } from "./instance-utility";
import { eventBus } from "./event-bus";
import { metaUtility } from "./meta-utility";
import { fileUtility } from "./file-utility";

/**
 * The `gc.expression.*` API that stored vizRep and mechanism code strings call.
 *
 * Like `graphic-context`, the method surface is a contract with code held in the
 * database: names and parameter order must not change, and methods are kept even when
 * nothing in this repository calls them.
 *
 * The `attrval*` family reads attribute values (by meta uuid, by meta name, or for an
 * arbitrary instance), the relation helpers walk incoming and outgoing relations, and
 * the `checkForVisualizationUpdate*` pair asks the vizRep pipeline for a redraw.
 */
export class ExpressionUtility {
  private globalObjectInstance = globalObject;
  private instanceUtility = instanceUtility;
  private eventAggregator = eventBus;
  private metaUtility = metaUtility;
  private fileUtility = fileUtility;

  /**
   * Calls the value of the attribute instance in the local client based on the UUID of the meta attribute.
   * The context is the current class instance.
   *
   * @param {string} UUID - The UUID of the meta attribute.
   * @returns {Promise<string>} - A promise resolving to the value of the attributInstance.
   */
  async attrval(attrUUID: string): Promise<string | undefined> {
    const current_class_instance = this.globalObjectInstance.current_class_instance;
    let attributeInstances = await this.instanceUtility.getAttributeInstanceFromClassInstance(
      attrUUID,
      current_class_instance?.uuid,
      "uuid",
    );
    // if not found in class, get from relationclassInstance
    if (!attributeInstances) {
      attributeInstances = await this.instanceUtility.getAttributeInstanceFromRelationClassInstance(
        attrUUID,
        current_class_instance?.uuid,
        "uuid",
      );
    }
    // if not found in relationclass, get from portInstance
    if (!attributeInstances && this.globalObjectInstance.current_port_instance) {
      attributeInstances = await this.instanceUtility.getAttributeInstanceFromPortInstance(
        attrUUID,
        this.globalObjectInstance.current_port_instance.uuid,
        "uuid",
      );
    }
    return attributeInstances?.value;
  }

  /**
   * Calls the value of the attribute instance in the local client based on the name of the meta attribute.
   * The context is the current class instance.
   *
   * @param {string} attributeName - The name of the meta attribute.
   * @returns {Promise<string>} - A promise resolving to the value of the attributInstance.
   */
  async attrvalByName(attrName: string): Promise<string | undefined> {
    let attributeInstances = await this.instanceUtility.getAttributeInstanceFromClassInstance(
      attrName,
      this.globalObjectInstance.current_class_instance?.uuid,
      "name",
    );
    // if not found in class, get from relationclassInstance
    if (!attributeInstances) {
      attributeInstances = await this.instanceUtility.getAttributeInstanceFromRelationClassInstance(
        attrName,
        this.globalObjectInstance.current_class_instance?.uuid,
        "name",
      );
    }
    // if not found in relationclass, get from portInstance
    if (!attributeInstances && this.globalObjectInstance.current_port_instance) {
      attributeInstances = await this.instanceUtility.getAttributeInstanceFromPortInstance(
        attrName,
        this.globalObjectInstance.current_port_instance.uuid,
        "name",
      );
    }
    return attributeInstances?.value;
  }

  /**
   * Calls the value of the attribute instance in the local client based on the UUID of any type of instance and the meta attribute UUID.
   *
   * @param {string} instUUID - The UUID of any type of instance.
   * @param {string} attrUUID - The UUID of the meta attribute.
   * @returns {Promise<string>} - A promise resolving to the value of the attributInstance.
   */
  async attrvalByInst(attrUUID: string, instUUID: string): Promise<string | undefined> {
    const instance = await this.instanceUtility.getAnyInstance(instUUID);
    const attributeInstances = await this.instanceUtility.getAttributeInstanceFromAnyInstance(
      attrUUID,
      instance!.uuid,
      "uuid",
    );
    return attributeInstances?.value;
  }

  /**
   * Retrieves the attribute instance in the local client based on the UUID of any type of instance and the meta attribute UUID.
   *
   * @param {string} instanceUUID - The UUID of any type of instance.
   * @param {string} metaAttributeUUID - The UUID of the meta attribute.
   * @returns {Promise<AttributeInstance>} - A promise resolving to the attribute instance.
   */
  async getAttrByInstanceUUID(
    instanceUUID: string,
    metaAttributeUUID: string,
  ): Promise<AttributeInstance | undefined> {
    return this.findAttributeInstance(instanceUUID, metaAttributeUUID);
  }

  /**
   * Updates the value of the attribute instance in the local client based on the UUID of any type of instance and the meta attribute UUID.
   *
   * @param {string} instanceUUID - The UUID of any type of instance.
   * @param {string} metaAttributeUUID - The UUID of the meta attribute.
   * @param {any} value - The new value of the attribute instance.
   */
  async setAttrvalByInstanceUUID(instanceUUID: string, metaAttributeUUID: string, value: any) {
    const attributeInstance = await this.findAttributeInstance(instanceUUID, metaAttributeUUID);
    attributeInstance!.value = value;
  }

  /**
   * Retrieves all class (and relation class) instances in the local client based on the UUID of the meta class.
   *
   * @param {string} metaClassUUID - The UUID of the meta class.
   * @returns {Promise<ClassInstance[]>} - A promise resolving to an array of the class (and relation class) instances.
   */
  async getClassInstancesByMetaUUID(metaClassUUID: string): Promise<ClassInstance[]> {
    const instances = await this.instanceUtility.getAllClassInstancesFromOpenSceneInstance();
    return instances.filter(
      (inst) =>
        (inst instanceof ClassInstance && inst.uuid_class === metaClassUUID) ||
        (inst instanceof RelationclassInstance && inst.uuid_relationclass === metaClassUUID),
    );
  }

  /**
   * Retrieves the source (origin) class instance in the local client based on the UUID of the relation class instance.
   *
   * @param {string} relInstanceUUID - The UUID of the relation class instance.
   * @returns {Promise<ClassInstance>} - A promise resolving to the source class instance.
   */
  async getSourceByRelInstanceUUID(relInstanceUUID: string): Promise<ClassInstance | undefined> {
    const relInstance = await this.instanceUtility.getAnyInstance(relInstanceUUID);
    if (relInstance instanceof RelationclassInstance) {
      const classUUID = relInstance.role_instance_from.uuid_has_reference_class_instance;
      const classInstance = await this.instanceUtility.getAnyInstance(classUUID);
      if (classInstance instanceof ClassInstance) {
        return classInstance;
      }
    }
  }

  /**
   * Retrieves the destination (target) class instance in the local client based on the UUID of the relation class instance.
   *
   * @param {string} relInstanceUUID - The UUID of the relation class instance.
   * @returns {Promise<ClassInstance>} - A promise resolving to the destination class instance.
   */
  async getDestinationByRelInstanceUUID(
    relInstanceUUID: string,
  ): Promise<ClassInstance | null | undefined> {
    const relInstance = await this.instanceUtility.getAnyInstance(relInstanceUUID);
    if (relInstance && relInstance instanceof RelationclassInstance) {
      const role_instance_to = relInstance.role_instance_to;
      if (role_instance_to) {
        const classUUID = relInstance.role_instance_to.uuid_has_reference_class_instance;
        const classInstance = await this.instanceUtility.getAnyInstance(classUUID);
        if (classInstance instanceof ClassInstance) {
          return classInstance;
        } else {
          return null;
        }
      }
    }
  }

  /**
   * Retrieves all relation class instances in the local client where the given instance is the destination (target) based on its UUID and optionally filters them by a specific relation type (metaClassUUID).
   * @param {string} instanceUUID - The UUID of any type of instance.
   * @param {string|null} [metaClassUUID=null] - Optional UUID of the relation class type to filter by.
   * @returns {Promise<RelationclassInstance[]>} - A promise resolving to an array of incoming relation class instances.
   */
  async getIncomingRelationsByInstanceUUID(
    instanceUUID: string,
    metaClassUUID: string | null = null,
  ): Promise<RelationclassInstance[]> {
    return this.instanceUtility.getIncomingRelationsFromInstance(instanceUUID, metaClassUUID);
  }

  /**
   * Retrieves all relation class instances in the local client where the given instance is the source (origin) based on its UUID and optionally filters them by a specific relation type (metaClassUUID).
   *
   * @param {string} instanceUUID - The UUID of any type of instance.
   * @param {string|null} [metaClassUUID=null] - Optional UUID of the relation class type to filter by.
   * @returns {Promise<RelationclassInstance[]>} - A promise resolving to an array of outgoing relation class instances.
   */
  async getOutgoingRelationsByInstanceUUID(
    instanceUUID: string,
    metaClassUUID: string | null = null,
  ): Promise<RelationclassInstance[]> {
    return this.instanceUtility.getOutgoingRelationsFromInstance(instanceUUID, metaClassUUID);
  }

  /**
   * Checks if any type of instance in the local client has both incoming and outgoing relations (i.e. is connected).
   *
   * @param {string} instanceUUID - The UUID of any type of instance.
   * @returns {Promise<boolean>} - A promise resolving to "true" if the instance is connected, or "false" otherwise.
   */
  async isConnected(instanceUUID: string): Promise<boolean> {
    const incomingRelations = await this.instanceUtility.getIncomingRelationsFromInstance(instanceUUID);
    const outgoingRelations = await this.instanceUtility.getOutgoingRelationsFromInstance(instanceUUID);
    return incomingRelations.length > 0 && outgoingRelations.length > 0;
  }

  /**
   * Wait for any vizRep update in flight to finish, then claim the lock for the update
   * we are about to request. The pipeline runs asynchronously, so without this two
   * requests could interleave and redraw against a half-updated instance.
   */
  private async claimVizRepUpdate(): Promise<void> {
    while (!this.globalObjectInstance.readyForVizRepUpdate) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    this.globalObjectInstance.readyForVizRepUpdate = false;
  }

  /** Ask the vizRep pipeline to re-evaluate the whole open scene. */
  async checkForVisualizationUpdate() {
    await this.claimVizRepUpdate();
    this.eventAggregator.publish("checkForVizRepUpdate");
  }

  /** Ask the vizRep pipeline to re-evaluate just the instance holding one attribute. */
  async checkForVisualizationUpdateByAttributeUUID(instanceUUID: string, metaAttributeUUID: string) {
    const attributeInstance = await this.findAttributeInstance(instanceUUID, metaAttributeUUID);
    if (!attributeInstance) return;

    await this.claimVizRepUpdate();
    this.eventAggregator.publish("checkForVizRepUpdateByAttributeInstance", attributeInstance);
  }

  /** The attribute instance of `metaAttributeUUID` on any kind of instance. */
  private async findAttributeInstance(instanceUUID: string, metaAttributeUUID: string): Promise<AttributeInstance | undefined> {
    const instance = await this.instanceUtility.getAnyInstance(instanceUUID);
    return this.instanceUtility.getAttributeInstanceFromAnyInstance(metaAttributeUUID, instance!.uuid, "uuid");
  }

  /**
   * Move the modelled URDF robot's joints, for an executing process model.
   *
   * WHOSE DECISION IT IS. Nothing here works out whether a Task should move the robot:
   * a command's text cannot tell a motion from a suction cup, and matching on the word
   * "move" breaks on "MoveL" and on the first model written in another language. The
   * procedure decides — from the flag the metamodel carries on the Primitive
   * configuration — and only then calls this.
   *
   * @param values Angles by URDF joint name, or an array in the robot's own joint
   *   order (what a controller's `angles: [j1…j6]` means).
   * @param options `degrees: true` for a controller that speaks degrees (a URDF holds
   *   radians); `robotKey` when more than one robot is loaded.
   */
  async setRobotJoints(values: JointValues, options?: MotionOptions): Promise<MotionResult> {
    return applyJointValues(values, options ?? {});
  }

  /**
   * A point on the canvas, in the robot's own base frame — the number to SEND.
   *
   * The canvas holds metres in the scene's frame, while a robot is commanded in its own
   * frame and commonly in millimetres. A Task placed where the tool should go is
   * therefore not yet a target: this is what turns it into one.
   *
   * @param point Somewhere on the canvas — a Task's `coordinates_2d`, usually.
   * @param options `poolUuid` names the Pool whose robot the point is relative to;
   *   `millimetres: true` returns mm for a controller that speaks them (a canvas metre
   *   becomes 1000).
   * @returns The converted point, or undefined when that Pool is not showing its robot.
   */
  robotFramePosition(
    point: { x: number; y: number; z: number },
    options: { poolUuid: string; millimetres?: boolean },
  ): { x: number; y: number; z: number } | undefined {
    return toRobotFrame(options.poolUuid, point, { millimetres: options.millimetres });
  }

  /**
   * The modelled robot's joint angles right now, in radians, by URDF joint name.
   *
   * What a simulation steps FROM: moving a joint in stages needs its starting value,
   * and that lives on the parsed URDF rather than in the process model.
   */
  getRobotJoints(options?: MotionOptions): Record<string, number> {
    return readJointValues(options ?? {});
  }

  /**
   * Move the modelled robot so its tool reaches a point, for a Cartesian command.
   *
   * Solved with inverse kinematics, which finds *a* pose that reaches the point rather
   * than the one the hardware chose: no orientation, no elbow preference, no collision
   * checking. Good enough to watch a program run, not a prediction of the robot. Where
   * the controller can report its own joint angles, feed those to `setRobotJoints`
   * instead — that is the truthful sync.
   *
   * @param target The tool position, in the robot's own frame.
   * @param options `millimetres: true` for a controller that speaks mm (a URDF holds
   *   metres); `tipLinkName` to solve for a link other than the end of the arm.
   */
  async moveRobotTo(target: IkTarget, options?: MotionOptions): Promise<MotionResult> {
    return applyCartesianTarget(target, options ?? {});
  }

  /** A cached file as a data-URL, for image and icon vizReps. */
  async getImageByUUID(fileUUID: UUID): Promise<string> {
    return this.fileUtility.FiletoDataUrl(this.metaUtility.getFileByUUID(fileUUID));
  }

  /** A cached file as raw bytes, for the glTF and URDF loaders. */
  async getGltfByUUID(fileUUID: UUID): Promise<ArrayBuffer> {
    return this.metaUtility.getFileByUUID(fileUUID).arrayBuffer();
  }
}

// Module singleton — one shared instance.
export const expressionUtility = new ExpressionUtility();
