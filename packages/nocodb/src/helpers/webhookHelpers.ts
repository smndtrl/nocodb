import Handlebars from 'handlebars';
import handlebarsHelpers from 'handlebars-helpers-v2';
import { v4 as uuidv4 } from 'uuid';
import axios from 'axios';
import { useAgent } from 'request-filtering-agent';
import { Logger } from '@nestjs/common';
import dayjs from 'dayjs';
import { ColumnHelper, isDateMonthFormat, UITypes } from 'nocodb-sdk';
import isBetween from 'dayjs/plugin/isBetween';
import isSameOrBefore from 'dayjs/plugin/isSameOrBefore';
import isSameOrAfter from 'dayjs/plugin/isSameOrAfter';
import NcPluginMgrv2 from './NcPluginMgrv2';
import type { AxiosResponse } from 'axios';
import type { HookType } from 'jsep';
import type {
  ColumnType,
  FormColumnType,
  HookLogType,
  TableType,
  UserType,
  ViewType,
} from 'nocodb-sdk';
import type { NcContext } from '~/interface/config';
import type { Column, FormView, Hook, Model, View } from '~/models';
import { Filter, HookLog, Source } from '~/models';
import { filterBuilder } from '~/utils/api-v3-data-transformation.builder';
import { addDummyRootAndNest } from '~/services/v3/filters-v3.service';
import { isEE, isOnPrem } from '~/utils';

handlebarsHelpers({ handlebars: Handlebars });

dayjs.extend(isBetween);
dayjs.extend(isSameOrBefore);
dayjs.extend(isSameOrAfter);

Handlebars.registerHelper('json', function (context, pretty = false) {
  if (pretty === true || pretty === 'true') {
    // Pretty print with 2-space indentation
    return JSON.stringify(context, null, 2);
  }
  return JSON.stringify(context);
});

const logger = new Logger('webhookHelpers');

export function parseBody(template: string, data: any): string {
  if (!template) {
    return template;
  }

  try {
    return Handlebars.compile(template, { noEscape: true })({
      data,
      event: data,
    });
  } catch (e) {
    // if parsing fails then return the original template
    return template;
  }
}

