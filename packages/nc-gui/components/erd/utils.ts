import type { ColumnType, LinkToAnotherRecordType, TableType } from 'nocodb-sdk'
import { RelationTypes, UITypes, isLinksOrLTAR } from 'nocodb-sdk'
import dagre from 'dagre'
import type { Edge, EdgeMarker, Elements, Node } from '@vue-flow/core'
import { MarkerType, Position, isEdge, isNode } from '@vue-flow/core'
import type { MaybeRef } from '@vueuse/core'
import { scaleLinear as d3ScaleLinear } from 'd3-scale'
import tinycolor from 'tinycolor2'

export interface ERDConfig {
  showPkAndFk: boolean
  showViews: boolean
  showAllColumns: boolean
  singleTableMode: boolean
  showJunctionTableNames: boolean
  showMMTables: boolean
  isFullScreen: boolean
}

export interface NodeData {
  table: TableType
  pkAndFkColumns: ColumnType[]
  nonPkColumns: ColumnType[]
  showPkAndFk: boolean
  showAllColumns: boolean
  color: string
  columnLength: number
}

export interface EdgeData {
  isManyToMany: boolean
  isOneToOne: boolean
  isSelfRelation: boolean
  label?: string
  simpleLabel?: string
  color: string
}

interface Relation {
  source: string
  target: string
  childColId?: string
  parentColId?: string
  modelId?: string
  type: RelationTypes
}

/**
 * This util is used to generate the ERD graph elements and layout them
 *
 * @param tables
 * @param props
 */
