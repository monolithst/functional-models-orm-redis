import { createClient } from 'redis'

type NativeRedisClient = ReturnType<typeof createClient>

export type RedisClientLike = Readonly<
  Pick<
    NativeRedisClient,
    'sendCommand' | 'keys' | 'mGet' | 'get' | 'set' | 'hSet' | 'del' | 'mSet'
  >
> & {
  mset?: (...args: string[]) => Promise<unknown>
}