export async function validateCondition(
  context: NcContext,
  filters: Filter[],
  data: any,
  {
    client,
  }: {
    client: string;
  },
) {
  if (!filters.length) {
    return true;
  }

  let isValid = null;
  for (const _filter of filters) {
    const filter = _filter instanceof Filter ? _filter : new Filter(_filter);
    let res;
    if (filter.is_group) {
      filter.children = filter.children || (await filter.getChildren(context));
      res = await validateCondition(context, filter.children, data, {
        client,
      });
    } else {
      const column = await filter.getColumn(context);
      const field = column.title;
      let val = data[field];
      if (
        [
          UITypes.Date,
          UITypes.DateTime,
          UITypes.CreatedTime,
          UITypes.LastModifiedTime,
        ].includes(column.uidt) &&
        !['empty', 'blank', 'notempty', 'notblank'].includes(
          filter.comparison_op,
        )
      ) {
        const dateFormat =
          client === 'mysql2' ? 'YYYY-MM-DD HH:mm:ss' : 'YYYY-MM-DD HH:mm:ssZ';

        let now = dayjs(new Date());
        const dateFormatFromMeta = column?.meta?.date_format;
        const dataVal: any = val;
        let filterVal: any = filter.value;
        if (dateFormatFromMeta && isDateMonthFormat(dateFormatFromMeta)) {
          // reset to 1st
          now = dayjs(now).date(1);
          if (val) val = dayjs(val).date(1);
        }
        if (filterVal) res = dayjs(filterVal).isSame(dataVal, 'day');

        // handle sub operation
        switch (filter.comparison_sub_op) {
          case 'today':
            filterVal = now;
            break;
          case 'tomorrow':
            filterVal = now.add(1, 'day');
            break;
          case 'yesterday':
            filterVal = now.add(-1, 'day');
            break;
          case 'oneWeekAgo':
            filterVal = now.add(-1, 'week');
            break;
          case 'oneWeekFromNow':
            filterVal = now.add(1, 'week');
            break;
          case 'oneMonthAgo':
            filterVal = now.add(-1, 'month');
            break;
          case 'oneMonthFromNow':
            filterVal = now.add(1, 'month');
            break;
          case 'daysAgo':
            if (!filterVal) return;
            filterVal = now.add(-filterVal, 'day');
            break;
          case 'daysFromNow':
            if (!filterVal) return;
            filterVal = now.add(filterVal, 'day');
            break;
          case 'exactDate':
            if (!filterVal) return;
            break;
          // sub-ops for `isWithin` comparison
          case 'pastWeek':
            filterVal = now.add(-1, 'week');
            break;
          case 'pastMonth':
            filterVal = now.add(-1, 'month');
            break;
          case 'pastYear':
            filterVal = now.add(-1, 'year');
            break;
          case 'nextWeek':
            filterVal = now.add(1, 'week');
            break;
          case 'nextMonth':
            filterVal = now.add(1, 'month');
            break;
          case 'nextYear':
            filterVal = now.add(1, 'year');
            break;
          case 'pastNumberOfDays':
            if (!filterVal) return;
            filterVal = now.add(-filterVal, 'day');
            break;
          case 'nextNumberOfDays':
            if (!filterVal) return;
            filterVal = now.add(filterVal, 'day');
            break;
        }

        if (dataVal) {
          switch (filter.comparison_op) {
            case 'eq':
              res = dayjs(dataVal).isSame(filterVal, 'day');
              break;
            case 'neq':
              res = !dayjs(dataVal).isSame(filterVal, 'day');
              break;
            case 'gt':
              res = dayjs(dataVal).isAfter(filterVal, 'day');
              break;
            case 'lt':
              res = dayjs(dataVal).isBefore(filterVal, 'day');
              break;
            case 'lte':
            case 'le':
              res = dayjs(dataVal).isSameOrBefore(filterVal, 'day');
              break;
            case 'gte':
            case 'ge':
              res = dayjs(dataVal).isSameOrAfter(filterVal, 'day');
              break;
            case 'empty':
            case 'blank':
              res = dataVal === '' || dataVal === null || dataVal === undefined;
              break;
            case 'notempty':
            case 'notblank':
              res = !(
                dataVal === '' ||
                dataVal === null ||
                dataVal === undefined
              );
              break;
            case 'isWithin': {
              let now = dayjs(new Date()).format(dateFormat).toString();
              now = column.uidt === UITypes.Date ? now.substring(0, 10) : now;
              switch (filter.comparison_sub_op) {
                case 'pastWeek':
                case 'pastMonth':
                case 'pastYear':
                case 'pastNumberOfDays':
                  res = dayjs(dataVal).isBetween(filterVal, now, 'day');
                  break;
                case 'nextWeek':
                case 'nextMonth':
                case 'nextYear':
                case 'nextNumberOfDays':
                  res = dayjs(dataVal).isBetween(now, filterVal, 'day');
                  break;
              }
            }
          }
        }
      } else {
        switch (typeof filter.value) {
          case 'boolean':
            val = !!data[field];
            break;
          case 'number':
            val = +data[field];
            break;
        }

        if (
          [UITypes.User, UITypes.CreatedBy, UITypes.LastModifiedBy].includes(
            column.uidt,
          )
        ) {
          const userIds = Array.isArray(data[field])
            ? data[field].map((user) => user.id)
            : data[field]?.id
            ? [data[field].id]
            : [];

          const filterValues =
            filter.value?.split(',').map((v) => v.trim()) ?? [];
          switch (filter.comparison_op) {
            case 'anyof':
              res = userIds.some((id) => filterValues.includes(id));
              break;
            case 'nanyof':
              res = !userIds.some((id) => filterValues.includes(id));
              break;
            case 'allof':
              res = filterValues.every((id) => userIds.includes(id));
              break;
            case 'nallof':
              res = !filterValues.every((id) => userIds.includes(id));
              break;
            case 'empty':
            case 'blank':
              res = userIds.length === 0;
              break;
            case 'notempty':
            case 'notblank':
              res = userIds.length > 0;
              break;
            default:
              res = false; // Unsupported operation for User fields
          }
        } else {
          switch (filter.comparison_op) {
            case 'eq':
              res = val == filter.value;
              break;
            case 'neq':
              res = val != filter.value;
              break;
            case 'like':
              res =
                data[field]
                  ?.toString?.()
                  ?.toLowerCase()
                  ?.indexOf(filter.value?.toLowerCase()) > -1;
              break;
            case 'nlike':
              res =
                data[field]
                  ?.toString?.()
                  ?.toLowerCase()
                  ?.indexOf(filter.value?.toLowerCase()) === -1;
              break;
            case 'empty':
            case 'blank':
              res =
                data[field] === '' ||
                data[field] === null ||
                data[field] === undefined;
              break;
            case 'notempty':
            case 'notblank':
              res = !(
                data[field] === '' ||
                data[field] === null ||
                data[field] === undefined
              );
              break;
            case 'checked':
              res = !!data[field];
              break;
            case 'notchecked':
              res = !data[field];
              break;
            case 'null':
              res = res = data[field] === null;
              break;
            case 'notnull':
              res = data[field] !== null;
              break;
            case 'allof':
              res = (
                filter.value?.split(',').map((item) => item.trim()) ?? []
              ).every((item) => (data[field]?.split(',') ?? []).includes(item));
              break;
            case 'anyof':
              res = (
                filter.value?.split(',').map((item) => item.trim()) ?? []
              ).some((item) => (data[field]?.split(',') ?? []).includes(item));
              break;
            case 'nallof':
              res = !(
                filter.value?.split(',').map((item) => item.trim()) ?? []
              ).every((item) => (data[field]?.split(',') ?? []).includes(item));
              break;
            case 'nanyof':
              res = !(
                filter.value?.split(',').map((item) => item.trim()) ?? []
              ).some((item) => (data[field]?.split(',') ?? []).includes(item));
              break;
            case 'lt':
              res = +data[field] < +filter.value;
              break;
            case 'lte':
            case 'le':
              res = +data[field] <= +filter.value;
              break;
            case 'gt':
              res = +data[field] > +filter.value;
              break;
            case 'gte':
            case 'ge':
              res = +data[field] >= +filter.value;
              break;
          }
        }
      }
    }

    switch (filter.logical_op) {
      case 'or':
        isValid = isValid || !!res;
        break;
      case 'not':
        isValid = isValid && !res;
        break;
      case 'and':
      default:
        isValid = (isValid ?? true) && res;
        break;
    }
  }
  return isValid;
}

