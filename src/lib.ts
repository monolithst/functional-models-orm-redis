/* c8 ignore start */
import {
  DataDescription,
  DatastoreValueType,
  DatastoreSearchResult,
  EqualitySymbol,
  isALinkToken,
  isPropertyBasedQuery,
  ModelType,
  OrmModel,
  OrmSearch,
  PropertyType,
  PrimaryKeyType,
  QueryTokens,
  validateOrmSearch,
  ToObjectResult,
} from 'functional-models'
/* c8 ignore stop */
import { datastoreAdapter as memoryDatastore } from 'functional-models-orm-memory'
import kebabCase from 'lodash/kebabCase.js'
import merge from 'lodash/merge.js'
import { RedisTtlOptions } from './types.js'

const defaultTtlPropertyKey = 'ttl'

export const getKeyPrefixForModel = <T extends DataDescription>(
  model: ModelType<T>
) => {
  return kebabCase(model.getName())
    .replaceAll(/[^a-zA-Z0-9-]/gu, '')
    .toLowerCase()
}

export const getKey = (modelPrefix: string, id: PrimaryKeyType) => {
  return `${modelPrefix}:${id}`
}

export const getSearchIndexName = (keyPrefix: string) => {
  return `idx:${keyPrefix}`
}

export const getSearchDocumentPrefix = (keyPrefix: string) => {
  return `searchdoc:${keyPrefix}:`
}

export const getSearchDocumentKey = (keyPrefix: string, id: PrimaryKeyType) => {
  return `${getSearchDocumentPrefix(keyPrefix)}${id}`
}

const _toStringValue = (value: unknown): string | undefined => {
  if (value === null || value === undefined) {
    return undefined
  }
  if (typeof value === 'string') {
    return value
  }
  if (typeof (value as any).toString === 'function') {
    return (value as any).toString()
  }
  return undefined
}

const _primaryKeyFromRedisKey = (key: string): PrimaryKeyType => {
  const split = key.split(':')
  return split[split.length - 1]
}

export const toModelRecords = <T extends DataDescription>(
  args: Readonly<{
    keys: readonly string[]
    values: readonly unknown[]
  }>
): Record<PrimaryKeyType, ToObjectResult<T>> => {
  return args.values.reduce<Record<PrimaryKeyType, ToObjectResult<T>>>(
    (acc, value, index) => {
      const rawValue = _toStringValue(value)
      if (!rawValue || rawValue === 'undefined') {
        return acc
      }
      const instance = JSON.parse(rawValue) as ToObjectResult<T>
      const primaryKey = _primaryKeyFromRedisKey(args.keys[index])
      return merge(acc, { [primaryKey]: instance })
    },
    {}
  )
}

export const searchRecordsWithMemoryAdapter = <T extends DataDescription>(
  args: Readonly<{
    keyPrefix: string
    ormQuery: OrmSearch
    model: ModelType<T>
    modelRecords: Record<PrimaryKeyType, ToObjectResult<T>>
    getCollectionNameForModel: <TInner extends DataDescription>(
      model: ModelType<TInner>
    ) => string
  }>
): Promise<DatastoreSearchResult<T>> => {
  const memoryAdapter = memoryDatastore.create({
    seedData: {
      [args.keyPrefix]: args.modelRecords,
    },
    getCollectionNameForModel: args.getCollectionNameForModel,
  })
  return memoryAdapter.search(
    args.model as unknown as OrmModel<T>,
    args.ormQuery
  )
}

