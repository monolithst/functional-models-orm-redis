import * as datastoreAdapter from './datastoreAdapter.js'

export { getKeyPrefixForModel } from './lib.js'
export type {
  RedisOptions as CreateOptions,
  RedisDatastoreAdapterProps as CreateProps,
} from './datastoreAdapter.js'
export type { RedisClientLike } from './types.js'

export { datastoreAdapter }