export function constructWebHookData(hook, model, view, prevData, newData) {
  if (hook.version === 'v2') {
    // extend in the future - currently only support records
    const scope = 'records';

    return {
      type: `${scope}.${hook.event}.${hook.operation}`,
      id: uuidv4(),
      data: {
        table_id: model.id,
        table_name: model.title,
        // webhook are table specific, so no need to send view_id and view_name
        // view_id: view?.id,
        // view_name: view?.title,
        ...(prevData && {
          previous_rows: Array.isArray(prevData) ? prevData : [prevData],
        }),
        ...(hook.operation !== 'bulkInsert' &&
          newData && { rows: Array.isArray(newData) ? newData : [newData] }),
        ...(hook.operation === 'bulkInsert' && {
          rows_inserted: Array.isArray(newData)
            ? newData.length
            : newData
            ? 1
            : 0,
        }),
      },
    };
  }

  // for v1, keep it as it is
  return newData;
}

function populateAxiosReq({
  apiMeta: _apiMeta,
  hook,
  model,
  view,
  prevData,
  newData,
}: {
  apiMeta: any;
  user: UserType;
  hook: HookType | Hook;
  model: TableType;
  view?: ViewType;
  prevData: Record<string, unknown>;
  newData: Record<string, unknown>;
}) {
  if (!_apiMeta) {
    _apiMeta = {};
  }

  const contentType = _apiMeta.headers?.find(
    (header) => header.name?.toLowerCase() === 'content-type' && header.enabled,
  );

  if (!contentType) {
    if (!_apiMeta.headers) {
      _apiMeta.headers = [];
    }

    _apiMeta.headers.push({
      name: 'Content-Type',
      enabled: true,
      value: 'application/json',
    });
  }

  const webhookData = constructWebHookData(
    hook,
    model,
    view,
    prevData,
    newData,
  );
  // const reqPayload = axiosRequestMake(
  //   _apiMeta,
  //   user,
  //   webhookData,
  // );

  const apiMeta = { ..._apiMeta };
  // if it's a string try to parse and apply handlebar
  // or if object then convert into JSON string and parse it
  if (apiMeta.body) {
    try {
      apiMeta.body = JSON.parse(
        typeof apiMeta.body === 'string'
          ? apiMeta.body
          : JSON.stringify(apiMeta.body),
        (_key, value) => {
          return typeof value === 'string'
            ? parseBody(value, webhookData)
            : value;
        },
      );
    } catch (e) {
      // if string parsing failed then directly apply the handlebar
      apiMeta.body = parseBody(apiMeta.body, webhookData);
    }
  }
  if (apiMeta.auth) {
    try {
      apiMeta.auth = JSON.parse(
        typeof apiMeta.auth === 'string'
          ? apiMeta.auth
          : JSON.stringify(apiMeta.auth),
        (_key, value) => {
          return typeof value === 'string'
            ? parseBody(value, webhookData)
            : value;
        },
      );
    } catch (e) {
      apiMeta.auth = parseBody(apiMeta.auth, webhookData);
    }
  }
  apiMeta.response = {};
  const url = parseBody(apiMeta.path, webhookData);

  const reqPayload = {
    params: apiMeta.parameters
      ? apiMeta.parameters.reduce((paramsObj, param) => {
          if (param.name && param.enabled) {
            paramsObj[param.name] = parseBody(param.value, webhookData);
          }
          return paramsObj;
        }, {})
      : {},
    url: url,
    method: apiMeta.method,
    data: apiMeta.body,
    headers: apiMeta.headers
      ? apiMeta.headers.reduce((headersObj, header) => {
          if (header.name && header.enabled) {
            headersObj[header.name] = parseBody(header.value, webhookData);
          }
          return headersObj;
        }, {})
      : {},
    withCredentials: true,
    ...(process.env.NC_ALLOW_LOCAL_HOOKS !== 'true'
      ? {
          httpAgent: useAgent(url, {
            stopPortScanningByUrlRedirection: true,
          }),
          httpsAgent: useAgent(url, {
            stopPortScanningByUrlRedirection: true,
          }),
        }
      : {}),
    timeout: 30 * 1000,
  };

  return reqPayload;
}

