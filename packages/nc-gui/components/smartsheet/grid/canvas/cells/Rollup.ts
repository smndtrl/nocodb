import { UITypes, getRenderAsTextFunForUiType, parseProp } from 'nocodb-sdk'
import type { ColumnType, LinkToAnotherRecordType, RollupType } from 'nocodb-sdk'
import rfdc from 'rfdc'
import { isBoxHovered } from '../utils/canvas'
import { LinksCellRenderer } from './Links'

const clone = rfdc()
export const RollupCellRenderer: CellRenderer = {
  render: (ctx, props) => {
    const { column, value, metas, renderCell } = props

    // If it is empty text then no need to render
    if (!isValidValue(value)) return

    const colOptions = column.colOptions as RollupType
    const columnMeta = parseProp(column.meta)

    const relatedColObj = metas?.[column.fk_model_id!]?.columns?.find(
      (c: ColumnType) => c.id === colOptions?.fk_relation_column_id,
    ) as ColumnType

    if (!relatedColObj) return

    // Check if this rollup should be rendered as links
    if (columnMeta?.showAsLinks) {
      // Use the Links renderer with all the necessary props for proper permission handling
      return LinksCellRenderer.render?.(ctx, {
        ...props,
        column: {
          ...column,
          uidt: UITypes.Links,
          meta: {
            ...parseProp(relatedColObj?.meta),
            ...parseProp(column?.meta),
          },
          // Preserve the relation column's colOptions for proper LTAR functionality
          colOptions: relatedColObj?.colOptions,
        },
        // Ensure all permission-related props are passed through
        readonly: props.readonly,
        isUnderLookup: props.isUnderLookup,
        formula: props.formula,
      })
    }

    // For LinkToAnotherRecordType, we need to use fk_related_model_id
    const relatedColOptions = relatedColObj?.colOptions as LinkToAnotherRecordType
    const relatedModelId = relatedColOptions?.fk_related_model_id
    const relatedTableMeta = relatedModelId ? metas?.[relatedModelId] : undefined

    const childColumn = clone((relatedTableMeta?.columns || []).find((c: ColumnType) => c.id === colOptions?.fk_rollup_column_id))

    if (!childColumn) return

    let renderProps: CellRendererOptions | undefined

    if (childColumn.uidt === UITypes.Formula) {
      const colMeta = parseProp(childColumn.meta)

      if (colMeta?.display_type) {
        renderProps = {
          ...props,
          column: {
            ...childColumn,
            uidt: colMeta?.display_type,
            ...colMeta.display_column_meta,
            meta: {
              ...parseProp(colMeta.display_column_meta),
              ...parseProp(column?.meta),
            },
          },
          readonly: true,
          formula: true,
        }
      }
    }

    if (!renderProps) {
      renderProps = {
        ...props,
        column: childColumn,
        relatedColObj: undefined,
        relatedTableMeta: undefined,
        readonly: true,
      }
    }

    const renderAsTextFun = getRenderAsTextFunForUiType((renderProps.column?.uidt as UITypes) || UITypes.SingleLineText)

    renderProps.column.meta = {
      ...parseProp(childColumn?.meta),
      ...parseProp(column?.meta),
    }

    if (colOptions?.rollup_function && renderAsTextFun.includes(colOptions?.rollup_function)) {
      // Render as decimal cell
      renderProps.column.uidt = UITypes.Decimal
    }

    renderCell(ctx, renderProps.column, renderProps)
  },
  async handleClick(props) {
    const { column, row, getCellPosition, mousePosition, makeCellEditable, selected, isDoubleClick, readonly } = props
    const columnMeta = parseProp(column.columnObj?.meta)

    // If this rollup should be rendered as links, handle permission checks
    if (columnMeta?.showAsLinks) {
      // Check permissions first - inherit the same logic as Links component
      // In Links renderer: if (selected && !readonly) shows the plus icon
      // So when readonly is true, no plus icon should show and clicks should be ignored for editing
      if (readonly) {
        // When readonly, still allow expanding/viewing the rollup content
        if (selected || isDoubleClick) {
          makeCellEditable(row, column)
          return true
        }
        return false
      }

      // When not readonly, allow normal interaction
      if (!selected && !isDoubleClick) return false

      const rowIndex = row.rowMeta.rowIndex!
      const { x, y, width, height } = getCellPosition(column, rowIndex)
      const padding = 10
      const buttonSize = 16

      // Check if click is within the cell area (similar to Links renderer)
      if (
        isBoxHovered({ x: x + width - 16 - padding, y: y + 7, height: buttonSize, width: buttonSize }, mousePosition) ||
        isBoxHovered({ x: x + padding, y, height, width: width - padding * 2 }, mousePosition)
      ) {
        // Make the rollup column editable
        makeCellEditable(row, column)
        return true
      }
    }

    return false
  },
  async handleKeyDown(props) {
    const { column, row, e, makeCellEditable, readonly } = props
    const columnMeta = parseProp(column.columnObj?.meta)

    // If this rollup should be rendered as links, handle permission checks
    if (columnMeta?.showAsLinks) {
      // Check permissions first - when readonly, only allow expand keys
      if (readonly) {
        if (isExpandCellKey(e)) {
          makeCellEditable(row, column)
          return true
        }
        return false
      }

      // When not readonly, allow normal keyboard interaction
      if (isExpandCellKey(e)) {
        makeCellEditable(row, column)
        return true
      }
    }

    return false
  },
}
