import { useCallback, useEffect, useState } from "react";
import {
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControl,
  InputLabel,
  MenuItem,
  Select,
  Slider,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  TextField,
  Typography,
} from "@mui/material";
import type { Attribute, AttributeInstance, Class, ClassInstance, PortInstance } from "@gds";
// ColumnStructure is not re-exported from the gds barrel, so it is deep-imported.
import type { ColumnStructure } from "@gds/models/meta/Metamodel_columns.structure";
import { globalObject, instanceCreationHandler } from "@/engine";
import { hybridAlgorithmsService } from "@/engine/hybrid-algorithms/hybrid-algorithms-service";
import { historyService } from "@/resources/services/history-service";
import { instanceUtility } from "@/resources/services/instance-utility";
import { metaUtility } from "@/resources/services/meta-utility";
import { eventBus } from "@/resources/services/event-bus";
import { logger } from "@/resources/services/logger";
import { describeError } from "@/resources/util/describe-error";
import { numerise, stringifyNumber } from "@/resources/services/format";
import {
  attributeTypeName,
  attributeValueMatchesRegex,
  reportMetamodelViolation,
} from "@/resources/services/metamodel-constraints";
import { useUiStore } from "@/resources/store/uiStore";
import { useSelectionStore } from "@/resources/store/selectionStore";
import { ROBOTIC_SYSTEM_SCENETYPE_UUID } from "@/constants";

/**
 * Renders an attribute whose type declares `has_table_attribute` columns as an editable
 * grid, with "Create Row" appending one cell per column.
 *
 * RECURSION: a column with `ui_component: 'button'` holds a nested table attribute and
 * opens another table dialog. uiStore can only express ONE open `tableAttribute` dialog,
 * so only the outermost is store-driven; nested levels are local state on the recursive
 * view component below. The demo metamodel really does nest — Robotic system → Joint has
 * button columns.
 */
interface TablePayload {
  attributeInstance: AttributeInstance;
  currentClassInstance?: ClassInstance | null;
  currentPortInstance?: PortInstance | null;
}

/** uiStore host for the outermost dialog. */
export default function TableAttributeDialog() {
  const open = useUiStore((s) => s.dialogs.tableAttribute);
  const closeDialog = useUiStore((s) => s.closeDialog);
  const payload = useUiStore((s) => s.dialogPayloads.tableAttribute) as TablePayload | undefined;

  if (!payload?.attributeInstance) return null;

  return (
    <TableAttributeDialogView
      open={open}
      attributeInstance={payload.attributeInstance}
      currentClassInstance={payload.currentClassInstance ?? null}
      currentPortInstance={payload.currentPortInstance ?? null}
      onClose={() => closeDialog("tableAttribute")}
    />
  );
}

interface TableAttributeDialogViewProps {
  open: boolean;
  attributeInstance: AttributeInstance;
  /** Old `@bindable attribute` — set for nested dialogs (`columns[j].attribute`). */
  attribute?: Attribute;
  currentClassInstance: ClassInstance | null;
  currentPortInstance: PortInstance | null;
  onClose: () => void;
}

