import { assert } from 'chai'
import { Model, TextProperty, queryBuilder } from 'functional-models'
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