const _escapeTagValue = (value: string) => {
  return value.replaceAll(/[{}|\\,\-@:'"\s]/gu, x => `\\${x}`)
}

const _escapeTextValue = (value: string) => {
  return value.replaceAll(/[\\]/gu, x => `\\${x}`)
}

const _toTimestamp = (value: unknown): number => {
  if (value instanceof Date) {
    return value.getTime()
  }
  return new Date(String(value)).getTime()
}

const _getPropertyType = <T extends DataDescription>(
  model: ModelType<T>,
  key: string
): PropertyType | undefined => {
  const property = (
    model.getModelDefinition().properties as Record<string, any>
  )[key]
  if (!property || typeof property.getPropertyType !== 'function') {
    return undefined
  }
  return property.getPropertyType()
}

const _ttlSecondsFromIntegerValue = (value: unknown): number | undefined => {
  if (
    typeof value !== 'number' ||
    Number.isInteger(value) === false ||
    value <= 0
  ) {
    return undefined
  }
  return value
}

const _ttlSecondsFromDatetimeValue = (value: unknown): number | undefined => {
  if (value === null || value === undefined) {
    return undefined
  }
  const timestamp =
    value instanceof Date ? value.getTime() : _toTimestamp(value)
  if (Number.isNaN(timestamp)) {
    return undefined
  }
  const ttlSeconds = Math.ceil((timestamp - Date.now()) / 1000)
  if (ttlSeconds <= 0) {
    return undefined
  }
  return ttlSeconds
}

export const resolveTtlSeconds = <T extends DataDescription>(
  args: Readonly<{
    model: ModelType<T>
    data: Record<string, unknown>
    options?: RedisTtlOptions
  }>
): number | undefined => {
  const ttlPropertyKey = args.options?.ttlSelector
    ? args.options.ttlSelector(args.model)
    : args.options?.noDefaultTTL === true
      ? undefined
      : defaultTtlPropertyKey

  if (!ttlPropertyKey) {
    return undefined
  }

  const propertyType = _getPropertyType(args.model, ttlPropertyKey)
  const value = args.data[ttlPropertyKey]

  if (propertyType === PropertyType.Integer) {
    return _ttlSecondsFromIntegerValue(value)
  }

  if (propertyType === PropertyType.Datetime) {
    return _ttlSecondsFromDatetimeValue(value)
  }

  return undefined
}

const _toSortField = <T extends DataDescription>(
  args: Readonly<{
    model: ModelType<T>
    key: string
  }>
): string => {
  const propertyType = _getPropertyType(args.model, args.key)
  if (
    propertyType === PropertyType.Datetime ||
    propertyType === PropertyType.Date
  ) {
    return `${args.key}__ts`
  }
  if (
    propertyType === PropertyType.Number ||
    propertyType === PropertyType.Integer
  ) {
    return args.key
  }
  if (propertyType === PropertyType.Boolean) {
    return args.key
  }
  return `${args.key}__tag`
}

const _stringPropertyQueryToRedisSearch = (query: any): string => {
  const value = String(query.value ?? '')
  const startsWith = Boolean(query.options?.startsWith)
  const endsWith = Boolean(query.options?.endsWith)
  const includes = Boolean(query.options?.includes)

  if (query.equalitySymbol === EqualitySymbol.ne) {
    const escaped = _escapeTagValue(value)
    return `-@${query.key}__tag:{${escaped}}`
  }

  if (startsWith || endsWith || includes) {
    const escaped = _escapeTextValue(value)
    const prefix = startsWith || includes ? '' : '*'
    const suffix = endsWith || includes ? '' : '*'
    return `@${query.key}__text:${prefix}${escaped}${suffix}`
  }

  const escaped = _escapeTagValue(value)
  return `@${query.key}__tag:{${escaped}}`
}

const _numericPropertyQueryToRedisSearch = (query: any): string => {
  const value =
    query.valueType === DatastoreValueType.date
      ? _toTimestamp(query.value)
      : Number(query.value)
  const field =
    query.valueType === DatastoreValueType.date ? `${query.key}__ts` : query.key
  switch (query.equalitySymbol) {
    case EqualitySymbol.eq:
      return `@${field}:[${value} ${value}]`
    case EqualitySymbol.ne:
      return `-@${field}:[${value} ${value}]`
    case EqualitySymbol.gt:
      return `@${field}:[(${value} +inf]`
    case EqualitySymbol.gte:
      return `@${field}:[${value} +inf]`
    case EqualitySymbol.lt:
      return `@${field}:[-inf (${value}]`
    case EqualitySymbol.lte:
      return `@${field}:[-inf ${value}]`
    /* c8 ignore start */
    default:
      return `@${field}:[${value} ${value}]`
    /* c8 ignore stop */
  }
}

const _booleanPropertyQueryToRedisSearch = (query: any): string => {
  const value = query.value ? 'true' : 'false'
  if (query.equalitySymbol === EqualitySymbol.ne) {
    return `-@${query.key}:{${value}}`
  }
  return `@${query.key}:{${value}}`
}

const _propertyQueryToRedisSearch = <T extends DataDescription>(
  args: Readonly<{
    model: ModelType<T>
    query: any
  }>
): string => {
  const query = args.query
  if (query.valueType === DatastoreValueType.string) {
    return _stringPropertyQueryToRedisSearch(query)
  }
  if (
    query.valueType === DatastoreValueType.number ||
    query.valueType === DatastoreValueType.date
  ) {
    return _numericPropertyQueryToRedisSearch(query)
  }
  if (query.valueType === DatastoreValueType.boolean) {
    return _booleanPropertyQueryToRedisSearch(query)
  }
  throw new Error(`Unsupported Redis Stack valueType: ${query.valueType}`)
}

const _datesQueryToRedisSearch = (query: any): string => {
  const field = `${query.key}__ts`
  const value = _toTimestamp(query.date)
  if (query.type === 'datesBefore') {
    const max = query.options?.equalToAndBefore ? `${value}` : `(${value}`
    return `@${field}:[-inf ${max}]`
  }
  const min = query.options?.equalToAndAfter ? `${value}` : `(${value}`
  return `@${field}:[${min} +inf]`
}

const _tokensToRedisSearch = <T extends DataDescription>(
  args: Readonly<{
    model: ModelType<T>
    token: QueryTokens
  }>
): string => {
  if (Array.isArray(args.token)) {
    /* c8 ignore start */
    if (args.token.length < 1) {
      return '*'
    }
    /* c8 ignore stop */

    if (args.token.every(x => isALinkToken(x) === false)) {
      const terms = args.token.map(token =>
        _tokensToRedisSearch({ model: args.model, token })
      )
      return `(${terms.join(' ')})`
    }

    const [first, ...rest] = args.token
    const firstExpr = _tokensToRedisSearch({ model: args.model, token: first })
    return rest.reduce((acc, value, index) => {
      if (index % 2 !== 0) {
        return acc
      }
      const operator = String(value).toUpperCase() === 'OR' ? '|' : ' '
      const nextToken = rest[index + 1]
      /* c8 ignore start */
      if (!nextToken) {
        return acc
      }
      /* c8 ignore stop */
      const nextExpr = _tokensToRedisSearch({
        model: args.model,
        token: nextToken,
      })
      return `(${acc} ${operator} ${nextExpr})`
    }, firstExpr)
  }

  if (isPropertyBasedQuery(args.token)) {
    if (args.token.type === 'property') {
      return _propertyQueryToRedisSearch({
        model: args.model,
        query: args.token,
      })
    }
    if (args.token.type === 'datesBefore' || args.token.type === 'datesAfter') {
      return _datesQueryToRedisSearch(args.token)
    }
  }

  /* c8 ignore next */
  throw new Error('Unsupported query token for Redis Stack search')
}

export const toRedisSearchQuery = <T extends DataDescription>(
  args: Readonly<{
    model: ModelType<T>
    ormQuery: OrmSearch
  }>
): string => {
  validateOrmSearch(args.ormQuery)
  if (!args.ormQuery.query || args.ormQuery.query.length < 1) {
    return '*'
  }
  return _tokensToRedisSearch({
    model: args.model,
    token: args.ormQuery.query,
  })
}

export const toRedisSearchSortArgs = <T extends DataDescription>(
  args: Readonly<{
    model: ModelType<T>
    ormQuery: OrmSearch
  }>
): readonly string[] => {
  if (!args.ormQuery.sort) {
    return []
  }
  return [
    'SORTBY',
    _toSortField({ model: args.model, key: args.ormQuery.sort.key }),
    args.ormQuery.sort.order === 'dsc' ? 'DESC' : 'ASC',
  ]
}

const defaultRedisSearchTake = 10_000
export const toRedisSearchLimitArgs = (
  ormQuery: OrmSearch
): readonly string[] => {
  const take = ormQuery.take || defaultRedisSearchTake
  return ['LIMIT', '0', String(take)]
}

const _extractRawFromDocRow = (docRow: unknown): string | undefined => {
  /* c8 ignore next */
  if (!Array.isArray(docRow)) {
    return undefined
  }
  return docRow.reduce<string | undefined>((acc, _value, index, arr) => {
    if (acc !== undefined || index % 2 !== 0) {
      return acc
    }
    if (String(arr[index]) === '__raw') {
      return String(arr[index + 1] ?? '')
    }
    return acc
  }, undefined)
}

export const fromRedisSearchResponse = <T extends DataDescription>(
  response: unknown
): DatastoreSearchResult<T> => {
  if (!Array.isArray(response) || response.length < 1) {
    return {
      instances: [],
      page: undefined,
    }
  }

  const instances = response
    .slice(1)
    .filter((_, index) => index % 2 === 1)
    .map(_extractRawFromDocRow)
    .filter(Boolean)
    .map(raw => JSON.parse(raw as string) as ToObjectResult<T>)

  return {
    instances,
    page: undefined,
  }
}

export const toRedisSearchSchemaArgs = <T extends DataDescription>(
  model: ModelType<T>
): readonly string[] => {
  const properties = model.getModelDefinition().properties as Record<
    string,
    any
  >
  return Object.entries(properties).reduce<string[]>((acc, [key, property]) => {
    const propertyType = property.getPropertyType()
    if (
      propertyType === PropertyType.Datetime ||
      propertyType === PropertyType.Date
    ) {
      return acc.concat([`${key}__ts`, 'NUMERIC', 'SORTABLE'])
    }
    if (
      propertyType === PropertyType.Number ||
      propertyType === PropertyType.Integer
    ) {
      return acc.concat([key, 'NUMERIC', 'SORTABLE'])
    }
    if (propertyType === PropertyType.Boolean) {
      return acc.concat([key, 'TAG', 'SORTABLE'])
    }
    return acc.concat([
      `${key}__tag`,
      'TAG',
      'SORTABLE',
      `${key}__text`,
      'TEXT',
    ])
  }, [])
}

/* c8 ignore next */
export const toRedisSearchHashDocument = <T extends DataDescription>(
  args: Readonly<{
    model: ModelType<T>
    data: ToObjectResult<T>
  }>
): Record<string, string | number> => {
  const properties = args.model.getModelDefinition().properties as Record<
    string,
    any
  >
  const base = {
    __raw: JSON.stringify(args.data),
  }

  return Object.entries(properties).reduce<Record<string, string | number>>(
    (acc, [key, property]) => {
      const value = (args.data as Record<string, unknown>)[key]
      if (value === undefined || value === null) {
        return acc
      }
      const propertyType = property.getPropertyType()
      if (
        propertyType === PropertyType.Datetime ||
        propertyType === PropertyType.Date
      ) {
        return merge(acc, { [`${key}__ts`]: _toTimestamp(value) })
      }
      if (
        propertyType === PropertyType.Number ||
        propertyType === PropertyType.Integer
      ) {
        return merge(acc, { [key]: Number(value) })
      }
      if (propertyType === PropertyType.Boolean) {
        return merge(acc, { [key]: value ? 'true' : 'false' })
      }
      return merge(acc, {
        [`${key}__tag`]: String(value),
        [`${key}__text`]: String(value),
      })
    },
    base
  )
}
