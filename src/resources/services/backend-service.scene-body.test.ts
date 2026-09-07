// @vitest-environment jsdom
//
// What the scene save actually puts on the wire. The engine hangs a URDF mesh off the
// class instances it draws, and that property used to be serialized straight into the
// PATCH: a whole glTF document per link (or `{}`, for a binary mesh that JSON.stringify
// cannot represent), which the server discards after receiving it — and which, for a
// robot of any size, pushed the request past the body limit and failed the save.
//
// `apiFetch` is mocked so the body can be read back; everything else here is real.
import { describe, it, expect, beforeEach, vi } from "vitest";
import { SceneInstance } from "@gds";

const mocks = vi.hoisted(() => ({
  apiFetch: vi.fn(async (_path: string, _init: RequestInit) => ({
    ok: true,
    status: 200,
    json: async () => ({ uuid: "s-1" }),
  })),
}));
vi.mock("./api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./api")>()),
  apiFetch: mocks.apiFetch,
}));
vi.mock("./token", () => ({ getToken: () => "token" }));

const { backendService } = await import("./backend-service");

function sceneWithMeshedLink(): SceneInstance {
  const scene = SceneInstance.fromJS({
    uuid: "s-1",
    name: "Robot scene",
    uuid_scene_type: "st-1",
    class_instances: [
      {
        uuid: "link-1",
        uuid_class: "c-1",
        coordinates_2d: { x: 0, y: 0, z: 0 },
        custom_variables: { urdf: { robotKey: "r", kind: "link", name: "base_link" } },
      },
    ],
  }) as SceneInstance;
  // What the URDF import leaves on a link: not a gds field, and not JSON either.
  (scene.class_instances[0] as unknown as { urdfVizRep: unknown }).urdfVizRep = {
    format: "gltf",
    data: '{"asset":{"version":"2.0"}}',
    scale: [1, 1, 1],
  };
  return scene;
}

describe("backend-service scene bodies", () => {
  beforeEach(() => vi.clearAllMocks());

  it("leaves the engine's mesh out of the scene PATCH, and keeps its file reference in", async () => {
    await backendService.sceneInstancesPATCH("s-1", sceneWithMeshedLink());

    const [, init] = mocks.apiFetch.mock.calls[0];
    const body = String(init.body);
    expect(body).not.toContain("urdfVizRep");
    expect(body).not.toContain("asset");
    // custom_variables is a real column, and is what carries the robot across a save.
    expect(JSON.parse(body).class_instances[0].custom_variables.urdf.name).toBe("base_link");
  });

  it("leaves it out of the scene POST as well", async () => {
    await backendService.sceneInstancesPOST("st-1", sceneWithMeshedLink());

    const [, init] = mocks.apiFetch.mock.calls[0];
    expect(String(init.body)).not.toContain("urdfVizRep");
  });
});
