import { RelationTypes, UITypes } from 'nocodb-sdk';
import type { Knex } from 'knex';
import type { IBaseModelSqlV2 } from '~/db/IBaseModelSqlV2';
import type { QueryWithCte } from '~/helpers/dbHelpers';
import type { NcContext } from '~/interface/config';
import type {
  BarcodeColumn,
  Column,
  FormulaColumn,
  LinksColumn,
  LinkToAnotherRecordColumn,
  QrCodeColumn,
  RollupColumn,
} from '~/models';
import type LookupColumn from '../models/LookupColumn';
import formulaQueryBuilderv2 from '~/db/formulav2/formulaQueryBuilderv2';
import genRollupSelectv2 from '~/db/genRollupSelectv2';
import { NcError } from '~/helpers/catchError';
import { getAs } from '~/helpers/dbHelpers';
import { Model } from '~/models';
import { getAliasGenerator } from '~/utils';

const LOOKUP_VAL_SEPARATOR = '___';

export async function getDisplayValueOfRefTable(
  context: NcContext,
  relationCol: Column<LinkToAnotherRecordColumn | LinksColumn>,
) {
  return await relationCol
    .getColOptions(context)
    .then((colOpt) => colOpt.getRelatedTable(context))
    .then((model) => model.getColumns(context))
    .then((cols) => cols.find((col) => col.pv) || cols[0]);
}

