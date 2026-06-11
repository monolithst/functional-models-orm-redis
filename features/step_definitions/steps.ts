import { assert } from 'chai'
import {
  After,
  AfterAll,
  Given,
  setDefaultTimeout,
  Then,
  When,
} from '@cucumber/cucumber'
import { createClient } from 'redis'
import {
  DatastoreValueType,
  EqualitySymbol,
  IntegerProperty,
  ModelType,
  PrimaryKeyUuidProperty,
  queryBuilder,
  TextProperty,
  createOrm,
} from 'functional-models'
import * as redisDatastoreAdapter from '../../src/datastoreAdapter.js'
import { GenericContainer, StartedTestContainer, Wait } from 'testcontainers'

const cucumberStepTimeoutMs = 120_000
const containerStartupTimeoutMs = 120_000

setDefaultTimeout(cucumberStepTimeoutMs)

type RedisClientType = ReturnType<typeof createClient>

const pendingCleanup = {
  containers: [] as StartedTestContainer[],
  clients: [] as RedisClientType[],
}

const REDIS_IMAGES = {
  RedisDatastore: 'redis:7-alpine',
  RedisStackDatastore: 'redis/redis-stack-server:latest',
} as const

const MODELS = {
  Model1: [
    {
      pluralName: 'Model1',
      namespace: 'functional-models-orm-redis',
      properties: {
        id: PrimaryKeyUuidProperty(),
        name: TextProperty({ required: true }),
        score: IntegerProperty({ required: true }),
      },
    },
  ],
}

const MODEL_DATA = {
  SingleModelDataAlpha: () => ({
    id: '00000000-0000-4000-8000-000000000001',
    name: 'alpha',
    score: 5,
  }),
  ModelDataSet1: () => [
    {
      id: '00000000-0000-4000-8000-000000000001',
      name: 'alpha',
      score: 5,
    },
    {
      id: '00000000-0000-4000-8000-000000000002',
      name: 'beta',
      score: 10,
    },
  ],
  SearchResultByName: () => ({
    id: '00000000-0000-4000-8000-000000000001',
    name: 'alpha',
    score: 5,
  }),
  SearchResultByScore: () => ({
    id: '00000000-0000-4000-8000-000000000002',
    name: 'beta',
    score: 10,
  }),
}

const QUERIES = {
  SearchByName: queryBuilder().property('name', 'alpha').take(1).compile(),
  SearchByScore: queryBuilder()
    .property('score', 10, {
      type: DatastoreValueType.number,
      equalitySymbol: EqualitySymbol.eq,
    })
    .take(1)
    .compile(),
}

const _singleModelData = (dataKey: string) => {
  const data = MODEL_DATA[dataKey as keyof typeof MODEL_DATA]()
  if (Array.isArray(data)) {
    return data[0]
  }
  return data
}

const _trackContainer = (container: StartedTestContainer) => {
  pendingCleanup.containers.push(container)
  return container
}

const _trackClient = (client: RedisClientType) => {
  pendingCleanup.clients.push(client)
  return client
}

const _untrackContainer = (container: StartedTestContainer) => {
  pendingCleanup.containers = pendingCleanup.containers.filter(
    tracked => tracked !== container
  )
}

const _untrackClient = (client: RedisClientType) => {
  pendingCleanup.clients = pendingCleanup.clients.filter(
    tracked => tracked !== client
  )
}

const _stopClients = async (clients: readonly RedisClientType[]) => {
  await Promise.all(
    clients.map(async client => {
      if (client.isOpen) {
        await client.quit()
      }
    })
  )
}

const _stopContainers = async (containers: readonly StartedTestContainer[]) => {
  await Promise.all(
    containers.map(async container => {
      await container.stop()
    })
  )
}

const _cleanupResources = async (
  containers: readonly StartedTestContainer[],
  clients: readonly RedisClientType[]
) => {
  await _stopClients(clients)
  clients.forEach(client => _untrackClient(client))
  await _stopContainers(containers)
  containers.forEach(container => _untrackContainer(container))
}

const _startRedisContainer = async (store: keyof typeof REDIS_IMAGES) => {
  const image = REDIS_IMAGES[store]
  const container = await new GenericContainer(image)
    .withExposedPorts(6379)
    .withStartupTimeout(containerStartupTimeoutMs)
    .withWaitStrategy(Wait.forLogMessage('Ready to accept connections'))
    .start()
  return _trackContainer(container)
}