function extractReqPayloadForLog(reqPayload, response?: AxiosResponse<any>) {
  return {
    ...reqPayload,
    headers: {
      ...(response?.config?.headers || {}),
      ...(reqPayload.headers || {}),
    },
    // exclude http/https agent filters
    httpAgent: undefined,
    httpsAgent: undefined,
    timeout: undefined,
    withCredentials: undefined,
  };
}

function extractResPayloadForLog(response: AxiosResponse<any>) {
  return {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
    data: response.data,
  };
}

export async function handleHttpWebHook({
  reqPayload,
}: {
  reqPayload: any;
}): Promise<any> {
  const response = await axios(reqPayload);
  return {
    response,
    requestPayload: extractReqPayloadForLog(reqPayload, response),
    responsePayload: extractResPayloadForLog(response),
  };
}

// flatten filter tree and id dummy id if no id is present
function flattenFilter(
  filters: Filter[],
  flattenedFilters = [],
  parentId = null,
) {
  for (const filter of filters) {
    // if parent id is present then set it as fk_parent_id
    if (parentId && !filter.fk_parent_id) {
      filter.fk_parent_id = parentId;
    }

    if (filter.is_group) {
      flattenedFilters.push(filter);
      // this is to group the filters
      if (!filter.id) {
        filter.id = uuidv4();
      }
      flattenFilter(filter.children, flattenedFilters, filter.id);
    } else {
      flattenedFilters.push(filter);
    }
  }
  return flattenedFilters;
}

