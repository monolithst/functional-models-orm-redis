import { assert } from 'chai'
import {
  DatetimeProperty,
  IntegerProperty,
  Model,
  TextProperty,
  queryBuilder,
} from 'functional-models'
import { describe, it } from 'mocha'
import sinon from 'sinon'
import { create as createDatastoreAdapter } from '../../src/datastoreAdapter.js'
import { getKey, getKeyPrefixForModel } from '../../src/lib.js'

type TestModelData = Readonly<{
  id: string
  name: string
}>

const TestModel = Model<TestModelData>({
  pluralName: 'Model1',
  namespace: '@functional-models-orm-redis',
  properties: {
    id: TextProperty(),
    name: TextProperty(),
  },
})
const TestOrmModel = TestModel as any

const TtlTestModel = Model<Readonly<{ id: string; name: string; ttl: number }>>(
  {
    pluralName: 'TtlModel',
    namespace: '@functional-models-orm-redis',
    properties: {
      id: TextProperty(),
      name: TextProperty(),
      ttl: IntegerProperty(),
    },
  }
)
const TtlTestOrmModel = TtlTestModel as any

const DatetimeTtlTestModel = Model<
  Readonly<{ id: string; name: string; ttl: string }>
>({
  pluralName: 'DatetimeTtlModel',
  namespace: '@functional-models-orm-redis',
  properties: {
    id: TextProperty(),
    name: TextProperty(),
    ttl: DatetimeProperty(),
  },
})

const createRedisClientMock = () => {
  return {
    sendCommand: sinon.stub().resolves([]),
    keys: sinon.stub().resolves([]),
    mGet: sinon.stub().resolves([]),
    get: sinon.stub().resolves(null),
    set: sinon.stub().resolves('OK'),
    hSet: sinon.stub().resolves(1),
    del: sinon.stub().resolves(1),
    mSet: sinon.stub().resolves('OK'),
    expire: sinon.stub().resolves(1),
  }
}