function TableAttributeDialogView({
  open,
  attributeInstance,
  attribute,
  currentClassInstance,
  currentPortInstance,
  onClose,
}: TableAttributeDialogViewProps) {
  const [columns, setColumns] = useState<ColumnStructure[]>([]);
  const [rows, setRows] = useState<AttributeInstance[][]>([]);
  const [facetsAll, setFacetsAll] = useState<string[][]>([]);
  const [currentAttribute, setCurrentAttribute] = useState<Attribute | null>(null);
  // The robotic-system hybrid algorithm dispatches on the meta CLASS and meta ATTRIBUTE
  // names ("joint" / "origin"), so a cell edit needs the class as well as the attribute.
  const [currentClass, setCurrentClass] = useState<Class | null>(null);
  const [nestedCell, setNestedCell] = useState<{ row: number; col: number } | null>(null);
  const bump = useSelectionStore((s) => s.bump);

  // Meta information and table rows are loaded together (one pass, one render; the
  // called reset() + load(), and load() called both in sequence).
  const load = useCallback(async () => {
    const attributeUUID = attributeInstance.uuid_attribute;
    const currentClass = globalObject.current_class_instance
      ? await metaUtility.getMetaClass(globalObject.current_class_instance.uuid_class)
      : undefined;
    // A table attribute of the open SCENE INSTANCE (shown when nothing is selected) has
    // no current class to resolve its columns from — and `current_class_instance` may
    // still hold the last selected element, which does not carry this attribute either.
    // metaUtility searches the scene type first, so it covers both. Only reached when
    // the class lookup found nothing, where the dialog used to render an empty grid.
    const metaAttribute =
      attribute ??
      currentClass?.attributes.find((candidate) => candidate.uuid === attributeUUID) ??
      (await metaUtility.getMetaAttribute(attributeUUID));
    setCurrentAttribute(metaAttribute ?? null);
    setCurrentClass(currentClass ?? null);

    //get the table cells
    const tableAttributes = attributeInstance.table_attributes ?? [];
    //if there are no table attributes, there is no table
    if (!tableAttributes.length || !metaAttribute) {
      setColumns([]);
      setRows([]);
      setFacetsAll([]);
      return;
    }

    const hasTableAttribute = metaAttribute.attribute_type.has_table_attribute ?? [];

    //for each entry in column structure, in sequence order
    const nextColumns: ColumnStructure[] = [];
    for (let i = 0; i < hasTableAttribute.length; i++) {
      const rightIndexAttribute = hasTableAttribute.find((column) => column.sequence === i + 1);
      if (rightIndexAttribute) nextColumns.push(rightIndexAttribute);
    }

    const nextFacets: string[][] = nextColumns.map((column) => {
      const uiComponent = (column.ui_component ?? "").toLowerCase();
      if ((uiComponent === "dropdown" || uiComponent === "slider") && column.attribute) {
        return column.attribute.facets.split("|");
      }
      return [];
    });

    // Group the flat cell list by table_row, then place each row's cells under the
    // column whose meta attribute they belong to (cell.uuid_attribute) rather than
    // trusting raw array position. The server orders cells by table_row only, so two
    // cells that share a row (e.g. the "Variable Name" and "Variable Value" columns)
    // come back in no particular order — chunking by position silently swapped them
    // whenever the server happened to hand that pair back column-reversed.
    const cellsByRow = new Map<number, AttributeInstance[]>();
    for (const cell of tableAttributes) {
      const bucket = cellsByRow.get(cell.table_row);
      if (bucket) bucket.push(cell);
      else cellsByRow.set(cell.table_row, [cell]);
    }
    const nextRows: AttributeInstance[][] = [];
    if (nextColumns.length > 0) {
      for (const rowIndex of [...cellsByRow.keys()].sort((a, b) => a - b)) {
        const cellsInRow = cellsByRow.get(rowIndex)!;
        const row = nextColumns.map((column) => {
          const match = cellsInRow.find((cell) => cell.uuid_attribute === column.attribute.uuid);
          if (!match) {
            logger.log(
              `table attribute row ${rowIndex}: no cell for column "${column.attribute.name}"`,
              "error",
            );
          }
          return match as AttributeInstance;
        });
        nextRows.push(row);
      }
    }

    setColumns(nextColumns);
    setFacetsAll(nextFacets);
    setRows(nextRows);
  }, [attributeInstance, attribute]);

  useEffect(() => {
    if (!open) return;
    void load().catch((err) => logger.log("table attribute load failed: " + describeError(err), "error"));
  }, [open, load]);

  // dialog-table-attribute.ts:228 — fieldChange
  async function fieldChange(cell: AttributeInstance) {
    //update attribute value
    cell.value = cell.value.toString();

    eventBus.publish("checkForVizRepUpdateByAttributeInstance", cell);

    // In a robotic system scene, a cell edit may re-pose the URDF robot.
    const sceneInstance = await instanceUtility.getTabContextSceneInstance();
    if (sceneInstance?.uuid_scene_type == ROBOTIC_SYSTEM_SCENETYPE_UUID) {
      // `null` rather than `[null]` when nothing is selected — the same outcome (the service
      // only reads `classInstances[0]` in this branch, then returns) without lying to
      // the type.
      await hybridAlgorithmsService.checkHybridAlgorithms(
        cell,
        currentClassInstance ? [currentClassInstance] : null,
        null,
        currentClass,
        currentAttribute,
      );
    } else if (currentClassInstance) {
      await hybridAlgorithmsService.checkHybridAlgorithms(null, [currentClassInstance]);
    } else if (currentPortInstance) {
      await hybridAlgorithmsService.checkHybridAlgorithms(null, null, [currentPortInstance]);
    }

    //patch attribute instance
    //---------------------------------
    // !!! endpoints with instances/attributesInstances are not working
    // instead set the globalObjectInstance.doSceneInstancePatch to true
    //---------------------------------
    globalObject.doSceneInstancePatch = true;

    // The cell was mutated in place, so nothing React observes has changed. Bump the
    // selection store's revision to make the attribute window re-render.
    bump();

    // Undo step, keyed per cell so re-editing the same one does not stack steps.
    historyService.record("edit table cell", { coalesceKey: `table-cell:${cell.uuid}` });
  }

  /**
   * Write an edited cell value and save it — unless the metamodel refuses it, in which
   * case nothing is written and the user gets the rejection snackbar.
   *
   * A cell is validated against the META ATTRIBUTE OF ITS COLUMN, which is where its
   * attribute type (and so its regex) comes from. Cells are saved as part of the scene
   * instance, so a refused value fails the same autosave with the same 403 as a plain
   * attribute — see the note on `commit` in PlainAttributeRow.
   *
   * Returns whether the value was accepted, so the cell can put its field back.
   */
  function commitCell(cell: AttributeInstance, next: string, columnAttribute?: Attribute): boolean {
    // A blur that changed nothing has neither a value to save nor a verdict to report.
    if (next === (cell.value ?? "")) return true;

    if (!attributeValueMatchesRegex(next, columnAttribute)) {
      reportMetamodelViolation(
        `"${next}" is not a valid ${attributeTypeName(columnAttribute)} value for ${cell.name}.`,
      );
      return false;
    }

    cell.value = next;
    void fieldChange(cell).catch((err) =>
      logger.log("table attribute change failed: " + describeError(err), "error"),
    );
    return true;
  }

  // dialog-table-attribute.ts:166 — createRow / createCell
  async function createRow() {
    if (!currentAttribute) return;
    const hasTableAttribute = currentAttribute.attribute_type.has_table_attribute ?? [];
    //Count the number of rows in the table
    const numRows = rows.length;

    //Create a new row: a cell per column
    for (const column of hasTableAttribute) {
      await createCell(numRows + 1, column.sequence, hasTableAttribute);
    }

    //Reload the table
    await load();
    globalObject.doSceneInstancePatch = true;
    bump();

    // One step for the whole row: createCell() ran once per column above, but adding a
    // row is a single user action and undoes as one.
    historyService.record("add table row");
  }

  async function createCell(row: number, columnIndex: number, hasTableAttribute: ColumnStructure[]) {
    // The column where the cell is created
    const parentAttributeColumn = hasTableAttribute.find((column) => column.sequence === columnIndex);
    if (!parentAttributeColumn || !currentAttribute) return;

    const metaAttribute = parentAttributeColumn.attribute;
    // Create a new instance of the attribute that is in the column. A column whose own
    // attribute is a table gets an empty value; otherwise the meta default.
    const isNestedTable = metaAttribute.attribute_type.has_table_attribute.length > 0;
    const newAttributeInstance = await instanceCreationHandler.createAttributeInstance(
      parentAttributeColumn.attribute,
      null as unknown as string,
      null as unknown as string,
      isNestedTable ? "" : (parentAttributeColumn.attribute.default_value ?? "not defined"),
      undefined,
      undefined,
      undefined,
      undefined,
      currentAttribute.uuid,
      undefined,
    );

    // Set the row of the new attribute instance
    newAttributeInstance.table_row = row;

    // Add the new attribute instance to the list of attribute instances in the current
    // attribute
    attributeInstance.table_attributes.push(newAttributeInstance);
  }

  const nestedAttributeInstance =
    nestedCell !== null ? rows[nestedCell.row]?.[nestedCell.col] : undefined;
  const nestedAttribute = nestedCell !== null ? columns[nestedCell.col]?.attribute : undefined;

  return (
    <Dialog open={open} onClose={onClose} maxWidth="lg" fullWidth>
      <DialogTitle>Table Attribute: {attributeInstance.name}</DialogTitle>
      <DialogContent>
        <Table sx={{ border: "1.5px solid", width: "100%", tableLayout: "fixed" }} aria-describedby="Table">
          <TableHead>
            <TableRow>
              {columns.map((column) => (
                <TableCell
                  key={column.attribute?.uuid ?? column.sequence}
                  sx={{ border: "0.75px solid", width: 120, textAlign: "center" }}
                >
                  {column.attribute?.name}
                </TableCell>
              ))}
            </TableRow>
          </TableHead>
          <TableBody>
            {rows.map((row, i) => (
              <TableRow key={row[0]?.uuid ?? i}>
                {row.map((cell, j) => {
                  const uiComponent = (columns[j]?.ui_component ?? "").toLowerCase();
                  return (
                    <TableCell
                      key={cell?.uuid ?? `${i}-${j}`}
                      sx={{ border: "0.75px solid", width: 120, textAlign: "center" }}
                    >
                      {cell && (
                        <TableAttributeCell
                          cell={cell}
                          uiComponent={uiComponent}
                          facets={facetsAll[j] ?? []}
                          onCommit={(next) => commitCell(cell, next, columns[j]?.attribute)}
                          onOpenNested={() => setNestedCell({ row: i, col: j })}
                        />
                      )}
                    </TableCell>
                  );
                })}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Ok</Button>
        <Button onClick={onClose}>Close</Button>
        <Button
          onClick={() =>
            void createRow().catch((err) => logger.log("create row failed: " + describeError(err), "error"))
          }
        >
          Create Row
        </Button>
      </DialogActions>

      {/* Nested table dialog (a column with ui_component 'button'). */}
      {nestedAttributeInstance && (
        <TableAttributeDialogView
          open={nestedCell !== null}
          attributeInstance={nestedAttributeInstance}
          attribute={nestedAttribute}
          currentClassInstance={currentClassInstance}
          currentPortInstance={currentPortInstance}
          onClose={() => setNestedCell(null)}
        />
      )}
    </Dialog>
  );
}

/** One cell: a text field, a slider, a dropdown or a nested-table button. */
function TableAttributeCell({
  cell,
  uiComponent,
  facets,
  onCommit,
  onOpenNested,
}: {
  cell: AttributeInstance;
  uiComponent: string;
  facets: string[];
  /** Returns false when the metamodel refused the value; the field then snaps back. */
  onCommit: (next: string) => boolean;
  onOpenNested: () => void;
}) {
  const [value, setValue] = useState<string>(cell.value ?? "");

  useEffect(() => {
    setValue(cell.value ?? "");
  }, [cell, cell.value]);

  // Put the field back to the stored value when a commit was refused. The cell was
  // never written to, so the stored value is the last accepted one.
  function commit(next: string) {
    if (!onCommit(next)) setValue(cell.value ?? "");
  }

  if (uiComponent === "text") {
    return (
      <TextField
        size="small"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onBlur={() => commit(value)}
        inputProps={{ "aria-label": cell.name }}
      />
    );
  }

  if (uiComponent === "slider") {
    return (
      <Box sx={{ display: "flex", flexDirection: "row", alignItems: "center", width: "100%" }}>
        <Typography component="span" sx={{ mr: "2.2rem", whiteSpace: "nowrap", width: 25 }}>
          Val:{numerise(value, undefined, Number(facets[0]))}
        </Typography>
        <Slider
          sx={{ width: "100%" }}
          min={Number(facets[0])}
          max={Number(facets[1])}
          step={Number(facets[2]) || 1}
          value={numerise(value, undefined, Number(facets[0]))}
          onChange={(_e, next) => setValue(stringifyNumber(next as number))}
          onChangeCommitted={(_e, next) => commit(stringifyNumber(next as number))}
          aria-label={cell.name}
        />
      </Box>
    );
  }

  if (uiComponent === "dropdown") {
    return (
      <FormControl fullWidth required size="small">
        <InputLabel id={`cell-${cell.uuid}`}>{cell.name}</InputLabel>
        <Select
          labelId={`cell-${cell.uuid}`}
          label={cell.name}
          value={value}
          onChange={(e) => commit(e.target.value)}
        >
          {facets.map((facet) => (
            <MenuItem key={facet} value={facet}>
              {facet}
            </MenuItem>
          ))}
        </Select>
      </FormControl>
    );
  }

  if (uiComponent === "button") {
    return (
      <Box sx={{ display: "flex", flexDirection: "column", alignItems: "center", width: "100%" }}>
        <Button variant="outlined" sx={{ width: "100%" }} onClick={onOpenNested}>
          {cell.name}
        </Button>
      </Box>
    );
  }

  return null;
}
