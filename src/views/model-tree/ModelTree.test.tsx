// @vitest-environment jsdom
//
// Component tests for ModelTree: it groups the open scene's instances by metaclass
// (bendpoints excluded), labels rows by the "Name" attribute with a metaclass-name
// fallback, drives canvas selection on click, and mirrors the canvas selection back.
// `@/engine` and the utilities are mocked (the real barrel builds a WebGLRenderer at
// module scope); eventBus + the stores are the real singletons.
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";

const mocks = vi.hoisted(() => ({
  interactionHandler: { selectInstanceByUuid: vi.fn(async () => undefined) },
  instanceUtility: {
    getTabContextSceneInstance: vi.fn(async (): Promise<unknown> => undefined),
  },
  metaUtility: {
    getTabContextSceneType: vi.fn(async () => ({ relationclasses: [{ bendpoint: "BP" }] })),
  },
}));

vi.mock("@/engine", () => ({ interactionHandler: mocks.interactionHandler }));
vi.mock("@/resources/services/instance-utility", () => ({ instanceUtility: mocks.instanceUtility }));
vi.mock("@/resources/services/meta-utility", () => ({ metaUtility: mocks.metaUtility }));

import ModelTree from "./ModelTree";
import { eventBus } from "@/resources/services/event-bus";
import { useSelectionStore } from "@/resources/store/selectionStore";
import { useTabsStore } from "@/resources/store/tabsStore";

const SCENE = {
  uuid: "scene-1",
  class_instances: [
    { uuid: "c1", uuid_class: "Task", name: "Task", attribute_instance: [{ name: "Name", value: "Review order" }] },
    { uuid: "c2", uuid_class: "Task", name: "Task", attribute_instance: [] },
    { uuid: "g1", uuid_class: "Gateway", name: "Gateway", attribute_instance: [] },
    { uuid: "bp1", uuid_class: "BP", name: "BendPoint", attribute_instance: [] },
  ],
  relationclasses_instances: [
    { uuid: "r1", name: "Sequence Flow", attribute_instance: [] },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  cleanup();
  useSelectionStore.getState().clearSelection();
  useTabsStore.setState({ tabs: [], selectedTab: 0 });
  mocks.instanceUtility.getTabContextSceneInstance.mockResolvedValue(SCENE);
  mocks.metaUtility.getTabContextSceneType.mockResolvedValue({ relationclasses: [{ bendpoint: "BP" }] });
});

async function expandGroup(key: string) {
  const header = await screen.findByText(
    key === "class:Task" ? "Task" : key === "class:Gateway" ? "Gateway" : "Sequence Flow",
  );
  fireEvent.click(header);
}

describe("ModelTree", () => {
  it("groups instances by metaclass and excludes bendpoints", async () => {
    render(<ModelTree />);

    // class groups + the relation group, but no BendPoint group
    expect(await screen.findByText("Task")).toBeTruthy();
    expect(screen.getByText("Gateway")).toBeTruthy();
    expect(screen.getByText("Sequence Flow")).toBeTruthy();
    expect(screen.queryByText("BendPoint")).toBeNull();

    // "3 objects" — 2 Tasks + 1 Gateway, bendpoint not counted (relations counted too => 4)
    expect(screen.getByText(/4 objects/)).toBeTruthy();
  });

  it("labels a row by its Name attribute, falling back to the metaclass name", async () => {
    render(<ModelTree />);
    await expandGroup("class:Task");

    expect(await screen.findByText("Review order")).toBeTruthy();
    // c2 has no Name attribute -> falls back to "Task"
    const rows = screen.getAllByText("Task");
    // one is the group header, one is the c2 row label
    expect(rows.length).toBeGreaterThanOrEqual(2);
  });

  it("selects the object on the canvas (with camera focus) when a row is clicked", async () => {
    render(<ModelTree />);
    await expandGroup("class:Task");

    fireEvent.click(await screen.findByText("Review order"));

    expect(mocks.interactionHandler.selectInstanceByUuid).toHaveBeenCalledWith("c1", { focusCamera: true });
  });

  it("marks the row for the current canvas selection as selected", async () => {
    render(<ModelTree />);
    await expandGroup("class:Gateway");
    await screen.findAllByText("Gateway");

    useSelectionStore.getState().setSelection("g1", "class");

    await waitFor(() => {
      const row = document.querySelector('[data-uuid="g1"]');
      expect(row?.className).toContain("Mui-selected");
    });
  });

  it("filters rows by label", async () => {
    render(<ModelTree />);
    await screen.findByText("Task");

    fireEvent.change(screen.getByPlaceholderText("Filter objects…"), {
      target: { value: "review" },
    });

    // matching group auto-expands and shows the row; the non-matching Gateway group is gone
    expect(await screen.findByText("Review order")).toBeTruthy();
    await waitFor(() => expect(screen.queryByText("Gateway")).toBeNull());
  });

  it("shows an empty-state when no scene is open", async () => {
    mocks.instanceUtility.getTabContextSceneInstance.mockResolvedValue(undefined);
    render(<ModelTree />);

    expect(await screen.findByText("Open a scene to see its objects here.")).toBeTruthy();
  });

  it("rebuilds when a sceneInstanceMutated event fires", async () => {
    mocks.instanceUtility.getTabContextSceneInstance.mockResolvedValue(undefined);
    render(<ModelTree />);
    await screen.findByText("Open a scene to see its objects here.");

    mocks.instanceUtility.getTabContextSceneInstance.mockResolvedValue(SCENE);
    eventBus.publish("sceneInstanceMutated", { sceneInstanceUuid: "scene-1" });

    expect(await screen.findByText("Task")).toBeTruthy();
  });
});