export function useErdElements(tables: MaybeRef<TableType[]>, props: MaybeRef<ERDConfig>) {
  const elements = ref<Elements<NodeData | EdgeData>>([])

  const { theme } = useTheme()

  const colorScale = d3ScaleLinear<string>().domain([0, 2]).range([theme.value.primaryColor, theme.value.accentColor])

  const dagreGraph = new dagre.graphlib.Graph()
  dagreGraph.setDefaultEdgeLabel(() => ({}))
  dagreGraph.setGraph({ 
    rankdir: 'LR',
    align: 'UL',
    nodesep: 50,
    ranksep: 100
  })

  const { metasWithIdAsKey } = useMetas()

  const erdTables = computed(() => unref(tables))
  const config = computed(() => unref(props))

  const nodeWidth = 300
  const nodeHeight = computed(() => (config.value.showViews && config.value.showAllColumns ? 50 : 40))

  const relations = computed(() =>
    erdTables.value.reduce((acc, table) => {
      const meta = metasWithIdAsKey.value[table.id!]
      const columns = meta.columns?.filter((column: ColumnType) => isLinksOrLTAR(column) && column.system !== 1) || []

      for (const column of columns) {
        const colOptions = column.colOptions as LinkToAnotherRecordType
        const source = column.fk_model_id
        const target = colOptions.fk_related_model_id

        const sourceExists = erdTables.value.find((t) => t.id === source)
        const targetExists = erdTables.value.find((t) => t.id === target)

        if (source && target && sourceExists && targetExists) {
          const relation: Relation = {
            source,
            target,
            childColId: colOptions.fk_child_column_id,
            parentColId: colOptions.fk_parent_column_id,
            modelId: colOptions.fk_mm_model_id,
            type: RelationTypes.HAS_MANY,
          }

          if (colOptions.type === RelationTypes.HAS_MANY) {
            relation.type = RelationTypes.HAS_MANY

            acc.push(relation)
            continue
          }
          if (colOptions.type === RelationTypes.ONE_TO_ONE) {
            relation.type = RelationTypes.ONE_TO_ONE

            // skip adding relation link from both side
            if (column.meta?.bt) continue

            acc.push(relation)
            continue
          }

          if (colOptions.type === RelationTypes.MANY_TO_MANY) {
            // Avoid duplicate mm connections
            const correspondingColumn = acc.find(
              (relation) =>
                relation.type === RelationTypes.MANY_TO_MANY &&
                relation.parentColId === colOptions.fk_child_column_id &&
                relation.childColId === colOptions.fk_parent_column_id,
            )

            if (!correspondingColumn) {
              relation.type = RelationTypes.MANY_TO_MANY

              acc.push(relation)
              continue
            }
          }
        }
      }

      return acc
    }, [] as Relation[]),
  )

  function edgeLabel({ type, source, target, modelId, childColId, parentColId }: Relation) {
    let typeLabel: string

    if (type === RelationTypes.HAS_MANY) typeLabel = 'has many'
    else if (type === RelationTypes.MANY_TO_MANY) typeLabel = 'many to many'
    else if (type === 'oo') typeLabel = 'one to one'

    const parentCol = metasWithIdAsKey.value[source].columns?.find((col) => {
      const colOptions = col.colOptions as LinkToAnotherRecordType
      if (!colOptions) return false

      return (
        colOptions.fk_child_column_id === childColId &&
        colOptions.fk_parent_column_id === parentColId &&
        colOptions.fk_mm_model_id === modelId
      )
    })

    const childCol = metasWithIdAsKey.value[target].columns?.find((col) => {
      const colOptions = col.colOptions as LinkToAnotherRecordType
      if (!colOptions) return false

      return colOptions.fk_parent_column_id === (type === RelationTypes.MANY_TO_MANY ? childColId : parentColId)
    })

    if (!parentCol || !childCol) return ''

    if (type === RelationTypes.MANY_TO_MANY) {
      if (config.value.showJunctionTableNames) {
        if (!modelId) return ''

        const mmModel = metasWithIdAsKey.value[modelId]

        if (!mmModel) return ''

        if (mmModel.title !== mmModel.table_name) {
          return [`${mmModel.title} (${mmModel.table_name})`]
        }

        return [mmModel.title]
      }
    }

    return [
      // detailed edge label
      `[${metasWithIdAsKey.value[source].title}] ${parentCol.title} - ${typeLabel} - ${childCol.title} [${metasWithIdAsKey.value[target].title}]`,
      // simple edge label (for skeleton)
      `${metasWithIdAsKey.value[source].title} - ${typeLabel} - ${metasWithIdAsKey.value[target].title}`,
    ]
  }

  function createNodes() {
    return erdTables.value.reduce<Node<NodeData>[]>((acc, table) => {
      if (!table.id) return acc

      const columns =
        metasWithIdAsKey.value[table.id].columns?.filter((col) => {
          if ([UITypes.CreatedBy, UITypes.LastModifiedBy].includes(col.uidt as UITypes) && col.system) return false
          return config.value.showAllColumns || (!config.value.showAllColumns && isLinksOrLTAR(col))
        }) || []

      const pkAndFkColumns = columns
        .filter(() => config.value.showPkAndFk)
        .filter((col) => col.pk || col.uidt === UITypes.ForeignKey)

      const nonPkColumns = columns.filter((col) => !col.pk && col.uidt !== UITypes.ForeignKey)

      acc.push({
        id: table.id,
        data: {
          table: metasWithIdAsKey.value[table.id],
          pkAndFkColumns,
          nonPkColumns,
          showPkAndFk: config.value.showPkAndFk,
          showAllColumns: config.value.showAllColumns,
          columnLength: columns.length,
          color: '',
        },
        type: 'custom',
        position: { x: 0, y: 0 },
      })

      return acc
    }, [])
  }

  function createEdges() {
    return relations.value.reduce<Edge<EdgeData>[]>((acc, { source, target, childColId, parentColId, type, modelId }) => {
      let sourceColumnId, targetColumnId

      if (type === RelationTypes.HAS_MANY || type === 'oo') {
        sourceColumnId = childColId
        targetColumnId = childColId
      }

      if (type === RelationTypes.MANY_TO_MANY) {
        sourceColumnId = parentColId
        targetColumnId = childColId
      }

      const [label, simpleLabel] = edgeLabel({
        source,
        target,
        type,
        childColId,
        parentColId,
        modelId,
      })

      acc.push({
        id: `e-${sourceColumnId}-${source}-${targetColumnId}-${target}-#${label}`,
        source: `${source}`,
        target: `${target}`,
        sourceHandle: `s-${sourceColumnId}-${source}`,
        targetHandle: `d-${targetColumnId}-${target}`,
        type: 'custom',
        markerEnd: {
          id: 'arrow-colored',
          type: MarkerType.ArrowClosed,
        },
        data: {
          isManyToMany: type === RelationTypes.MANY_TO_MANY,
          isOneToOne: type === 'oo',
          isSelfRelation: source === target && sourceColumnId === targetColumnId,
          label,
          simpleLabel,
          color: '',
        },
      })

      return acc
    }, [])
  }

  const boxShadow = (_skeleton: boolean, _color: string) => ({})

  const layout = async (skeleton = false): Promise<void> => {
    return new Promise((resolve) => {
      elements.value = [...createNodes(), ...createEdges()] as Elements<NodeData | EdgeData>

      for (const el of elements.value) {
        if (isNode(el)) {
          const node = el as Node<NodeData>
          const colLength = node.data!.columnLength

          const width = skeleton ? nodeWidth * 3 : nodeWidth
          const height = nodeHeight.value + (skeleton ? 250 : colLength > 0 ? nodeHeight.value * colLength : nodeHeight.value)
          dagreGraph.setNode(el.id, {
            width,
            height,
          })
        } else if (isEdge(el)) {
          dagreGraph.setEdge(el.source, el.target)
        }
      }

      dagre.layout(dagreGraph)

      // Calculate bounds to center the layout
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
      
      for (const el of elements.value) {
        if (isNode(el)) {
          const nodeWithPosition = dagreGraph.node(el.id)
          const width = skeleton ? nodeWidth * 3 : nodeWidth
          const height = nodeHeight.value + (skeleton ? 250 : (el as Node<NodeData>).data!.columnLength > 0 ? nodeHeight.value * (el as Node<NodeData>).data!.columnLength : nodeHeight.value)
          
          minX = Math.min(minX, nodeWithPosition.x - width / 2)
          minY = Math.min(minY, nodeWithPosition.y - height / 2)
          maxX = Math.max(maxX, nodeWithPosition.x + width / 2)
          maxY = Math.max(maxY, nodeWithPosition.y + height / 2)
        }
      }

      // Calculate center offset to position the layout at origin
      const centerOffsetX = -(minX + maxX) / 2
      const centerOffsetY = -(minY + maxY) / 2

      for (const el of elements.value) {
        if (isNode(el)) {
          const color = colorScale(dagreGraph.predecessors(el.id)!.length)

          const nodeWithPosition = dagreGraph.node(el.id)

          el.targetPosition = Position.Left
          el.sourcePosition = Position.Right
          // Apply center offset to position nodes around the origin
          el.position = { 
            x: nodeWithPosition.x + centerOffsetX, 
            y: nodeWithPosition.y + centerOffsetY 
          }
          el.class = ['rounded-lg border-1 border-gray-200 shadow-lg'].join(' ')
          el.data.color = color

          el.style = (n) => {
            if (n.selected) {
              return boxShadow(skeleton, color)
            }

            return boxShadow(skeleton, '#64748B')
          }
        } else if (isEdge(el)) {
          const node = elements.value.find((nodes) => nodes.id === el.source)
          if (node) {
            const color = node.data!.color

            el.data.color = color
            ;(el.markerEnd as EdgeMarker).color = `#${tinycolor(color).toHex()}`
          }
        }
      }

      resolve()
    })
  }

  return {
    elements,
    layout,
  }
}