// this function will generate the query for lookup column
// or for  LTAR column and return the query builder
// query result will be aggregated json array string in case of Myssql and Postgres
// and string with separator in case of sqlite and mysql
// this function is used for sorting and grouping of lookup/LTAR column at the moment
export default async function generateLookupSelectQuery({
  column,
  baseModelSqlv2,
  alias,
  model: _model,
  getAlias = getAliasGenerator('__lk_slt_'),
  isAggregation = false,
}: {
  column: Column;
  baseModelSqlv2: IBaseModelSqlV2;
  alias: string;
  model: Model;
  getAlias?: ReturnType<typeof getAliasGenerator>;
  isAggregation?: boolean;
}): Promise<QueryWithCte> {
  const knex = baseModelSqlv2.dbDriver;

  const context = baseModelSqlv2.context;

  const rootAlias = alias;

  {
    let selectQb: Knex.QueryBuilder;
    const alias = getAlias();
    let lookupColOpt: LookupColumn;
    let isBtLookup = true;

    const applyCte = (_qb: Knex.QueryBuilder) => {};

    if (column.uidt === UITypes.Lookup) {
      lookupColOpt = await column.getColOptions<LookupColumn>(context);
    } else if (column.uidt !== UITypes.LinkToAnotherRecord) {
      NcError.badRequest('Invalid field type');
    }

    await column.getColOptions<LookupColumn>(context);
    let refContext: NcContext;
    {
      const relationCol = lookupColOpt
        ? await lookupColOpt.getRelationColumn(context)
        : column;
      const relation =
        await relationCol.getColOptions<LinkToAnotherRecordColumn>(context);

      const {
        parentContext,
        childContext,
        refContext: _refContext,
        mmContext,
      } = await relation.getParentChildContext(context, relationCol);
      refContext = _refContext;

      let relationType = relation.type;

      if (relationType === RelationTypes.ONE_TO_ONE) {
        relationType = relationCol.meta?.bt
          ? RelationTypes.BELONGS_TO
          : RelationTypes.HAS_MANY;
      }

      if (relationType === RelationTypes.BELONGS_TO) {
        const childColumn = await relation.getChildColumn(context);
        const parentColumn = await relation.getParentColumn(context);
        const childModel = await childColumn.getModel(childContext);
        await childModel.getColumns(childContext);
        const parentModel = await parentColumn.getModel(parentContext);
        await parentModel.getColumns(parentContext);

        const parentBaseModel = await Model.getBaseModelSQL(parentContext, {
          model: parentModel,
          dbDriver: knex,
        });

        selectQb = knex(
          knex.raw(`?? as ??`, [
            parentBaseModel.getTnPath(parentModel.table_name),
            alias,
          ]),
        ).where(
          `${alias}.${parentColumn.column_name}`,
          knex.raw(`??`, [
            `${rootAlias || baseModelSqlv2.getTnPath(childModel.table_name)}.${
              childColumn.column_name
            }`,
          ]),
        );
      } else if (relationType === RelationTypes.HAS_MANY) {
        isBtLookup = false;
        const childColumn = await relation.getChildColumn(context);
        const parentColumn = await relation.getParentColumn(context);
        const childModel = await childColumn.getModel(childContext);
        await childModel.getColumns(childContext);
        const parentModel = await parentColumn.getModel(parentContext);
        await parentModel.getColumns(parentContext);
        const parentBaseModel = await Model.getBaseModelSQL(parentContext, {
          model: parentModel,
          dbDriver: knex,
        });

        selectQb = knex(
          knex.raw(`?? as ??`, [
            parentBaseModel.getTnPath(childModel.table_name),
            alias,
          ]),
        ).where(
          `${alias}.${childColumn.column_name}`,
          knex.raw(`??`, [
            `${rootAlias || baseModelSqlv2.getTnPath(parentModel.table_name)}.${
              parentColumn.column_name
            }`,
          ]),
        );
      } else if (relationType === RelationTypes.MANY_TO_MANY) {
        isBtLookup = false;
        const childColumn = await relation.getChildColumn(context);
        const parentColumn = await relation.getParentColumn(context);
        const childModel = await childColumn.getModel(childContext);
        await childModel.getColumns(childContext);
        const parentModel = await parentColumn.getModel(parentContext);
        await parentModel.getColumns(parentContext);

        const parentBaseModel = await Model.getBaseModelSQL(parentContext, {
          model: parentModel,
          dbDriver: knex,
        });

        selectQb = knex(
          knex.raw(`?? as ??`, [
            parentBaseModel.getTnPath(parentModel.table_name),
            alias,
          ]),
        );

        const mmTableAlias = getAlias();

        const mmModel = await relation.getMMModel(context);
        const mmChildCol = await relation.getMMChildColumn(context);
        const mmParentCol = await relation.getMMParentColumn(context);

        const associatedBaseModel = await Model.getBaseModelSQL(mmContext, {
          model: mmModel,
          dbDriver: knex,
        });

        selectQb
          .innerJoin(
            associatedBaseModel.getTnPath(mmModel.table_name, mmTableAlias),
            knex.ref(`${mmTableAlias}.${mmParentCol.column_name}`) as any,
            '=',
            knex.ref(`${alias}.${parentColumn.column_name}`) as any,
          )
          .where(
            knex.ref(`${mmTableAlias}.${mmChildCol.column_name}`),
            '=',
            knex.ref(
              `${
                rootAlias || baseModelSqlv2.getTnPath(childModel.table_name)
              }.${childColumn.column_name}`,
            ),
          );
      }
    }
    let lookupColumn = lookupColOpt
      ? await lookupColOpt.getLookupColumn(refContext)
      : await getDisplayValueOfRefTable(refContext, column);

    // if lookup column is qr code or barcode extract the referencing column
    if ([UITypes.QrCode, UITypes.Barcode].includes(lookupColumn.uidt)) {
      lookupColumn = await lookupColumn
        .getColOptions<BarcodeColumn | QrCodeColumn>(context)
        .then((barcode) => barcode.getValueColumn(refContext));
    }
    {
      let prevAlias = alias;
      let context = refContext;
      while (
        lookupColumn.uidt === UITypes.Lookup ||
        lookupColumn.uidt === UITypes.LinkToAnotherRecord
      ) {
        const nestedAlias = getAlias();

        let relationCol: Column<LinkToAnotherRecordColumn | LinksColumn>;
        let nestedLookupColOpt: LookupColumn;

        if (lookupColumn.uidt === UITypes.Lookup) {
          nestedLookupColOpt = await lookupColumn.getColOptions<LookupColumn>(
            context,
          );
          relationCol = await nestedLookupColOpt.getRelationColumn(context);
        } else {
          relationCol = lookupColumn;
        }

        const relation =
          await relationCol.getColOptions<LinkToAnotherRecordColumn>(context);

        let relationType = relation.type;

        if (relationType === RelationTypes.ONE_TO_ONE) {
          relationType = relationCol.meta?.bt
            ? RelationTypes.BELONGS_TO
            : RelationTypes.HAS_MANY;
        }
        const {
          parentContext,
          childContext,
          refContext: _refContext,
          mmContext,
        } = await relation.getParentChildContext(context, relationCol);

        // if any of the relation in nested lookupColOpt is
        // not belongs to then throw error as we don't support
        if (relationType === RelationTypes.BELONGS_TO) {
          const childColumn = await relation.getChildColumn(context);
          const parentColumn = await relation.getParentColumn(context);
          const childModel = await childColumn.getModel(childContext);
          await childModel.getColumns(childContext);
          const parentModel = await parentColumn.getModel(parentContext);
          await parentModel.getColumns(parentContext);
          const parentBaseModel = await Model.getBaseModelSQL(parentContext, {
            model: parentModel,
            dbDriver: knex,
          });

          selectQb.join(
            knex.raw(`?? as ??`, [
              parentBaseModel.getTnPath(parentModel.table_name),
              nestedAlias,
            ]),
            `${nestedAlias}.${parentColumn.column_name}`,
            `${prevAlias}.${childColumn.column_name}`,
          );
        } else if (relationType === RelationTypes.HAS_MANY) {
          isBtLookup = false;
          const childColumn = await relation.getChildColumn(context);
          const parentColumn = await relation.getParentColumn(context);
          const childModel = await childColumn.getModel(childContext);
          await childModel.getColumns(childContext);
          const parentModel = await parentColumn.getModel(parentContext);
          await parentModel.getColumns(parentContext);
          const childBaseModel = await Model.getBaseModelSQL(childContext, {
            model: childModel,
            dbDriver: knex,
          });

          selectQb.join(
            knex.raw(`?? as ??`, [
              childBaseModel.getTnPath(childModel.table_name),
              nestedAlias,
            ]),
            `${nestedAlias}.${childColumn.column_name}`,
            `${prevAlias}.${parentColumn.column_name}`,
          );
        } else if (relationType === RelationTypes.MANY_TO_MANY) {
          isBtLookup = false;
          const childColumn = await relation.getChildColumn(context);
          const parentColumn = await relation.getParentColumn(context);
          const childModel = await childColumn.getModel(childContext);
          await childModel.getColumns(childContext);
          const parentModel = await parentColumn.getModel(parentContext);
          await parentModel.getColumns(parentContext);
          const parentBaseModel = await Model.getBaseModelSQL(parentContext, {
            model: parentModel,
            dbDriver: knex,
          });

          const mmTableAlias = getAlias();

          const mmModel = await relation.getMMModel(context);
          const mmChildCol = await relation.getMMChildColumn(context);
          const mmParentCol = await relation.getMMParentColumn(context);

          const associatedBaseModel = await Model.getBaseModelSQL(mmContext, {
            model: mmModel,
            dbDriver: knex,
          });

          selectQb
            .innerJoin(
              associatedBaseModel.getTnPath(mmModel.table_name, mmTableAlias),
              knex.ref(`${mmTableAlias}.${mmChildCol.column_name}`) as any,
              '=',
              knex.ref(`${prevAlias}.${childColumn.column_name}`) as any,
            )
            .innerJoin(
              knex.raw('?? as ??', [
                parentBaseModel.getTnPath(parentModel.table_name),
                nestedAlias,
              ]),
              knex.ref(`${mmTableAlias}.${mmParentCol.column_name}`) as any,
              '=',
              knex.ref(`${nestedAlias}.${parentColumn.column_name}`) as any,
            )
            .where(
              knex.ref(`${mmTableAlias}.${mmChildCol.column_name}`),
              '=',
              knex.ref(
                `${alias || baseModelSqlv2.getTnPath(childModel.table_name)}.${
                  childColumn.column_name
                }`,
              ),
            );
        }

        if (lookupColumn.uidt === UITypes.Lookup)
          lookupColumn = await nestedLookupColOpt.getLookupColumn(refContext);
        else
          lookupColumn = await getDisplayValueOfRefTable(
            refContext,
            relationCol,
          );
        prevAlias = nestedAlias;
        context = _refContext;
      }

      {
        // get basemodel and model of lookup column
        const model = await lookupColumn.getModel(context);
        const baseModelSqlv2 = await Model.getBaseModelSQL(context, {
          model,
          dbDriver: knex,
        });

        switch (lookupColumn.uidt) {
          case UITypes.Links:
          case UITypes.Rollup:
            {
              const builder = (
                await genRollupSelectv2({
                  baseModelSqlv2,
                  knex,
                  columnOptions: (await lookupColumn.getColOptions(
                    context,
                  )) as RollupColumn,
                  alias: prevAlias,
                })
              ).builder;
              selectQb.select({
                [lookupColumn.id]: knex.raw(builder).wrap('(', ')'),
              });
            }
            break;
          case UITypes.Formula:
            {
              const builder = (
                await formulaQueryBuilderv2({
                  baseModel: baseModelSqlv2,
                  tree: (
                    await lookupColumn.getColOptions<FormulaColumn>(context)
                  ).formula,
                  model,
                  column: lookupColumn,
                  aliasToColumn: await model.getAliasColMapping(context),
                  tableAlias: prevAlias,
                })
              ).builder;

              selectQb.select(
                knex.raw(`?? as ??`, [builder, getAs(lookupColumn)]),
              );
            }
            break;
          case UITypes.DateTime:
          case UITypes.LastModifiedTime:
          case UITypes.CreatedTime:
            {
              await baseModelSqlv2.selectObject({
                qb: selectQb,
                columns: [lookupColumn],
                alias: prevAlias,
              });
            }
            break;
          case UITypes.Attachment:
            if (!isAggregation) {
              NcError.badRequest(
                'Group by using attachment column is not supported',
              );
              break;
            }
          // eslint-disable-next-line no-fallthrough
          default:
            {
              selectQb.select(
                `${prevAlias}.${lookupColumn.column_name} as ${lookupColumn.id}`,
              );
            }

            break;
        }
      }
      // if all relation are belongs to then we don't need to do the aggregation
      if (isBtLookup) {
        return {
          builder: selectQb,
          applyCte,
        };
      }

      const subQueryAlias = getAlias();

      if (baseModelSqlv2.isPg) {
        // alternate approach with array_agg
        return {
          builder: knex
            .select(knex.raw('json_agg(??)::text', [lookupColumn.id]))
            .from(selectQb.as(subQueryAlias)),
          applyCte,
        };
        /*
        // alternate approach with array_agg
        return {
          builder: knex
            .select(knex.raw('array_agg(??)', [lookupColumn.id]))
            .from(selectQb),
        };*/
        // alternate approach with string aggregation
        // return {
        //   builder: knex
        //     .select(
        //       knex.raw('STRING_AGG(??::text, ?)', [
        //         lookupColumn.id,
        //         LOOKUP_VAL_SEPARATOR,
        //       ]),
        //     )
        //     .from(selectQb.as(subQueryAlias)),
        // };
      } else if (baseModelSqlv2.isMySQL) {
        return {
          builder: knex
            .select(
              knex.raw('cast(JSON_ARRAYAGG(??) as NCHAR)', [lookupColumn.id]),
            )
            .from(selectQb.as(subQueryAlias)),
          applyCte,
        };

        // return {
        //   builder: knex
        //     .select(
        //       knex.raw('GROUP_CONCAT(?? ORDER BY ?? ASC SEPARATOR ?)', [
        //         lookupColumn.id,
        //         lookupColumn.id,
        //         LOOKUP_VAL_SEPARATOR,
        //       ]),
        //     )
        //     .from(selectQb.as(subQueryAlias)),
        // };
      } else if (baseModelSqlv2.isSqlite) {
        // ref: https://stackoverflow.com/questions/13382856/sqlite3-join-group-concat-using-distinct-with-custom-separator
        // selectQb.orderBy(`${lookupColumn.id}`, 'asc');
        return {
          builder: knex
            .select(
              knex.raw(`group_concat(??, ?)`, [
                lookupColumn.id,
                LOOKUP_VAL_SEPARATOR,
              ]),
            )
            .from(selectQb.as(subQueryAlias)),
          applyCte,
        };
      }

      NcError.notImplemented('This operation on Lookup/LTAR for this database');
    }
  }
}
