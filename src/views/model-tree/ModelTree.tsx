import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Box,
  Chip,
  Collapse,
  IconButton,
  InputAdornment,
  List,
  ListItemButton,
  ListItemText,
  TextField,
  Typography,
} from "@mui/material";
import ExpandLess from "@mui/icons-material/ExpandLess";
import ExpandMore from "@mui/icons-material/ExpandMore";
import SearchIcon from "@mui/icons-material/Search";
import ClearIcon from "@mui/icons-material/Clear";
import type { ClassInstance, RelationclassInstance } from "@gds";
import { interactionHandler } from "@/engine";
import { instanceUtility } from "@/resources/services/instance-utility";
import { metaUtility } from "@/resources/services/meta-utility";
import { eventBus } from "@/resources/services/event-bus";
import { logger } from "@/resources/services/logger";
import { describeError } from "@/resources/util/describe-error";
import { useTabsStore } from "@/resources/store/tabsStore";
import { useSelectionStore } from "@/resources/store/selectionStore";

/**
 * The model tree: every object in the OPEN scene instance, grouped by its metaclass, with
 * relations in their own groups after the class groups. Clicking a row selects that
 * object on the canvas (gizmo + attribute window + selection box, exactly as a canvas
 * pick) and pans the camera to it — the point of the panel is to make objects in a large
 * scene reachable without hunting for their mesh.
 *
 * The list is derived from `instanceUtility.getTabContextSceneInstance()` — the same
 * in-place-mutated SceneInstance the engine holds — and rebuilt (debounced) on the bus
 * channels that signal its contents changed: `sceneInstanceMutated` (scene opened / undo
 * / redo), `tabChanged`, `updateSceneGroup`, `historyRecord` (canvas create), and
 * `removeAttributeGui` (canvas delete clears the selection through this channel). The
 * active tab index is also read reactively so switching tabs re-derives immediately.
 *
 * Row labels resolve the instance's "Name" attribute by the meta attribute's NAME
 * STRING ("Name"), matching how vizRep scripts do it, and fall back to the metaclass
 * name (which `instanceCreationHandler` writes into `instance.name`).
 */

interface TreeRow {
  uuid: string;
  label: string;
}

interface TreeGroup {
  /** Stable key for expand state + React — `class:<name>` / `relation:<name>`. */
  key: string;
  label: string;
  kind: "class" | "relation";
  rows: TreeRow[];
}

/** The instance's "Name" attribute value, or "" when it has none / it is blank. */
function nameAttributeValue(instance: ClassInstance | RelationclassInstance): string {
  const attributes = instance.attribute_instance ?? [];
  const nameAttribute = attributes.find((attribute) => attribute?.name === "Name");
  return nameAttribute?.value?.trim() ?? "";
}

function rowLabel(instance: ClassInstance | RelationclassInstance): string {
  const named = nameAttributeValue(instance);
  if (named) return named;
  const metaclassName = instance.name?.trim();
  if (metaclassName) return metaclassName;
  return `(${instance.uuid.slice(0, 8)})`;
}

