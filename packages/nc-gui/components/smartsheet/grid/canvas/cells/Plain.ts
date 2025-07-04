import { getAbstractType, renderSingleLineText, renderTagLabel } from '../utils/canvas'

export const PlainCellRenderer: CellRenderer = {
  render: (ctx, props) => {
    const {
      column,
      value,
      x,
      y,
      width,
      height,
      padding,
      textColor = '#4a5268',
      fontFamily = '500 13px Inter',
      meta,
      metas,
      sqlUis,
      isMysql,
      isXcdbBase,
      t,
      isUnderLookup,
    } = props

    if (!meta || !metas) return

    const abstractType = getAbstractType(column, sqlUis)

    const text = parsePlainCellValue(value, {
      col: column,
      abstractType,
      meta,
      metas,
      isMysql,
      isXcdbBase,
      t,
      isUnderLookup,
    })

    if (props.tag?.renderAsTag) {
      return renderTagLabel(ctx, { ...props, text })
    } else if (!text) {
      return {
        x,
        y,
      }
    } else {
      const { x: xOffset, y: yOffset } = renderSingleLineText(ctx, {
        x: x + padding,
        y,
        text,
        maxWidth: width - padding * 2,
        fontFamily,
        fillStyle: textColor,
        height,
      })

      return {
        x: xOffset,
        y: yOffset,
      }
    }
  },
}
