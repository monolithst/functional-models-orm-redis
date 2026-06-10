import {
  DataDescription,
  DatastoreAdapter,
  DatastoreSearchResult,
  ModelInstance,
  ModelType,
  OrmSearch,
  PrimaryKeyType,
} from 'functional-models'
import groupBy from 'lodash/groupBy.js'
import { RedisClientLike } from './types.js'
import {
  getKeyPrefixForModel as defaultGetKeyPrefixForModel,
  fromRedisSearchResponse,
  getKey,
  getSearchDocumentKey,
  getSearchDocumentPrefix,
  getSearchIndexName,
  searchRecordsWithMemoryAdapter,
  toRedisSearchHashDocument,
  toRedisSearchLimitArgs,
  toRedisSearchQuery,
  toRedisSearchSchemaArgs,
  toRedisSearchSortArgs,
  toModelRecords,
} from './lib.js'

type WithRequired<T, K extends keyof T> = T & { [P in K]-?: T[P] }

export type RedisOptions = Readonly<{
  search?: Readonly<{
    redisStack?: boolean
  }>
}>

export type RedisDatastoreAdapterProps = Readonly<{
  redisClient: RedisClientLike
  getKeyPrefixForModel?: <T extends DataDescription>(
    model: ModelType<T>
  ) => string
  options?: RedisOptions
}>

export const create = ({
  redisClient,
  getKeyPrefixForModel = defaultGetKeyPrefixForModel,
  options,
}: RedisDatastoreAdapterProps): WithRequired<
  DatastoreAdapter,
  'bulkInsert' | 'count' | 'bulkDelete'