describe('/src/datastoreAdapter.ts', () => {
  describe('#retrieve()', () => {
    it('should return a parsed object when a redis value exists', async () => {
      const input = {
        redisClient: createRedisClientMock(),
        id: 'id-1',
        model: TestOrmModel,
        value: {
          id: 'id-1',
          name: 'alpha',
        },
      }
      input.redisClient.get.resolves(JSON.stringify(input.value))

      const adapter = createDatastoreAdapter({ redisClient: input.redisClient })
      const actual = await adapter.retrieve(input.model, input.id)
      const expected = input.value

      assert.deepEqual(actual, expected)
    })

    it('should return null when a redis value does not exist', async () => {
      const input = {
        redisClient: createRedisClientMock(),
        id: 'missing-id',
        model: TestOrmModel,
      }

      const adapter = createDatastoreAdapter({ redisClient: input.redisClient })
      const actual = await adapter.retrieve(input.model, input.id)
      const expected = null

      assert.equal(actual, expected)
    })
  })

  describe('#save()', () => {
    it('should store the serialized model instance at the expected key', async () => {
      const input = {
        redisClient: createRedisClientMock(),
        instance: TestModel.create({
          id: 'id-1',
          name: 'alpha',
        }),
      }
      const adapter = createDatastoreAdapter({ redisClient: input.redisClient })

      const actual = await adapter.save(input.instance)
      const expected = {
        id: 'id-1',
        name: 'alpha',
      }

      const keyPrefix = getKeyPrefixForModel(TestModel)
      const expectedKey = getKey(keyPrefix, 'id-1')
      assert.deepEqual(actual, expected)
      assert.equal(input.redisClient.set.callCount, 1)
      assert.deepEqual(input.redisClient.set.firstCall.args, [
        expectedKey,
        JSON.stringify(expected),
      ])
    })

    it('should call expire when the model has a ttl Integer property', async () => {
      const input = {
        redisClient: createRedisClientMock(),
        instance: TtlTestModel.create({
          id: 'id-1',
          name: 'alpha',
          ttl: 30,
        }),
      }
      const adapter = createDatastoreAdapter({ redisClient: input.redisClient })

      const actual = await adapter.save(input.instance)
      const expected = {
        id: 'id-1',
        name: 'alpha',
        ttl: 30,
      }

      const keyPrefix = getKeyPrefixForModel(TtlTestModel)
      const expectedKey = getKey(keyPrefix, 'id-1')
      assert.deepEqual(actual, expected)
      assert.equal(input.redisClient.expire.callCount, 1)
      assert.deepEqual(input.redisClient.expire.firstCall.args, [
        expectedKey,
        30,
      ])
    })

    it('should call expire when the model has a ttl Datetime property', async () => {
      const now = new Date('2024-01-01T00:00:00.000Z')
      const clock = sinon.useFakeTimers({ now: now.getTime() })
      const input = {
        redisClient: createRedisClientMock(),
        instance: DatetimeTtlTestModel.create({
          id: 'id-1',
          name: 'alpha',
          ttl: '2024-01-01T00:01:00.000Z',
        }),
      }
      const adapter = createDatastoreAdapter({ redisClient: input.redisClient })

      const actual = await adapter.save(input.instance)
      const expected = {
        id: 'id-1',
        name: 'alpha',
        ttl: '2024-01-01T00:01:00.000Z',
      }

      const keyPrefix = getKeyPrefixForModel(DatetimeTtlTestModel)
      const expectedKey = getKey(keyPrefix, 'id-1')
      assert.deepEqual(actual, expected)
      assert.equal(input.redisClient.expire.callCount, 1)
      assert.deepEqual(input.redisClient.expire.firstCall.args, [
        expectedKey,
        60,
      ])
      clock.restore()
    })

    it('should not call expire when noDefaultTTL is true', async () => {
      const input = {
        redisClient: createRedisClientMock(),
        instance: TtlTestModel.create({
          id: 'id-1',
          name: 'alpha',
          ttl: 30,
        }),
      }
      const adapter = createDatastoreAdapter({
        redisClient: input.redisClient,
        options: {
          noDefaultTTL: true,
        },
      })

      const actual = await adapter.save(input.instance)
      const expected = {
        id: 'id-1',
        name: 'alpha',
        ttl: 30,
      }

      assert.deepEqual(actual, expected)
      assert.equal(input.redisClient.expire.callCount, 0)
    })
  })

  describe('#bulkInsert()', () => {
    it('should call mSet once with all serialized records', async () => {
      const input = {
        redisClient: createRedisClientMock(),
        instances: [
          TestModel.create({ id: 'id-1', name: 'alpha' }),
          TestModel.create({ id: 'id-2', name: 'beta' }),
        ],
      }
      const adapter = createDatastoreAdapter({ redisClient: input.redisClient })

      const actual = await adapter.bulkInsert(TestOrmModel, input.instances)
      const expected = undefined

      const keyPrefix = getKeyPrefixForModel(TestModel)
      assert.equal(actual, expected)
      assert.equal(input.redisClient.mSet.callCount, 1)
      assert.deepEqual(input.redisClient.mSet.firstCall.args[0], {
        [getKey(keyPrefix, 'id-1')]: JSON.stringify({
          id: 'id-1',
          name: 'alpha',
        }),
        [getKey(keyPrefix, 'id-2')]: JSON.stringify({
          id: 'id-2',
          name: 'beta',
        }),
      })
    })

    it('should call expire for each record with a ttl Integer property', async () => {
      const input = {
        redisClient: createRedisClientMock(),
        instances: [
          TtlTestModel.create({ id: 'id-1', name: 'alpha', ttl: 10 }),
          TtlTestModel.create({ id: 'id-2', name: 'beta', ttl: 20 }),
        ],
      }
      const adapter = createDatastoreAdapter({ redisClient: input.redisClient })

      const actual = await adapter.bulkInsert(TtlTestOrmModel, input.instances)
      const expected = undefined

      const keyPrefix = getKeyPrefixForModel(TtlTestModel)
      assert.equal(actual, expected)
      assert.equal(input.redisClient.expire.callCount, 2)
      assert.deepEqual(input.redisClient.expire.firstCall.args, [
        getKey(keyPrefix, 'id-1'),
        10,
      ])
      assert.deepEqual(input.redisClient.expire.secondCall.args, [
        getKey(keyPrefix, 'id-2'),
        20,
      ])
    })
  })

  describe('#count()', () => {
    it('should return the number of keys found for the model prefix', async () => {
      const input = {
        redisClient: createRedisClientMock(),
        model: TestOrmModel,
      }
      input.redisClient.keys.resolves(['a', 'b', 'c'])

      const adapter = createDatastoreAdapter({ redisClient: input.redisClient })
      const actual = await adapter.count(input.model)
      const expected = 3

      assert.equal(actual, expected)
    })
  })

  describe('#delete()', () => {
    it('should delete a model key for a single id', async () => {
      const input = {
        redisClient: createRedisClientMock(),
        model: TestOrmModel,
        id: 'id-1',
      }
      const adapter = createDatastoreAdapter({ redisClient: input.redisClient })

      const actual = await adapter.delete(input.model, input.id)
      const expected = undefined

      const keyPrefix = getKeyPrefixForModel(TestModel)
      assert.equal(actual, expected)
      assert.deepEqual(input.redisClient.del.firstCall.args, [
        getKey(keyPrefix, input.id),
      ])
    })
  })

  describe('#search()', () => {
    it('should fallback to memory search using keys and mGet', async () => {
      const input = {
        redisClient: createRedisClientMock(),
        model: TestOrmModel,
        ormQuery: queryBuilder().property('name', 'alpha').compile(),
      }
      const keyPrefix = getKeyPrefixForModel(input.model)
      input.redisClient.keys.resolves([
        getKey(keyPrefix, 'id-1'),
        getKey(keyPrefix, 'id-2'),
      ])
      input.redisClient.mGet.resolves([
        JSON.stringify({ id: 'id-1', name: 'alpha' }),
        JSON.stringify({ id: 'id-2', name: 'beta' }),
      ])

      const adapter = createDatastoreAdapter({ redisClient: input.redisClient })
      const actual = await adapter.search(input.model, input.ormQuery)
      const expected = {
        instances: [{ id: 'id-1', name: 'alpha' }],
        page: undefined,
      }

      assert.deepEqual(actual, expected)
    })
  })
})
