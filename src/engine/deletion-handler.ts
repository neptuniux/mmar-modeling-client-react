import * as THREE from "three";
import { ClassInstance, AttributeInstance, UUID, RelationclassInstance, PortInstance, RoleInstance } from "@gds";
import { globalObject } from "@/engine/global-definition";
import { globalStateObject } from "@/engine/global-state-object";
import { globalSelectedObject } from "@/engine/global-selected-object";
import { graphicContext } from "@/engine/graphic-context";
import { instanceUtility } from "@/resources/services/instance-utility";
import { logger } from "@/resources/services/logger";
import { backendService } from "@/resources/services/backend-service";
import { eventBus } from "@/resources/services/event-bus";
import { publishLocalChange } from "@/resources/collaboration/local-change-publisher";
import { clearReferencesTo } from "@/resources/services/reference-cleanup";

/**
 * Deletes instances and everything that hangs off them.
 *
 * `onPressDelete` is the Delete-key entry point; it works out whether the selection is
 * a class or a relation instance and starts the cascade. The two delete methods recurse
 * into each other — deleting a class takes its connected relations and ports with it,
 * deleting a relation takes its bendpoints (which are themselves class instances) — so
 * the single undo step is recorded at the top, in `onPressDelete`.
 *
 * Each deletion removes the instance from the gds scene, from the THREE scene, from the
 * database (when auto-save is on), and announces it to peers and to the rest of the app.
 */export class DeletionHandler {
  private globalObjectInstance = globalObject;
  private globalStateObject = globalStateObject;
  private gc = graphicContext;
  private globalSelectedObject = globalSelectedObject;
  private instanceUtility = instanceUtility;
  private logger = logger;
  private fetchHelper = backendService;
  private eventAggregator = eventBus;

  async onPressDelete() {
    const sceneInstance = (await this.instanceUtility.getTabContextSceneInstance())!;

    let index: number | undefined;
    let index2: number | undefined;
    if (this.globalObjectInstance.current_class_instance) {
      index = sceneInstance.class_instances.findIndex((instance) => instance.uuid == this.globalObjectInstance.current_class_instance.uuid);
      index2 = sceneInstance.relationclasses_instances.findIndex((instance) => instance.uuid == this.globalObjectInstance.current_class_instance.uuid);
    }
    if (index !== undefined && index >= 0) {
      await this.deleteClassInstance(this.globalObjectInstance.current_class_instance, index);
    } else if (index2 !== undefined && index2 >= 0) {
      await this.deleteRelationclassInstance(this.globalObjectInstance.current_class_instance, index2);
    }

    // One undo step for the whole delete, cascade included. Recording here rather than
    // inside deleteClassInstance/deleteRelationclassInstance is deliberate: those two
    // recurse into each other (a class takes its relations, a relation takes its
    // bendpoints), so per-call recording would turn one keypress into a pile of steps.
    this.eventAggregator.publish("historyRecord", { label: "delete" });

    this.globalStateObject.setState(0);
  }

  async deleteClassInstance(classInstance: ClassInstance, index: number) {
    const sceneInstance = (await this.instanceUtility.getTabContextSceneInstance())!;
    //delete connected relationclassInstances
    await this.deleteConnectedRelationclassInstances(classInstance);

    //delete connected portInstances
    await this.deleteConnectedPortInstances(classInstance);

    // Clear the reference ATTRIBUTES that point at it. Relations are handled above, but
    // a reference attribute is not a relation and used to be left holding a role
    // instance for a deleted instance — harmless on the canvas, and fatal on the next
    // save, where it reaches a foreign key and takes the whole scene down with it.
    const clearedReferences = clearReferencesTo(
      sceneInstance,
      new Set([classInstance.uuid, ...classInstance.port_instance.map((port) => port.uuid)]),
      this.globalObjectInstance.role_instances,
    );
    for (const reference of clearedReferences) {
      this.logger.log(
        `Cleared "${reference.attributeName}" on ${reference.sourceName || reference.sourceUuid}: ` +
          `it referenced the deleted ${classInstance.name}`,
        "info",
      );
    }

    sceneInstance.class_instances.splice(index, 1);

    // Propagate deletion to peers before removing from the THREE scene.
    publishLocalChange({ type: "remove_class_instance", classInstanceUuid: classInstance.uuid });

    const object: THREE.Object3D = this.globalObjectInstance.scene.getObjectByProperty("uuid", classInstance.uuid)!;

    await this.gc.deleteObject(object as unknown as THREE.Mesh);

    //push to log file
    this.logger.log("Class Instance " + classInstance.name + " deleted", "done");

    this.globalSelectedObject.removeSelectionBoxHelper();
    this.globalSelectedObject.removeObject();

    let classInstanceIsBendpoint = false;
    //if the classInstance is a single bendpoint only we have to remove it from all relationclassInstances
    //we search trough all relationclassInstances and check if the classInstance is a single bendpoint
    for (const relationclassInstance of sceneInstance.relationclasses_instances) {
      // only bendpoints without first and last object
      let bendpointsonly = relationclassInstance.line_points;
      bendpointsonly = bendpointsonly.slice(1, bendpointsonly.length - 1);

      //find if the deleted classinstance exists as bendpoint in the relationclassInstance
      const indexOfObject = (bendpointsonly as { UUID: UUID; Point: THREE.Vector3 }[]).findIndex((linePoint) => {
        return linePoint.UUID == classInstance.uuid;
      });

      if (indexOfObject != -1) {
        relationclassInstance.line_points.splice(indexOfObject + 1, 1);
        classInstanceIsBendpoint = true;
      }
    }

    //delete all attributes of the classInstance
    for (const attributeInstance of classInstance.attribute_instance) {
      await this.deleteAttributeInstance(attributeInstance);
    }

    // delete classInstance from DB if autoSave is enabled
    // if bendpoint, call deleteBendpoint instead
    if (this.globalObjectInstance.autoSave) {
      try {
        if (classInstanceIsBendpoint) {
          await this.fetchHelper.bendpointInstanceDELETE(classInstance.uuid);
          this.logger.log(`Bendpoint with uuid ${classInstance.uuid} deleted from DB`, "info");
        } else {
          await this.fetchHelper.classesInstancesAllDELETE2(classInstance.uuid);
          this.logger.log(`ClassInstance with uuid ${classInstance.uuid} deleted from DB`, "info");
        }
      } catch (error) {
        this.logger.log(`Error deleting ClassInstance with uuid ${classInstance.uuid}: ${error}`, "error");
      }
    }
    this.globalObjectInstance.doSceneInstancePatch = true;

    this.announceDeletion(sceneInstance.uuid, "class", classInstance.uuid);
  }

  async deleteRelationclassInstance(_relationclassInstance: ClassInstance, index: number) {
    const sceneInstance = (await this.instanceUtility.getTabContextSceneInstance())!;
    const relationclassInstance = _relationclassInstance as RelationclassInstance;
    let role_from_instance;
    let role_to_instance;

    //find role_from_instance in gc.role_instances
    const role_from_instance_index = this.globalObjectInstance.role_instances.findIndex((role) => role.uuid == relationclassInstance.role_instance_from.uuid);
    if (role_from_instance_index != -1) {
      role_from_instance = this.globalObjectInstance.role_instances[role_from_instance_index];

      //delete role_from_instance in gc.role_instances
      this.globalObjectInstance.role_instances.splice(role_from_instance_index, 1);
      //push to log file
      this.logger.log("Role Instance " + role_from_instance.uuid + " deleted", "done");
    }

    //find role_to_instance in gc.role_instances
    let role_to_instance_index;
    if (relationclassInstance.role_instance_to) {
      role_to_instance_index = this.globalObjectInstance.role_instances.findIndex((role) => role.uuid == relationclassInstance.role_instance_to.uuid);
    }
    if (role_to_instance_index != -1 && role_to_instance_index != undefined) {
      role_to_instance = this.globalObjectInstance.role_instances[role_to_instance_index];

      //delete role_to_instance in gc.role_instances
      this.globalObjectInstance.role_instances.splice(role_to_instance_index, 1);
      //push to log file
      this.logger.log("Role Instance " + role_to_instance.uuid + " deleted", "done");
    }

    sceneInstance.relationclasses_instances.splice(index, 1);

    // Propagate deletion to peers.
    publishLocalChange({ type: "remove_relation_class_instance", relationClassInstanceUuid: relationclassInstance.uuid });

    const object: THREE.Object3D = this.globalObjectInstance.scene.getObjectByProperty("uuid", relationclassInstance.uuid)!;

    //push to log file
    this.logger.log("Relationclass Instance " + object.name + " deleted from THREE scene", "done");

    await this.gc.deleteObject(object as unknown as THREE.Mesh);
    //remove active state line
    this.globalStateObject.activeStateLine = undefined;

    //delete all bendpoints
    let listToDelete: { UUID: UUID; Point: THREE.Vector3 }[] = relationclassInstance.line_points as { UUID: UUID; Point: THREE.Vector3 }[];

    //cut first and last element
    listToDelete = listToDelete.slice(1, listToDelete.length - 1);

    for (const bendpoint of listToDelete) {
      await this.deleteBendpoint(bendpoint.UUID, relationclassInstance);
    }

    //remove from gc.updateLinesArray
    const lineIndex = this.globalObjectInstance.updateLinesArray.findIndex((line) => line.uuid == relationclassInstance.uuid);
    this.globalObjectInstance.updateLinesArray.splice(lineIndex, 1);

    //this.globalStateObject.setState(0);
    this.globalSelectedObject.removeObject();
    this.globalSelectedObject.removeSelectionBoxHelper();

    //delete all relationattributes of the classInstance
    for (const attributeInstance of relationclassInstance.attribute_instance) {
      await this.deleteAttributeInstance(attributeInstance);
    }

    // delete relationclassInstance from DB if autoSave is enabled
    if (this.globalObjectInstance.autoSave) {
      try {
        await this.fetchHelper.relationClassesInstancesAllDELETE2(relationclassInstance.uuid);
        this.logger.log(`RelationclassInstance with uuid ${relationclassInstance.uuid} deleted from DB`, "info");
      } catch (error) {
        this.logger.log(`Error deleting RelationclassInstance with uuid ${relationclassInstance.uuid}: ${error}`, "error");
      }
    }
    // !!! the api deletion strategy is not bullet proof. Thus, we patch the local sceneInstance again
    this.globalObjectInstance.doSceneInstancePatch = true;

    this.announceDeletion(sceneInstance.uuid, "relation", relationclassInstance.uuid);
  }

  /**
   * Tell the rest of the app (the SimulationWindow, for one) that the open scene lost
   * an instance. Consumers should debounce: one cascade fires this many times.
   */
  private announceDeletion(sceneInstanceUuid: string, kind: "class" | "relation", instanceUuid: string): void {
    this.eventAggregator.publish("sceneInstanceMutated", { sceneInstanceUuid, action: "deleted", kind, instanceUuid });
  }

  async deleteAttributeInstance(attributeInstance: AttributeInstance) {
    const index = this.globalObjectInstance.attribute_instances.findIndex((instance) => instance.uuid == attributeInstance.uuid);
    const instance: AttributeInstance[] = this.globalObjectInstance.attribute_instances.splice(index, 1);

    //push to log file
    this.logger.log("Attribute Instance " + instance[0].name + " deleted", "done");
  }

  async deleteBendpoint(bendpointUUID: UUID, relationclassInstance: RelationclassInstance, relationsOnly?: boolean) {
    const sceneInstance = (await this.instanceUtility.getTabContextSceneInstance())!;
    const linePoints: { UUID: UUID; Point: THREE.Vector3 }[] = relationclassInstance.line_points as { UUID: UUID; Point: THREE.Vector3 }[];

    //find linePoint in line_points array and delete it
    const linePoint = linePoints.find((linePoint) => {
      return linePoint.UUID === bendpointUUID;
    });
    const index = linePoints.indexOf(linePoint!);
    relationclassInstance.line_points.splice(index, 1);

    //remove bendpoint classInstance if not specified otherwise
    if (!relationsOnly) {
      const ClassInstance = sceneInstance.class_instances.find((classInstance) => classInstance.uuid == bendpointUUID);
      const classInstanceIndex = sceneInstance.class_instances.findIndex((classInstance) => classInstance.uuid == bendpointUUID);
      //let sceneInstanceIndex = sceneInstance.class_instances.findIndex(classInstance => classInstance.uuid == bendpointUUID);
      await this.deleteClassInstance(ClassInstance!, classInstanceIndex);
    }
  }

  /**
   * Delete every relation attached to a class instance or to a port instance. The
   * caller passes whichever one it has; relations are found through the role instances
   * that reference it.
   */
  async deleteConnectedRelationclassInstances(classInstance?: ClassInstance, portInstance?: PortInstance) {
    const sceneInstance = (await this.instanceUtility.getTabContextSceneInstance())!;
    const relationclassInstances: RelationclassInstance[] = sceneInstance.relationclasses_instances;
    const roleInstances: RoleInstance[] = this.globalObjectInstance.role_instances;

    const connectedRoles = roleInstances.filter((roleInstance) =>
      classInstance
        ? roleInstance.uuid_has_reference_class_instance == classInstance.uuid
        : portInstance
          ? roleInstance.uuid_has_reference_port_instance == portInstance.uuid
          : false,
    );

    for (const role of connectedRoles) {
      const connectedRelations = relationclassInstances.filter(
        (relationclassInstance) => relationclassInstance.role_instance_from.uuid == role.uuid || relationclassInstance.role_instance_to.uuid == role.uuid,
      );
      for (const relationclassInstance of connectedRelations) {
        // Re-read the index on every iteration: each delete splices the array.
        const index = relationclassInstances.findIndex((instance) => instance.uuid == relationclassInstance.uuid);
        await this.deleteRelationclassInstance(relationclassInstance, index);
      }
    }
  }

  async deleteConnectedPortInstances(classInstance: ClassInstance) {
    const portInstances = classInstance.port_instance;

    //delete connected relationclassInstances
    for (const portInstance of portInstances) {
      await this.deleteConnectedRelationclassInstances(undefined, portInstance);

      //push to log file
      this.logger.log("Port Instance " + portInstance.uuid + " deleted", "done");
    }
  }
}

// Module singleton — one shared instance.
export const deletionHandler = new DeletionHandler();
