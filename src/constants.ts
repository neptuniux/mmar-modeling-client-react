/**
 * UUIDs of concrete metamodel objects the modeling client's behaviour depends on.
 *
 * These are contracts with the DATABASE, not arbitrary constants: each one identifies a
 * row of the demo metamodel. They live here rather than inline at their use sites so the
 * mapping stays greppable — do not regenerate or "tidy" them.
 */

/**
 * AttributeType "File". Attribute instances whose meta attribute has this type get
 * the upload / delete / download buttons in the attribute window.
 *
 * NOTE: no attribute of this type exists in the demo metamodel, so that branch is
 * unreachable with demo data; the file endpoints themselves are covered by an
 * integration test.
 */
export const FILE_ATTRIBUTE_TYPE_UUID = "2df15b5e-6b43-4911-b38b-0fc5747a8ee6";

/**
 * The meta Attribute "Object 3D" — rendered as a glTF upload button instead of a text
 * field. Present on ObjectSpace's Detectable and Augmentation classes.
 */
export const OBJECT_3D_ATTRIBUTE_UUID = "b058b3b4-b523-4ffe-b08e-4f8dda2831c8";

/**
 * The meta Attribute "Image to detect" — rendered as an image upload button. Also on
 * ObjectSpace's Detectable / Augmentation classes.
 */
export const IMAGE_TO_DETECT_ATTRIBUTE_UUID = "d334dd62-5651-4d0f-a7a0-13718f20da36";

/**
 * SceneType "Robotic system" — the table dialog and the simulation window run the
 * robotics algorithms only for scenes of this type.
 */
export const ROBOTIC_SYSTEM_SCENETYPE_UUID = "113c3133-bf77-493a-a36f-553e77832280";

/**
 * Sentinel default values. The upload buttons flip their label ("Upload" vs "Replace")
 * by comparing the attribute value against the meta default, rather than by checking
 * whether real content is present.
 */
export const OBJECT_3D_DEFAULT_VALUE = "3D Object String";
export const IMAGE_DEFAULT_VALUE = "Image";

/* ------------------------------------------------------------------------- *
 * Hybrid algorithms + simulation window.
 * ------------------------------------------------------------------------- */

/** SceneType "ObjectSpace" — gates the augmentation / detectable algorithms. */
export const OBJECTSPACE_SCENETYPE_UUID = "a3b35b86-2636-4987-8cc4-814f468f6c4b";

/** SceneType "Statechange" — gates the reference algorithm. */
export const STATECHANGE_SCENETYPE_UUID = "239c5597-6cc9-498a-bf61-432cf85b3835";

/**
 * AttributeType "Mechanism". An attribute of this type holds a function body that the
 * animator runs on every render tick while `globalObject.runMechanism` is set.
 */
export const MECHANISM_ATTRIBUTE_TYPE_UUID = "a8e33bad-9eed-4a24-a4b2-406c5439d13a";

/** Class "Joint" of the Robotic system metamodel — one slider per instance. */
export const META_JOINT_UUID = "c5cf9a3c-988a-4fd4-87e5-0ad8fcc7234b";

/** Class "Reference" of the Statechange metamodel. */
export const REFERENCE_CLASS_UUID = "ada138a9-646c-4df4-8622-fb79092a9ad0";

/* ------------------------------------------------------------------------- *
 * BPMN — a Pool that shows the robot it references.
 * ------------------------------------------------------------------------- */

/** SceneType "Business Process Model and Notation". */
export const BPMN_SCENETYPE_UUID = "5e37e51c-e420-438c-9747-e9424723b4cd";

/** Class "Pool" of the BPMN metamodel. */
export const POOL_CLASS_UUID = "f17b9921-8bcb-4d4f-bcbf-db035a47fb3c";

/**
 * Attribute "Target system entity" on the Pool: its reference to the Configuration
 * system, which is in turn what references the Robotic system scene.
 *
 * The attribute used to sit on the Task and kept its uuid when it moved to the Pool, so
 * this is the same identifier the execution procedure has always used for it.
 */
export const POOL_TARGET_SYSTEM_ATTRIBUTE_UUID = "9e72ed99-8f4f-41aa-aa3f-4b40b53810a7";

/**
 * Attribute "Show referenced URDF system" on the BPMN Pool: while it holds "true", the
 * robot of the Robotic system scene the Pool references is drawn inside the Pool.
 *
 * Matched by uuid OR by name (case-insensitively): the uuid is the contract with the
 * database like every other constant here, and the name keeps the feature working for a
 * Pool whose attribute was re-created — a re-created attribute keeps its name and loses
 * its uuid, and a silently blank Pool is a poor way to learn that.
 */