> => {
  const stackIndexesReady = new Set<string>()
  const stackEnabled = options?.search?.redisStack === true

  const ensureRedisStackIndex = async <T extends DataDescription>(
    model: ModelType<T>,
    keyPrefix: string
  ) => {
    const indexName = getSearchIndexName(keyPrefix)
    if (stackIndexesReady.has(indexName)) {
      return indexName
    }

    const schemaArgs = toRedisSearchSchemaArgs(model)
    if (schemaArgs.length < 1) {
      stackIndexesReady.add(indexName)
      return indexName
    }

    const createArgs = [
      'FT.CREATE',
      indexName,
      'ON',
      'HASH',
      'PREFIX',
      '1',
      getSearchDocumentPrefix(keyPrefix),
      'SCHEMA',
      ...schemaArgs,
    ]

    await redisClient.sendCommand(createArgs).catch(error => {
      const message = String(error)
      if (
        !message.includes('Index already exists') &&
        !message.includes('Duplicate index name')
      ) {
        throw error
      }
    })

    stackIndexesReady.add(indexName)
    return indexName
  }

  const mset = (entries: ReadonlyArray<readonly [string, string]>) => {
    if (entries.length < 1) {
      return Promise.resolve(undefined)
    }

    if (typeof redisClient.mSet === 'function') {
      return redisClient.mSet(Object.fromEntries(entries)).then(() => {
        return undefined
      })
    }

    if (typeof redisClient.mset === 'function') {
      const msetArgs = entries.reduce<string[]>((acc, [key, value]) => {
        return acc.concat([key, value])
      }, [])
      return redisClient
        .mset(...(msetArgs as [string, ...string[]]))
        .then(() => {
          return undefined
        })
    }

    throw new Error('Redis client does not support mSet or mset')
  }

  const search = <T extends DataDescription>(
    model: ModelType<T>,
    ormQuery: OrmSearch
  ): Promise<DatastoreSearchResult<T>> => {
    return Promise.resolve().then(async () => {
      const keyPrefix = getKeyPrefixForModel(model)
      if (stackEnabled) {
        const indexName = await ensureRedisStackIndex(model, keyPrefix)
        const redisQuery = toRedisSearchQuery({ model, ormQuery })
        const stackResults = await redisClient
          .sendCommand([
            'FT.SEARCH',
            indexName,
            redisQuery,
            'RETURN',
            '1',
            '__raw',
            ...toRedisSearchSortArgs({ model, ormQuery }),
            ...toRedisSearchLimitArgs(ormQuery),
          ])
          .then(fromRedisSearchResponse<T>)
          .catch(() => undefined)
        if (stackResults && stackResults.instances.length > 0) {
          return stackResults
        }
      }

      const keys = await redisClient.keys(`${keyPrefix}:*`)
      const values =
        keys.length < 1 ? [] : await redisClient.mGet([...keys] as string[])
      const modelRecords = toModelRecords<T>({
        keys,
        values,
      })

      const getCollectionNameForModel = <TInner extends DataDescription>(
        _model: ModelType<TInner>
      ): string => {
        return keyPrefix
      }

      if (options?.search?.redisStack === true) {
        return searchRecordsWithMemoryAdapter({
          keyPrefix,
          ormQuery,
          model,
          modelRecords,
          getCollectionNameForModel,
        })
      }

      return searchRecordsWithMemoryAdapter({
        keyPrefix,
        ormQuery,
        model,
        modelRecords,
        getCollectionNameForModel,
      })
    })
  }

  const retrieve = <T extends DataDescription>(
    model: ModelType<T>,
    id: PrimaryKeyType
  ) => {
    return Promise.resolve().then(() => {
      const keyPrefix = getKeyPrefixForModel(model)
      const key = getKey(keyPrefix, id)
      return redisClient.get(key).then((value: string | null) => {
        if (value === null) {
          return null
        }
        return JSON.parse(value)
      })
    })
  }

  const save = async <T extends DataDescription>(
    instance: ModelInstance<T>
  ) => {
    return Promise.resolve().then(async () => {
      const model = instance.getModel()
      const keyPrefix = getKeyPrefixForModel<T>(model)
      const obj = await instance.toObj<T>()
      const primaryKey = await instance.getPrimaryKey()
      const key = getKey(keyPrefix, primaryKey)
      await redisClient.set(key, JSON.stringify(obj))

      if (stackEnabled) {
        await ensureRedisStackIndex(model, keyPrefix)
        await redisClient.hSet(
          getSearchDocumentKey(keyPrefix, primaryKey),
          toRedisSearchHashDocument({
            model,
            data: obj,
          })
        )
      }

      return obj
    })
  }

  const bulkInsert = async <T extends DataDescription>(
    model: ModelType<T>,
    instances: readonly ModelInstance<T>[]
  ) => {
    return Promise.resolve().then(async () => {
      if (instances.length < 1) {
        return undefined
      }
      const groups = groupBy(instances, x => x.getModel().getName())
      if (Object.keys(groups).length > 1) {
        throw new Error(`Cannot have more than one model type.`)
      }
      const keyPrefix = getKeyPrefixForModel<T>(model)
      const entries = await Promise.all(
        instances.map(async instance => {
          const obj = await instance.toObj<T>()
          const primaryKey = await instance.getPrimaryKey()
          const key = getKey(keyPrefix, primaryKey)
          return [key, JSON.stringify(obj)] as const
        })
      )
      await mset(entries)

      if (stackEnabled) {
        await ensureRedisStackIndex(model, keyPrefix)
        await Promise.all(
          instances.map(async instance => {
            const obj = await instance.toObj<T>()
            const primaryKey = await instance.getPrimaryKey()
            return redisClient.hSet(
              getSearchDocumentKey(keyPrefix, primaryKey),
              toRedisSearchHashDocument({
                model,
                data: obj,
              })
            )
          })
        )
      }

      return undefined
    })
  }

  const deleteObj = <T extends DataDescription>(
    model: ModelType<T>,
    id: PrimaryKeyType
  ) => {
    return Promise.resolve().then(async () => {
      const keyPrefix = getKeyPrefixForModel<T>(model)
      const key = getKey(keyPrefix, id)
      if (stackEnabled) {
        await redisClient.del([key, getSearchDocumentKey(keyPrefix, id)])
        return undefined
      }
      await redisClient.del(key)
      return undefined
    })
  }

  const count = <T extends DataDescription>(
    model: ModelType<T>
  ): Promise<number> => {
    const keyPrefix = getKeyPrefixForModel<T>(model)
    return redisClient
      .keys(`${keyPrefix}:*`)
      .then((keys: readonly string[]) => {
        return keys.length
      })
  }

  const bulkDelete = <T extends DataDescription>(
    model: ModelType<T>,
    ids: readonly PrimaryKeyType[]
  ) => {
    return Promise.resolve().then(async () => {
      if (ids.length < 1) {
        return undefined
      }
      const keyPrefix = getKeyPrefixForModel<T>(model)
      const keys = ids.map(id => getKey(keyPrefix, id))
      if (stackEnabled) {
        const searchKeys = ids.map(id => getSearchDocumentKey(keyPrefix, id))
        await redisClient.del(keys.concat(searchKeys))
        return undefined
      }
      await redisClient.del(keys)
      return undefined
    })
  }

  return {
    bulkInsert,
    bulkDelete,
    // @ts-ignore
    search,
    retrieve,
    save,
    delete: deleteObj,
    count,
  }
}