function groupInstances(
  instances: (ClassInstance | RelationclassInstance)[],
  kind: "class" | "relation",
): TreeGroup[] {
  const byType = new Map<string, TreeRow[]>();
  for (const instance of instances) {
    const typeName = instance.name?.trim() || "(unnamed type)";
    const rows = byType.get(typeName) ?? [];
    rows.push({ uuid: instance.uuid, label: rowLabel(instance) });
    byType.set(typeName, rows);
  }
  return [...byType.entries()]
    .map(([typeName, rows]) => ({
      key: `${kind}:${typeName}`,
      label: typeName,
      kind,
      rows: rows.sort((a, b) => a.label.localeCompare(b.label)),
    }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

export default function ModelTree() {
  const selectedTab = useTabsStore((s) => s.selectedTab);
  const selectedUuid = useSelectionStore((s) => s.selectedInstanceUuid);

  const [groups, setGroups] = useState<TreeGroup[]>([]);
  const [hasScene, setHasScene] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState("");

  const mountedRef = useRef(true);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const rebuild = useCallback(async () => {
    const sceneInstance = await instanceUtility.getTabContextSceneInstance();
    if (!mountedRef.current) return;
    if (!sceneInstance) {
      setHasScene(false);
      setGroups([]);
      return;
    }
    setHasScene(true);

    // Exclude bendpoints: they live in `class_instances` but are line geometry, not
    // model objects. Their metaclass uuids are the `bendpoint` field of the scene
    // type's relation classes.
    let bendpointClassUuids = new Set<string>();
    try {
      const sceneType = await metaUtility.getTabContextSceneType();
      bendpointClassUuids = new Set(
        (sceneType?.relationclasses ?? [])
          .map((relationclass) => relationclass.bendpoint)
          .filter((uuid): uuid is string => Boolean(uuid)),
      );
    } catch (err) {
      logger.log(`ModelTree: could not resolve scene type — ${describeError(err)}`, "info");
    }
    if (!mountedRef.current) return;

    const classInstances = (sceneInstance.class_instances ?? []).filter(
      (classInstance) => !bendpointClassUuids.has(classInstance.uuid_class),
    );
    const relationInstances = sceneInstance.relationclasses_instances ?? [];

    setGroups([
      ...groupInstances(classInstances, "class"),
      ...groupInstances(relationInstances, "relation"),
    ]);
  }, []);

  const scheduleRebuild = useCallback(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      debounceRef.current = null;
      void rebuild().catch((err) =>
        logger.log(`ModelTree rebuild failed: ${describeError(err)}`, "error"),
      );
    }, 50);
  }, [rebuild]);

  // Rebuild on mount, on tab switch, and on the channels that signal the open scene's
  // contents changed. Handlers are never async — the bus does not await them.
  useEffect(() => {
    mountedRef.current = true;
    scheduleRebuild();

    const subs = [
      eventBus.subscribe("sceneInstanceMutated", scheduleRebuild),
      eventBus.subscribe("tabChanged", scheduleRebuild),
      eventBus.subscribe("updateSceneGroup", scheduleRebuild),
      eventBus.subscribe("historyRecord", scheduleRebuild),
      eventBus.subscribe("removeAttributeGui", scheduleRebuild),
    ];
    return () => {
      mountedRef.current = false;
      if (debounceRef.current) clearTimeout(debounceRef.current);
      subs.forEach((sub) => sub.dispose());
    };
  }, [scheduleRebuild]);

  // Tab switches swap the scene without always publishing on the channels above.
  useEffect(() => {
    scheduleRebuild();
  }, [selectedTab, scheduleRebuild]);

  const trimmedFilter = filter.trim().toLowerCase();

  const visibleGroups = useMemo(() => {
    if (!trimmedFilter) return groups;
    return groups
      .map((group) => ({
        ...group,
        rows: group.rows.filter((row) => row.label.toLowerCase().includes(trimmedFilter)),
      }))
      .filter((group) => group.rows.length > 0);
  }, [groups, trimmedFilter]);

  const totalRows = useMemo(
    () => groups.reduce((sum, group) => sum + group.rows.length, 0),
    [groups],
  );

  function toggleExpand(key: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function selectRow(uuid: string) {
    void interactionHandler
      .selectInstanceByUuid(uuid, { focusCamera: true })
      .catch((err) => logger.log(`ModelTree select failed: ${describeError(err)}`, "error"));
  }

  if (!hasScene) {
    return (
      <Box sx={{ p: 1 }}>
        <Typography variant="subtitle2" sx={{ fontWeight: 600 }}>
          Model tree
        </Typography>
        <Typography variant="caption" sx={{ display: "block", color: "text.secondary" }}>
          Open a scene to see its objects here.
        </Typography>
      </Box>
    );
  }

  return (
    <Box sx={{ p: 1 }}>
      <Typography variant="subtitle2" sx={{ fontWeight: 600 }}>
        Model tree
      </Typography>
      <Typography variant="caption" sx={{ display: "block", color: "text.secondary", mb: 0.5 }}>
        {totalRows} object{totalRows === 1 ? "" : "s"} — click one to select it on the canvas.
      </Typography>

      <TextField
        size="small"
        fullWidth
        placeholder="Filter objects…"
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
        sx={{ mb: 1 }}
        InputProps={{
          startAdornment: (
            <InputAdornment position="start">
              <SearchIcon fontSize="small" />
            </InputAdornment>
          ),
          endAdornment: filter ? (
            <InputAdornment position="end">
              <IconButton size="small" aria-label="clear filter" onClick={() => setFilter("")}>
                <ClearIcon fontSize="small" />
              </IconButton>
            </InputAdornment>
          ) : null,
        }}
      />

      {visibleGroups.length === 0 && (
        <Typography variant="caption" sx={{ fontStyle: "italic", opacity: 0.7 }}>
          {totalRows === 0 ? "This scene has no objects yet." : "No objects match the filter."}
        </Typography>
      )}

      <List dense disablePadding>
        {visibleGroups.map((group) => {
          const isOpen = expanded.has(group.key) || trimmedFilter.length > 0;
          return (
            <Fragment key={group.key}>
              <ListItemButton onClick={() => toggleExpand(group.key)} data-group={group.key}>
                <IconButton
                  size="small"
                  edge="start"
                  aria-label={isOpen ? "collapse" : "expand"}
                  sx={{ mr: 0.5 }}
                  onClick={(e) => {
                    e.stopPropagation();
                    toggleExpand(group.key);
                  }}
                >
                  {isOpen ? <ExpandLess fontSize="inherit" /> : <ExpandMore fontSize="inherit" />}
                </IconButton>
                <ListItemText
                  primary={
                    <span style={{ fontSize: "10pt" }}>
                      {group.label}
                      {group.kind === "relation" && (
                        <span style={{ fontSize: "7pt", color: "#888", marginLeft: 4 }}>
                          relation
                        </span>
                      )}
                    </span>
                  }
                />
                <Chip label={group.rows.length} size="small" sx={{ height: 18, fontSize: "8pt" }} />
              </ListItemButton>
              <Collapse in={isOpen} timeout="auto" unmountOnExit>
                <List dense disablePadding>
                  {group.rows.map((row) => (
                    <ListItemButton
                      key={row.uuid}
                      sx={{ pl: 4 }}
                      selected={selectedUuid === row.uuid}
                      onClick={() => selectRow(row.uuid)}
                      data-uuid={row.uuid}
                    >
                      <ListItemText primary={<span style={{ fontSize: "10pt" }}>{row.label}</span>} />
                    </ListItemButton>
                  ))}
                </List>
              </Collapse>
            </Fragment>
          );
        })}
      </List>
    </Box>
  );
}