export const SHOW_REFERENCED_URDF_ATTRIBUTE_UUID = "ec657492-ec07-4640-979e-acd7607419e9";
export const SHOW_REFERENCED_URDF_ATTRIBUTE_NAME = "Show referenced URDF system";

/** Class "Task" of the BPMN metamodel. */
export const TASK_CLASS_UUID = "cb78cd9b-7a3e-4684-9e42-33ba3d7973e2";

/** RelationClass "Message Flow": what connects a Task to the Pool it acts on. */
export const MESSAGE_FLOW_RELATIONCLASS_UUID = "8f560497-4004-4bd3-9339-df85d00d3b07";

/** Attribute "Primitive configuration" on the Task — the action it performs. */
export const TASK_PRIMITIVE_CONFIG_ATTRIBUTE_UUID = "70fbe822-7204-453b-92f4-5c99246d0396";

/**
 * Attribute "Motion effect" on the Primitive configuration: whether the action moves the
 * arm, and in what units (`none | joint-rad | joint-deg | cartesian-m | cartesian-mm`).
 *
 * Read by NAME — it is a recent addition, and a metamodel that has not got it yet simply
 * reports no motion. The match normalises case and punctuation ("Motion Effect",
 * "motion_effect"), because the alternative is an attribute that looks right, reads as
 * "no motion", and says nothing about why the robot never moved.
 */
export const MOTION_EFFECT_ATTRIBUTE_NAME = "Motion effect";

/**
 * The robot's base frame, on the Configuration system the Pool references.
 *
 * THE CONVENTION. This client draws in METRES — a URDF import writes URDF coordinates
 * straight into the canvas, and ObjectSpace sizes a Detectable by its "size in meters" —
 * so a Pool's position is a place in the cell, and these say where the robot's base sits
 * within it: an offset in metres, and which way the arm faces. Together they are the
 * whole mapping between the model and the real workspace, which is what makes a Task's
 * position a coordinate a robot can be sent.
 *
 * Matched by NAME, loosely: "Base X", "Base X (m)" and "base_x" all count, because these
 * are attributes you add to your own metamodel rather than rows this repository ships.
 * A Configuration system without them places its robot at the Pool's origin, facing 0.
 */
export const ROBOT_BASE_ATTRIBUTE_NAMES = {
  x: "Base X",
  y: "Base Y",
  z: "Base Z",
  /** Degrees: a human declares a robot's facing in degrees, not radians. */
  yaw: "Base yaw",
} as const;

/** Attribute "Augmentation_Reference" on the Statechange Reference class. */
export const AUGMENTATION_REFERENCE_ATTRIBUTE_UUID = "b8d05324-ed3b-4c10-885a-164ec15a0f36";

/** Attribute "size in meters" on the ObjectSpace Detectable class. */
export const SIZE_IN_METERS_ATTRIBUTE_UUID = "c1d9b467-08d8-4350-aa62-a47d6939b6ec";

/**
 * The Reference class's pose attributes. `updateReferenceClassAttributeInstanceValues`
 * writes the three.js object's pose into them once a second (the canvas heartbeat) and
 * `updateThreejsObject` reads them back — but only while the corresponding Set Position
 * / Set Rotation flag attribute holds the string "true".
 */
export const REFERENCE_POSITION_X_ATTRIBUTE_UUID = "5a038d67-bc1a-4881-86e8-f53f37dae5d6";
export const REFERENCE_POSITION_Y_ATTRIBUTE_UUID = "455eae8f-35c7-44f9-8909-468972f53341";
export const REFERENCE_POSITION_Z_ATTRIBUTE_UUID = "d84b02fd-3c04-4612-82f5-b7a1eb95a7c4";
export const REFERENCE_ROTATION_X_ATTRIBUTE_UUID = "21ae60ea-be54-432c-a7c5-c66085f098a8";
export const REFERENCE_ROTATION_Y_ATTRIBUTE_UUID = "35eaa212-71c2-4b15-8da9-4dc29be6b4e4";
export const REFERENCE_ROTATION_Z_ATTRIBUTE_UUID = "8a4d3bc4-3dfb-4145-983c-dafe42a4b26e";
export const REFERENCE_ROTATION_W_ATTRIBUTE_UUID = "e4e03c44-63e9-4d36-9304-a8fea5300cd3";
export const REFERENCE_SET_ROTATION_ATTRIBUTE_UUID = "3a5b4525-4616-49f5-a5b1-2f9f4d8ec483";
export const REFERENCE_SET_POSITION_ATTRIBUTE_UUID = "043daf98-2cdd-4b85-9e7a-8d983c43f565";