export async function invokeWebhook(
  context: NcContext,
  param: {
    hook: Hook;
    model: Model;
    view: View;
    prevData;
    newData;
    user;
    testFilters?;
    throwErrorOnFailure?: boolean;
    testHook?: boolean;
  },
) {
  const {
    hook,
    model,
    view,
    prevData,
    user,
    testFilters = null,
    throwErrorOnFailure = false,
    testHook = false,
  } = param;

  let { newData } = param;

  let hookLog: HookLogType;
  const startTime = process.hrtime();
  const source = await Source.get(context, model.source_id);
  let notification, filters;
  let reqPayload;
  try {
    notification =
      typeof hook.notification === 'string'
        ? JSON.parse(hook.notification)
        : hook.notification;

    const isBulkOperation = Array.isArray(newData);

    if (isBulkOperation && notification?.type !== 'URL') {
      // only URL hook is supported for bulk operations
      return;
    }

    if (hook.condition && !testHook) {
      filters = testFilters || (await hook.getFilters(context));

      if (isBulkOperation) {
        const filteredData = [];
        for (let i = 0; i < newData.length; i++) {
          const data = newData[i];

          // disable until we have a way to extract prevData for bulk operations
          // const pData = prevData[i] ? prevData[i] : null;
          //
          // // if condition is satisfied for prevData then return
          // // if filters are not defined then skip the check
          // if (
          //   pData &&
          //   filters.length &&
          //   (await validateCondition(filters, pData))
          // ) {
          //   continue;
          // }

          if (
            await validateCondition(
              context,
              testFilters || (await hook.getFilters(context)),
              data,
              { client: source?.type },
            )
          ) {
            filteredData.push(data);
          }
        }
        if (!filteredData.length) {
          return;
        }
        newData = filteredData;
      } else {
        // if condition is satisfied for prevData then return
        // if filters are not defined then skip the check
        if (
          prevData &&
          filters.length &&
          (await validateCondition(context, filters, prevData, {
            client: source?.type,
          }))
        ) {
          return;
        }
        if (
          !(await validateCondition(
            context,
            testFilters || (await hook.getFilters(context)),
            newData,
            { client: source?.type },
          ))
        ) {
          return;
        }
      }
    }

    switch (notification?.type) {
      case 'Email':
        {
          const parsedPayload = {
            to: parseBody(notification?.payload?.to, newData),
            subject: parseBody(notification?.payload?.subject, newData),
            html: parseBody(notification?.payload?.body, newData),
          };
          const res = await (
            await NcPluginMgrv2.emailAdapter(false)
          )?.mailSend(parsedPayload);
          if (
            process.env.NC_AUTOMATION_LOG_LEVEL === 'ALL' ||
            (isEE && !process.env.NC_AUTOMATION_LOG_LEVEL)
          ) {
            hookLog = {
              ...hook,
              fk_hook_id: hook.id,
              type: notification.type,
              payload: JSON.stringify(parsedPayload),
              response: JSON.stringify(res),
              triggered_by: user?.email,
              conditions: JSON.stringify(filters),
            };
          }
        }
        break;
      case 'URL':
        {
          reqPayload = populateAxiosReq({
            apiMeta: notification?.payload,
            user,
            hook,
            model,
            view,
            prevData,
            newData,
          });

          const { requestPayload, responsePayload } = await handleHttpWebHook({
            reqPayload,
          });

          if (
            process.env.NC_AUTOMATION_LOG_LEVEL === 'ALL' ||
            (isEE && !process.env.NC_AUTOMATION_LOG_LEVEL)
          ) {
            hookLog = {
              ...hook,
              fk_hook_id: hook.id,
              type: notification.type,
              payload: JSON.stringify(requestPayload),
              response: JSON.stringify(responsePayload),
              triggered_by: user?.email,
              conditions: JSON.stringify(filters),
            };
          }
        }
        break;
      default:
        {
          const res = await (
            await NcPluginMgrv2.webhookNotificationAdapters(notification.type)
          ).sendMessage(
            parseBody(notification?.payload?.body, newData),
            JSON.parse(JSON.stringify(notification?.payload), (_key, value) => {
              return typeof value === 'string'
                ? parseBody(value, newData)
                : value;
            }),
          );

          if (
            process.env.NC_AUTOMATION_LOG_LEVEL === 'ALL' ||
            (isEE && !process.env.NC_AUTOMATION_LOG_LEVEL)
          ) {
            hookLog = {
              ...hook,
              fk_hook_id: hook.id,
              type: notification.type,
              payload: JSON.stringify(notification?.payload),
              response: JSON.stringify({
                status: res.status,
                statusText: res.statusText,
                headers: res.headers,
                config: {
                  url: res.config.url,
                  method: res.config.method,
                  data: res.config.data,
                  headers: res.config.headers,
                  params: res.config.params,
                },
              }),
              triggered_by: user?.email,
              conditions: JSON.stringify(filters),
            };
          }
        }
        break;
    }
  } catch (e) {
    if (e.response) {
      logger.error({
        data: e.response.data,
        status: e.response.status,
        url: e.response.config?.url,
        message: e.message,
      });
    } else {
      logger.error(e.message, e.stack);
    }
    if (
      ['ERROR', 'ALL'].includes(process.env.NC_AUTOMATION_LOG_LEVEL) ||
      isEE
    ) {
      hookLog = {
        ...hook,
        type: notification.type,
        payload: JSON.stringify(
          reqPayload
            ? extractReqPayloadForLog(reqPayload, e.response)
            : notification?.payload,
        ),
        fk_hook_id: hook.id,
        error_code: e.error_code,
        error_message: e.message,
        error: JSON.stringify(e),
        triggered_by: user?.email,
        conditions: filters
          ? JSON.stringify(
              addDummyRootAndNest(
                filterBuilder().build(flattenFilter(filters)) as Filter[],
              ),
            )
          : null,
        response: e.response
          ? JSON.stringify(extractResPayloadForLog(e.response))
          : null,
      };
    }
    if (throwErrorOnFailure) {
      if (e.isAxiosError) {
        if (
          e.message.includes('private IP address') ||
          e.response?.data?.message?.includes('private IP address')
        ) {
          throw new Error(
            `Connection to a private network IP is blocked for security reasons.` +
              // shoe env var only if it's not EE or it's on-prem
              (!isEE || isOnPrem
                ? `If this is intentional, set NC_ALLOW_LOCAL_HOOKS=true to allow local network webhooks.`
                : ''),
          );
        }
      }

      throw e;
    }
  } finally {
    if (hookLog) {
      hookLog.execution_time = parseHrtimeToMilliSeconds(
        process.hrtime(startTime),
      );
      HookLog.insert(context, { ...hookLog, test_call: testHook }).catch(
        (e) => {
          logger.error(e.message, e.stack);
        },
      );
    }
  }
}

