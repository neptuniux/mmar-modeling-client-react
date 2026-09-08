import type { AttributeInstance, ClassInstance, RoleInstance, SceneInstance } from "@gds";

/**
 * Reference attributes that point at instances which are no longer there.
 *
 * WHY THIS EXISTS. A reference attribute records its target on a role instance
 * (`role_instance_from.uuid_has_reference_class_instance`), and that column is a FOREIGN
 * KEY onto `class_instance`. Deleting the target used to leave the reference behind:
 * `deleteConnectedRelationclassInstances` clears the RELATIONS attached to a deleted
 * instance, but a reference attribute is not a relation, so nothing touched it.
 *
 * The consequence is out of all proportion to the cause. The pointer is harmless on the
 * canvas — the attribute just shows a stale name — but the next save sends it to a
 * database that refuses the whole scene over it, with an error naming a constraint. One
 * deleted Link makes an entire robot unsavable, and nothing on screen says why.
 *
 * So clearing a reference is part of deleting what it points at — at the one moment the
 * client KNOWS the target is gone.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO is hunt for references that look dangling. A client
 * only ever holds some of the model: a Pool's "Target system entity" points at a
 * Configuration system in ANOTHER scene, and "not in this scene" says nothing about
 * whether it exists. Clearing on that basis destroys good references. Judging that needs
 * the database, so the server judges it (`verify_class_references`), and says which
 * attribute to fix rather than quoting a constraint.
 */

/** A reference that was cleared, for the caller to report. */
export type ClearedReference = {
  /** The instance that held the reference. */
  sourceUuid: string;
  sourceName: string;
  /** The attribute it was on, and what it used to point at. */
  attributeUuid: string;
  attributeName: string;
  referencedUuid: string;
};

/** Every attribute instance of a scene, table columns and port attributes included. */
function* allAttributes(sceneInstance: SceneInstance): Generator<{ owner: ClassInstance; attribute: AttributeInstance }> {
  const owners = [
    ...(sceneInstance?.class_instances ?? []),
    ...((sceneInstance?.relationclasses_instances ?? []) as unknown as ClassInstance[]),
  ];

  function* walk(owner: ClassInstance, attributes: AttributeInstance[] | undefined): Generator<{ owner: ClassInstance; attribute: AttributeInstance }> {
    for (const attribute of attributes ?? []) {
      yield { owner, attribute };
      // A table cell is an attribute instance in its own right, and can reference.
      yield* walk(owner, attribute?.table_attributes);
    }
  }

  for (const owner of owners) {
    yield* walk(owner, owner?.attribute_instance);
    for (const port of owner?.port_instance ?? []) {
      yield* walk(owner, port?.attribute_instances);
    }
  }
}

/**
 * Drop the reference held by `attribute`, leaving it unset rather than pointing at
 * nothing. The empty value is what the server's rule engine treats as "no value to
 * check", so an emptied reference does not then fail its attribute type's regex.
 */
function clearOne(owner: ClassInstance, attribute: AttributeInstance, roleInstances?: RoleInstance[]): ClearedReference {
  const role = attribute.role_instance_from;
  const cleared: ClearedReference = {
    sourceUuid: owner?.uuid,
    sourceName: owner?.name ?? "",
    attributeUuid: attribute?.uuid,
    attributeName: attribute?.name ?? "",
    referencedUuid: role?.uuid_has_reference_class_instance as string,
  };

  if (roleInstances && role) {
    const index = roleInstances.findIndex((candidate) => candidate?.uuid === role.uuid);
    if (index !== -1) roleInstances.splice(index, 1);
  }

  attribute.role_instance_from = undefined as unknown as RoleInstance;
  attribute.value = "";
  return cleared;
}

/**
 * Clear every reference attribute of the scene that points at one of `deletedUuids`.
 * Called as part of deleting an instance, so the model never holds a pointer to
 * something that has gone.
 */
export function clearReferencesTo(
  sceneInstance: SceneInstance,
  deletedUuids: Set<string>,
  roleInstances?: RoleInstance[],
): ClearedReference[] {
  if (!sceneInstance || deletedUuids.size === 0) return [];

  const cleared: ClearedReference[] = [];
  for (const { owner, attribute } of allAttributes(sceneInstance)) {
    const referenced = attribute?.role_instance_from?.uuid_has_reference_class_instance;
    if (referenced && deletedUuids.has(referenced)) {
      cleared.push(clearOne(owner, attribute, roleInstances));
    }
  }
  return cleared;
}
