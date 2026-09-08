import URDFLoader from "urdf-loader";
import type { ClassInstance, SceneInstance, UUID } from "@gds";
import { urdfPoseService, type UrdfTaggedClassInstance } from "@/engine/hybrid-algorithms/urdf-pose-service";
import { backendService } from "@/resources/services/backend-service";
import { metaUtility } from "@/resources/services/meta-utility";
import { logger } from "@/resources/services/logger";
import { describeError } from "@/resources/util/describe-error";

/**
 * What makes an imported robot survive a save and a reload.
 *
 * A URDF import leaves two things on the instances that are NOT gds fields, so the
 * server drops both: the mesh (`urdfVizRep`, megabytes of glTF text or an ArrayBuffer
 * that `JSON.stringify` flattens to `{}`) and the URDF linkage tags (`urdfRobotKey` /
 * `urdfRef`) the pose service and the simulation sliders steer by. A saved robotic
 * scene therefore came back as bare metamodel vizReps with no robot behind them.
 *
 * The fix is to keep the BULK out of the scene payload and a REFERENCE inside it:
 *
 *   - Meshes and the URDF source go to the file store (`POST /metamodel/files`), the
 *     same place an uploaded glTF attribute goes, and only on save — an import the
 *     user never saves leaves no files behind.
 *   - Their uuids, plus the linkage tags, go into `custom_variables`, which IS a
 *     persisted column on every instance object (`INSTANCE_OBJECT_WRITE_FIELDS`).
 *
 * On load `hydrateMesh` turns a stored mesh reference back into the `urdfVizRep` the
 * persistency handler already knows how to draw, and `restoreRobots` re-parses the
 * stored URDF so `urdfPoseService` has a robot to re-pose again.
 */

/** The mesh payload stamped onto a link instance for the GraphicContext to draw. */
export type UrdfVizRep = {
  format: "gltf" | "glb" | "stl";
  data: string | ArrayBuffer;
  scale: number[];
};

/** A class instance carrying the mesh the robotics import resolved for it. */
type MeshedClassInstance = ClassInstance & { urdfVizRep?: UrdfVizRep };

/** `custom_variables.urdf` on a Link or Joint instance — what a reload rebuilds from. */
export type UrdfInstanceMeta = {
  robotKey: string;
  kind: "link" | "joint";
  name: string;
  mesh?: { fileUuid: UUID; format: UrdfVizRep["format"]; scale: number[] };
  /**
   * Where the simulation left this joint. The value lives on the parsed urdf-loader
   * joint, which a reload rebuilds from the stored URDF — that is, at the pose the URDF
   * DECLARES, not the one the scene was saved in. Without this the sliders all come back
   * reading zero and the first drag snaps the whole robot to its rest pose.
   */
  jointValue?: number;
};

/** One entry of `custom_variables.urdfRobots` on the scene instance. */
export type UrdfRobotMeta = { robotKey: string; fileUuid: UUID };

/** The MIME types the file store round-trips a mesh under. */
const GLTF_MIME = "model/gltf+json";
const BINARY_MIME = "application/octet-stream";

/**
 * Read `custom_variables` without disturbing it. gds revives the column into an object,
 * but a raw JSON string is what the database holds, so a value that reached the client
 * unrevived is parsed rather than treated as absent — the alternative is overwriting
 * whatever else lives in there (the engine keeps `scale` in the same place).
 */