const _createDatastore = async (store: keyof typeof REDIS_IMAGES) => {
  const container = await _startRedisContainer(store)
  const host = container.getHost()
  const port = container.getMappedPort(6379)
  const redisClient = _trackClient(
    createClient({
      url: `redis://${host}:${port}`,
    })
  )
  await redisClient.connect()
  await redisClient.flushDb()
  return {
    container,
    redisClient,
    datastoreAdapter: redisDatastoreAdapter.create({
      redisClient,
      options:
        store === 'RedisStackDatastore'
          ? {
              search: {
                redisStack: true,
              },
            }
          : undefined,
    }),
  }
}

const _emptyDatastoreProvider = async (world: any) => {
  const all = await world.datastoreAdapter.search(
    world.model,
    queryBuilder().compile()
  )
  const ids = all.instances.map((x: any) => x.id)
  if (ids.length > 0) {
    await world.datastoreAdapter.bulkDelete(world.model, ids)
  }
}

Given('orm using the {word}', async function (storeKey: string) {
  const store = storeKey as keyof typeof REDIS_IMAGES
  const created = await _createDatastore(store)
  this.redisContainers = (this.redisContainers || []).concat([
    created.container,
  ])
  this.redisClients = (this.redisClients || []).concat([created.redisClient])
  this.datastoreAdapter = created.datastoreAdapter
  this.Model = createOrm({ datastoreAdapter: this.datastoreAdapter }).Model
})

Given('the orm is used to create {word}', function (modelType: string) {
  const model = MODELS[modelType as keyof typeof MODELS]
  this.model = this.Model(...model) as ModelType<any>
})

Given('the datastore is emptied of models', async function () {
  return _emptyDatastoreProvider(this)
})

When(
  'instances of the model are created with {word}',
  function (dataKey: string) {
    const loadedData = MODEL_DATA[dataKey as keyof typeof MODEL_DATA]()
    const data = Array.isArray(loadedData) ? loadedData : [loadedData]
    this.instances = data.map(obj => this.model.create(obj))
  }
)

When('save is called on the instances', async function () {
  await Promise.all(this.instances.map((x: any) => x.save()))
})

When(
  "the datastore's search is called with {word}",
  async function (queryKey: string) {
    const query = QUERIES[queryKey as keyof typeof QUERIES]
    this.result = await this.datastoreAdapter.search(this.model, query)
  }
)

When(
  "the datastore's retrieve is called with id from {word}",
  async function (dataKey: string) {
    const data = _singleModelData(dataKey)
    this.result = await this.datastoreAdapter.retrieve(this.model, data.id)
  }
)

When(
  "the datastore's delete is called with id from {word}",
  async function (dataKey: string) {
    const data = _singleModelData(dataKey)
    await this.datastoreAdapter.delete(this.model, data.id)
  }
)

When("the datastore's count is called", async function () {
  this.countResult = await this.datastoreAdapter.count(this.model)
})

When("the datastore's bulkInsert is called with instances", async function () {
  await this.datastoreAdapter.bulkInsert(this.model, this.instances)
})

When(
  "the datastore's bulkDelete is called with instance ids",
  async function () {
    const ids = await Promise.all(
      this.instances.map((instance: any) => instance.getPrimaryKey())
    )
    await this.datastoreAdapter.bulkDelete(this.model, ids)
  }
)

Then('{int} search results are found', function (count: number) {
  assert.equal(this.result.instances.length, count)
})

Then('the first result matches {word}', function (dataKey: string) {
  const expected = MODEL_DATA[dataKey as keyof typeof MODEL_DATA]()
  const actual = this.result.instances[0]
  assert.deepEqual(actual, expected)
})

Then('the result matches {word}', function (dataKey: string) {
  const expected = MODEL_DATA[dataKey as keyof typeof MODEL_DATA]()
  assert.deepEqual(this.result, expected)
})

Then('the result is null', function () {
  assert.equal(this.result, null)
})

Then('the count is {int}', function (count: number) {
  assert.equal(this.countResult, count)
})

After(async function () {
  const containers = (this.redisContainers || []) as StartedTestContainer[]
  const clients = (this.redisClients || []) as RedisClientType[]
  await _cleanupResources(containers, clients)
})

AfterAll(async () => {
  await _cleanupResources(pendingCleanup.containers, pendingCleanup.clients)
})
