import { createClient } from 'redis'
import { DataDescription, ModelType } from 'functional-models'

type NativeRedisClient = ReturnType<typeof createClient>

export type RedisClientLike = Readonly<
  Pick<
    NativeRedisClient,
    | 'sendCommand'
    | 'keys'
    | 'mGet'
    | 'get'
    | 'set'
    | 'hSet'
    | 'del'
    | 'mSet'
    | 'expire'
  >
> & {
  mset?: (...args: string[]) => Promise<unknown>
}

export type RedisTtlOptions = Readonly<{
  ttlSelector?: <T extends DataDescription>(
    model: ModelType<T>
  ) => string | undefined
  noDefaultTTL?: boolean
}>

export type RedisOptions = Readonly<{
  search?: Readonly<{
    redisStack?: boolean
  }>
}> &
  RedisTtlOptions

export type RedisDatastoreAdapterProps = Readonly<{
  redisClient: RedisClientLike
  getKeyPrefixForModel?: <T extends DataDescription>(
    model: ModelType<T>
  ) => string
  options?: RedisOptions
}>
