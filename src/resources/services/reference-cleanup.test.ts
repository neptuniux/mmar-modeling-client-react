import { describe, it, expect } from "vitest";
import type { ClassInstance, RoleInstance, SceneInstance } from "@gds";
import { clearReferencesTo } from "./reference-cleanup";

/**
 * Reference attributes left pointing at instances that are gone.
 *
 * WHAT THIS IS ABOUT. `role_instance_from.uuid_has_reference_class_instance` is a foreign
 * key. A reference to a deleted instance is invisible on the canvas and fatal on save:
 * the server refuses the WHOLE scene over it, naming a constraint rather than the
 * attribute. One deleted Link therefore made an entire imported robot unsavable.
 *
 * Only what is being DELETED is cleared. A reference whose target simply is not in this
 * scene is none of the client's business — it may well live in another one.
 *
 * Plain objects, no engine: this is the walk and the clearing, which is all of it.
 */

/** A class instance with one reference attribute, optionally inside a table column. */
function instance(
  uuid: string,
  name: string,
  reference?: { attributeName: string; targetUuid: string; roleUuid?: string; inTable?: boolean },
): ClassInstance {
  const referenceAttribute = reference
    ? {
        uuid: `${uuid}-ref`,
        name: reference.attributeName,
        value: "some target",
        role_instance_from: {
          uuid: reference.roleUuid ?? `${uuid}-role`,
          uuid_has_reference_class_instance: reference.targetUuid,
        },
      }
    : undefined;

  return {
    uuid,
    name,
    attribute_instance: [
      { uuid: `${uuid}-plain`, name: "Name", value: name },
      ...(reference && !reference.inTable ? [referenceAttribute] : []),
      ...(reference && reference.inTable
        ? [{ uuid: `${uuid}-table`, name: "Mimic", value: "", table_attributes: [referenceAttribute] }]
        : []),
    ],
    port_instance: [],
  } as unknown as ClassInstance;
}

function scene(instances: ClassInstance[]): SceneInstance {
  return { uuid: "scene", class_instances: instances, relationclasses_instances: [] } as unknown as SceneInstance;
}

describe("reference-cleanup", () => {
  describe("clearReferencesTo", () => {
    // The delete path: removing a Link must take the Joint's pointer to it with it.
    it("clears a reference attribute that points at a deleted instance", () => {
      const joint = instance("joint-1", "joint1", { attributeName: "Parent link", targetUuid: "link-1" });
      const model = scene([joint, instance("link-1", "link1")]);

      const cleared = clearReferencesTo(model, new Set(["link-1"]));

      expect(cleared).toHaveLength(1);
      expect(cleared[0]).toMatchObject({
        sourceUuid: "joint-1",
        attributeName: "Parent link",
        referencedUuid: "link-1",
      });
      const attribute = joint.attribute_instance[1];
      expect(attribute.role_instance_from).toBeUndefined();
      // Emptied rather than left with a stale name: "" is what the server's rule engine
      // treats as no value, so the cleared attribute does not then fail its own regex.
      expect(attribute.value).toBe("");
    });

    it("clears one held in a table column", () => {
      const joint = instance("joint-1", "joint1", {
        attributeName: "Joint ref",
        targetUuid: "joint-2",
        inTable: true,
      });

      expect(clearReferencesTo(scene([joint]), new Set(["joint-2"]))).toHaveLength(1);
      expect(joint.attribute_instance[1].table_attributes![0].role_instance_from).toBeUndefined();
    });

    it("leaves references to instances that are still there", () => {
      const joint = instance("joint-1", "joint1", { attributeName: "Parent link", targetUuid: "link-1" });

      expect(clearReferencesTo(scene([joint]), new Set(["link-9"]))).toEqual([]);
      expect(joint.attribute_instance[1].role_instance_from).toBeDefined();
    });

    it("drops the role instance from the engine's flat list too", () => {
      const joint = instance("joint-1", "joint1", {
        attributeName: "Parent link",
        targetUuid: "link-1",
        roleUuid: "role-7",
      });
      const roleInstances = [{ uuid: "role-7" }, { uuid: "role-8" }] as unknown as RoleInstance[];

      clearReferencesTo(scene([joint]), new Set(["link-1"]), roleInstances);

      expect(roleInstances.map((role) => role.uuid)).toEqual(["role-8"]);
    });
  });

});