function readCustomVariables(instance: { custom_variables?: unknown } | undefined): Record<string, unknown> | undefined {
  const variables = instance?.custom_variables;
  if (variables && typeof variables === "object") return variables as Record<string, unknown>;
  if (typeof variables !== "string") return undefined;
  try {
    const parsed = JSON.parse(variables) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/** The same, as something writable — normalising the instance in passing. */
function customVariablesOf(instance: { custom_variables?: unknown }): Record<string, unknown> {
  const variables = readCustomVariables(instance) ?? {};
  instance.custom_variables = variables;
  return variables;
}

/** The URDF metadata stored on a class instance, if it is part of an imported robot. */
export function readInstanceMeta(instance: ClassInstance): UrdfInstanceMeta | undefined {
  const stored = readCustomVariables(instance)?.["urdf"];
  if (!stored || typeof stored !== "object") return undefined;
  const meta = stored as UrdfInstanceMeta;
  return meta.name && (meta.kind === "link" || meta.kind === "joint") ? meta : undefined;
}

/** The robots stored on a scene instance. */
function readRobotMetas(sceneInstance: SceneInstance): UrdfRobotMeta[] {
  const stored = readCustomVariables(sceneInstance)?.["urdfRobots"];
  return Array.isArray(stored) ? (stored as UrdfRobotMeta[]).filter((entry) => entry?.fileUuid) : [];
}

/**
 * Record a link/joint instance as part of `robotKey`'s robot. Called for every instance
 * a URDF import creates, so the linkage survives in `custom_variables` even though the
 * `urdfRobotKey` / `urdfRef` tags beside it do not.
 */
export function tagInstance(instance: ClassInstance, meta: Omit<UrdfInstanceMeta, "mesh">): void {
  const variables = customVariablesOf(instance);
  const existing = readInstanceMeta(instance);
  variables["urdf"] = { ...existing, ...meta } satisfies UrdfInstanceMeta;
}

/**
 * Remember where the simulation put a joint, so the next save carries it. Called with
 * the value that was actually applied to the robot, never with one that was refused.
 */
export function recordJointValue(instance: ClassInstance, jointValue: number): void {
  const meta = readInstanceMeta(instance);
  // Only a joint that came from a URDF import has a value worth keeping; anything else
  // has no robot behind it to replay the value against.
  if (!meta || meta.kind !== "joint" || !Number.isFinite(jointValue)) return;
  customVariablesOf(instance)["urdf"] = { ...meta, jointValue } satisfies UrdfInstanceMeta;
}

/**
 * The URDF source of a robot imported in this session, kept until the scene is saved.
 *
 * It is held here rather than on the SceneInstance because the scene is JSON-serialized
 * on every save and every history snapshot, and the XML has no business in either.
 * Keyed by scene uuid, so importing into two open tabs keeps both.
 */
const pendingUrdfSources = new Map<string, { robotKey: string; xml: string }[]>();

/** Remember the URDF a scene was just given, for the next save to upload. */
export function rememberUrdfSource(sceneInstanceUuid: string, robotKey: string, xml: string): void {
  const pending = pendingUrdfSources.get(sceneInstanceUuid) ?? [];
  // A re-import of the same robot replaces the source rather than stacking a second one.
  const next = pending.filter((entry) => entry.robotKey !== robotKey);
  next.push({ robotKey, xml });
  pendingUrdfSources.set(sceneInstanceUuid, next);
}

function fileFor(vizRep: UrdfVizRep, baseName: string): File {
  if (vizRep.format === "gltf") {
    return new File([vizRep.data as string], `${baseName}.gltf`, { type: GLTF_MIME });
  }
  const bytes = new Uint8Array(vizRep.data as ArrayBuffer);
  return new File([bytes], `${baseName}.${vizRep.format}`, { type: BINARY_MIME });
}

/** Upload one file and return the uuid the file store minted for it. */
async function uploadFile(file: File): Promise<UUID | undefined> {
  const response = (await backendService.postFile(file)) as { uuid?: UUID } | undefined;
  const uuid = response?.uuid;
  if (!uuid) return undefined;
  // Seed the client-side file cache so a hydrate later in this session does not go back
  // to the server for bytes we already hold.
  await metaUtility.setFile(uuid, file);
  return uuid;
}

/**
 * Upload whatever an imported robot needs to outlive this session, and write the
 * references into `custom_variables`. Runs just before the scene PATCH.
 *
 * A failed upload is logged and skipped rather than thrown: the rest of the scene is
 * still worth saving, and the instance simply keeps drawing from its in-memory mesh
 * until the next save gets another chance at it.
 */
export async function persistSceneAssets(sceneInstance: SceneInstance): Promise<void> {
  if (!sceneInstance) return;

  // One upload per distinct mesh: the import shares a single UrdfVizRep object between
  // every link that references the same mesh file, so object identity is the key.
  const uploaded = new Map<UrdfVizRep, UUID>();

  for (const classInstance of sceneInstance.class_instances ?? []) {
    const meta = readInstanceMeta(classInstance);
    const vizRep = (classInstance as MeshedClassInstance).urdfVizRep;
    if (!meta || !vizRep || meta.mesh) continue;

    try {
      let fileUuid = uploaded.get(vizRep);
      if (!fileUuid) {
        fileUuid = await uploadFile(fileFor(vizRep, meta.name || classInstance.uuid));
        if (!fileUuid) throw new Error("the file store returned no uuid");
        uploaded.set(vizRep, fileUuid);
      }
      customVariablesOf(classInstance)["urdf"] = {
        ...meta,
        mesh: { fileUuid, format: vizRep.format, scale: vizRep.scale },
      } satisfies UrdfInstanceMeta;
    } catch (error) {
      logger.log(`Could not store the mesh of '${meta.name}': ${describeError(error)}`, "error");
    }
  }

  await persistPendingUrdfSources(sceneInstance);
}

/** Upload the URDF documents imported into this scene and reference them on it. */
async function persistPendingUrdfSources(sceneInstance: SceneInstance): Promise<void> {
  const pending = pendingUrdfSources.get(sceneInstance.uuid);
  if (!pending?.length) return;

  const robots = readRobotMetas(sceneInstance);
  const left: { robotKey: string; xml: string }[] = [];

  for (const source of pending) {
    const { robotKey, xml } = source;
    try {
      const fileUuid = await uploadFile(new File([xml], `${robotKey}.urdf`, { type: "text/xml" }));
      if (!fileUuid) throw new Error("the file store returned no uuid");
      const index = robots.findIndex((entry) => entry.robotKey === robotKey);
      if (index === -1) robots.push({ robotKey, fileUuid });
      else robots[index] = { robotKey, fileUuid };
    } catch (error) {
      logger.log(`Could not store the URDF of '${robotKey}': ${describeError(error)}`, "error");
      // Only what reached the server is forgotten; the rest waits for the next save.
      left.push(source);
    }
  }

  if (robots.length > 0) customVariablesOf(sceneInstance)["urdfRobots"] = robots;
  if (left.length > 0) pendingUrdfSources.set(sceneInstance.uuid, left);
  else pendingUrdfSources.delete(sceneInstance.uuid);
}

/** The file behind a uuid, from the session cache when it is already there. */
async function loadFile(fileUuid: UUID): Promise<File | undefined> {
  const cached = metaUtility.Files.get(fileUuid)?.[0];
  if (cached) return cached;

  const file = await backendService.getFileByUUID(fileUuid);
  if (file) await metaUtility.setFile(fileUuid, file);
  return file;
}

/**
 * The mesh of a saved link, as the `urdfVizRep` the draw pass expects.
 *
 * The rebuilt mesh is stamped back onto the instance, so the second draw pass of a
 * scene — and every redraw after it — costs nothing.
 */
export async function hydrateMesh(classInstance: ClassInstance): Promise<UrdfVizRep | undefined> {
  const instance = classInstance as MeshedClassInstance;
  // `format && data` rather than a plain truthiness check: an engine-only property that
  // went through a JSON round trip anyway arrives as a mesh-shaped object with nothing
  // in it, and handing that to the GraphicContext draws no mesh and no fallback either.
  if (instance.urdfVizRep?.format && instance.urdfVizRep.data) return instance.urdfVizRep;

  const mesh = readInstanceMeta(classInstance)?.mesh;
  if (!mesh?.fileUuid) return undefined;

  try {
    const file = await loadFile(mesh.fileUuid);
    if (!file) return undefined;

    const data = mesh.format === "gltf" ? await file.text() : await file.arrayBuffer();
    const vizRep: UrdfVizRep = { format: mesh.format, data, scale: mesh.scale ?? [1, 1, 1] };
    instance.urdfVizRep = vizRep;
    return vizRep;
  } catch (error) {
    logger.log(`Could not load the stored mesh of ${classInstance.uuid}: ${describeError(error)}`, "error");
    return undefined;
  }
}

/**
 * Re-register every robot a saved scene holds, so joint Origin edits and the simulation
 * sliders work on a reopened scene exactly as they do right after an import.
 *
 * The linkage tags the pose service reads are stamped back onto the instances here:
 * they are the in-memory half of what `tagInstance` wrote to `custom_variables`.
 */
export async function restoreRobots(sceneInstance: SceneInstance): Promise<void> {
  const robots = readRobotMetas(sceneInstance);
  if (robots.length === 0) return;

  // Re-tag first: an instance whose robot fails to load still gets its tags back, which
  // is what the table dialog checks before offering a URDF-aware edit.
  const links = new Map<string, ClassInstance[]>();
  const joints = new Map<string, ClassInstance[]>();
  for (const classInstance of sceneInstance.class_instances ?? []) {
    const meta = readInstanceMeta(classInstance);
    if (!meta) continue;
    const tagged = classInstance as UrdfTaggedClassInstance;
    tagged.urdfRobotKey = meta.robotKey;
    tagged.urdfRef = { kind: meta.kind, name: meta.name };
    const bucket = meta.kind === "link" ? links : joints;
    bucket.set(meta.robotKey, [...(bucket.get(meta.robotKey) ?? []), classInstance]);
  }

  for (const { robotKey, fileUuid } of robots) {
    // A scene can list a robot whose instances are gone — an import that was replaced
    // leaves its entry behind. Registering that phantom is worse than ignoring it: it
    // occupies the scene's robot slot with something that has no joints to move, and
    // whatever asks the scene for "its robot" can get the empty one.
    if ((links.get(robotKey)?.length ?? 0) === 0 && (joints.get(robotKey)?.length ?? 0) === 0) {
      logger.log(
        `The scene lists a robot '${robotKey}' but holds no links or joints for it — ignoring it`,
        "info",
      );
      continue;
    }

    try {
      const file = await loadFile(fileUuid);
      if (!file) throw new Error("the stored URDF is no longer in the file store");

      // Same parser settings as the import: the meshes are ours to resolve, and
      // urdf-loader would otherwise try to fetch them over HTTP.
      const loader = new URDFLoader();
      loader.parseVisual = false;
      loader.parseCollision = false;
      const robot = loader.parse(await file.text());

      // Replay the simulation onto the rest pose the URDF declares. Without this the
      // robot is registered at its default joint values while the scene draws the saved
      // ones, and the first slider drag snaps every link back to that rest pose.
      for (const jointInstance of joints.get(robotKey) ?? []) {
        const meta = readInstanceMeta(jointInstance);
        if (!meta || !Number.isFinite(meta.jointValue)) continue;
        robot.joints?.[meta.name]?.setJointValue?.(meta.jointValue!);
      }
      robot.updateMatrixWorld?.(true);

      // scaleFactor 1 mirrors the import; see `processZipUrdf`.
      urdfPoseService.registerRobot(
        robotKey,
        robot,
        1,
        links.get(robotKey) ?? [],
        joints.get(robotKey) ?? [],
        // Which scene this robot belongs to: a process model names its robot by the
        // scene its Pool points at, never by the URDF name this key comes from.
        sceneInstance.uuid,
      );
    } catch (error) {
      logger.log(`Could not restore the robot '${robotKey}': ${describeError(error)}`, "error");
    }
  }
}

/** Test seam: forget the URDF sources waiting to be uploaded. */
export function clearPendingUrdfSources(): void {
  pendingUrdfSources.clear();
}