export function _transformSubmittedFormDataForEmail(
  data,
  // @ts-ignore
  formView,
  // @ts-ignore
  columns: (Column<any> & FormView<any>)[],
) {
  const transformedData = { ...data };

  for (const col of columns) {
    if (col.uidt === 'Attachment') {
      if (typeof transformedData[col.title] === 'string') {
        transformedData[col.title] = JSON.parse(transformedData[col.title]);
      }
      transformedData[col.title] = (transformedData[col.title] || [])
        .map((attachment) => {
          return attachment.title;
        })
        .join('<br/>');
    } else if (
      transformedData[col.title] &&
      typeof transformedData[col.title] === 'object'
    ) {
      transformedData[col.title] = JSON.stringify(transformedData[col.title]);
    }
  }
  return transformedData;
}

export function transformDataForMailRendering(
  data: Record<string, any>,
  columns: (ColumnType & FormColumnType)[],
  source: Source,
  model: Model,
  models: Record<string, TableType>,
) {
  const transformedData: Array<{
    parsedValue?: any;
    columnTitle: string;
    uidt: UITypes | string;
  }> = [];

  columns.map((col) => {
    let serializedValue: string | undefined;

    try {
      serializedValue = ColumnHelper.serializeValue(data[col.title], {
        col,
        isMysql: () => source.type.startsWith('mysql'),
        isPg: () => source.type === 'pg',
        isXcdbBase: () => !!source.isMeta(),
        meta: model,
        metas: models,
      });

      if (col.uidt === 'Attachment') {
        let attachments = data[col.title] || [];
        if (typeof data[col.title] === 'string') {
          try {
            attachments = JSON.parse(data[col.title]);
          } catch (e) {
            attachments = [];
          }
        }
        serializedValue = Array.isArray(attachments)
          ? attachments
              .map((attachment) => attachment?.title || '')
              .filter(Boolean)
              .join(', ')
          : '';
      }
    } catch (error) {
      logger.error(`Error processing column ${col.title}:`, error);
      serializedValue = data[col.title]?.toString() || '';
    }

    transformedData.push({
      parsedValue: serializedValue,
      uidt: col.uidt,
      columnTitle: col.title,
    });
  });

  return transformedData;
}

function parseHrtimeToMilliSeconds(hrtime) {
  const milliseconds = (hrtime[0] + hrtime[1] / 1e6).toFixed(3);
  return milliseconds;
}
