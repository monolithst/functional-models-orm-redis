import { assert } from 'chai'
import {
  BooleanProperty,
  DatastoreValueType,
  DatetimeProperty,
  EqualitySymbol,
  IntegerProperty,
  Model,
  PropertyType,
  TextProperty,
  queryBuilder,
  SortOrder,
} from 'functional-models'
import {
  fromRedisSearchResponse,
  getKey,
  getKeyPrefixForModel,
  getSearchDocumentKey,
  getSearchDocumentPrefix,
  getSearchIndexName,
  searchRecordsWithMemoryAdapter,
  toModelRecords,
  toRedisSearchHashDocument,
  toRedisSearchLimitArgs,
  toRedisSearchQuery,
  toRedisSearchSchemaArgs,
  toRedisSearchSortArgs,
} from '../../src/lib.js'

type TestModelData = Readonly<{
  id: string
  name: string
  score: number
  createdAt: string
  enabled: boolean
}>

const TestModel = Model<TestModelData>({
  pluralName: 'Model1',
  namespace: '@functional-models-orm-redis',
  properties: {
    id: TextProperty(),
    name: TextProperty(),
    score: IntegerProperty(),
    createdAt: DatetimeProperty(),
    enabled: BooleanProperty(),
  },
})

describe('/src/lib.ts', () => {
  describe('#getKeyPrefixForModel()', () => {
    it('should return a normalized kebab-case prefix', () => {
      const input = {
        model: TestModel,
      }
      const actual = getKeyPrefixForModel(input.model)
      const expected = 'functional-models-orm-redis-model-1'
      assert.deepEqual(actual, expected)
    })
  })

  describe('#getKey()', () => {
    it('should combine prefix and id', () => {
      const input = {
        modelPrefix: 'my-model',
        id: 'abc-123',
      }
      const actual = getKey(input.modelPrefix, input.id)
      const expected = 'my-model:abc-123'
      assert.deepEqual(actual, expected)
    })
  })

  describe('#getSearchIndexName()', () => {
    it('should return the redis index key', () => {
      const input = {
        keyPrefix: 'my-model',
      }
      const actual = getSearchIndexName(input.keyPrefix)
      const expected = 'idx:my-model'
      assert.deepEqual(actual, expected)
    })
  })

  describe('#getSearchDocumentPrefix()', () => {
    it('should return the search document prefix', () => {
      const input = {
        keyPrefix: 'my-model',
      }
      const actual = getSearchDocumentPrefix(input.keyPrefix)
      const expected = 'searchdoc:my-model:'
      assert.deepEqual(actual, expected)
    })
  })

  describe('#getSearchDocumentKey()', () => {
    it('should return the full redis stack document key', () => {
      const input = {
        keyPrefix: 'my-model',
        id: 'abc-123',
      }
      const actual = getSearchDocumentKey(input.keyPrefix, input.id)
      const expected = 'searchdoc:my-model:abc-123'
      assert.deepEqual(actual, expected)
    })
  })

  describe('#toModelRecords()', () => {
    it('should map redis keys and json values into id keyed records', () => {
      const input = {
        keys: ['my-model:id-1', 'my-model:id-2', 'my-model:id-3'],
        values: [
          JSON.stringify({ id: 'id-1', name: 'alpha' }),
          'undefined',
          JSON.stringify({ id: 'id-3', name: 'gamma' }),
        ],
      }
      const actual = toModelRecords(input)
      const expected = {
        'id-1': { id: 'id-1', name: 'alpha' },
        'id-3': { id: 'id-3', name: 'gamma' },
      }
      assert.deepEqual(actual, expected)
    })

    it('should handle null and object values with toString methods', () => {
      const input = {
        keys: ['my-model:id-1', 'my-model:id-2', 'my-model:id-3'],
        values: [
          null,
          {
            toString: () => JSON.stringify({ id: 'id-2', name: 'beta' }),
          },
          undefined,
        ],
      }
      const actual = toModelRecords(input)
      const expected = {
        'id-2': { id: 'id-2', name: 'beta' },
      }
      assert.deepEqual(actual, expected)
    })

    it('should skip values that have no toString function', () => {
      const input = {
        keys: ['my-model:id-1'],
        values: [Object.create(null)],
      }
      const actual = toModelRecords(input)
      const expected = {}
      assert.deepEqual(actual, expected)
    })
  })

  describe('#searchRecordsWithMemoryAdapter()', () => {
    it('should run a memory backed search and return matching instances', async () => {
      const input = {
        keyPrefix: 'my-model',
        model: TestModel,
        ormQuery: queryBuilder().property('name', 'alpha').compile(),
        modelRecords: {
          'id-1': {
            id: 'id-1',
            name: 'alpha',
            score: 5,
            createdAt: '2024-01-01T00:00:00.000Z',
            enabled: true,
          },
          'id-2': {
            id: 'id-2',
            name: 'beta',
            score: 10,
            createdAt: '2024-01-02T00:00:00.000Z',
            enabled: false,
          },
        },
        getCollectionNameForModel: () => 'my-model',
      }
      const actual = await searchRecordsWithMemoryAdapter(input)
      const expected = {
        instances: [
          {
            id: 'id-1',
            name: 'alpha',
            score: 5,
            createdAt: '2024-01-01T00:00:00.000Z',
            enabled: true,
          },
        ],
        page: undefined,
      }
      assert.deepEqual(actual, expected)
    })
  })

  describe('#toRedisSearchQuery()', () => {
    it('should return wildcard query for empty orm query', () => {
      const input = {
        model: TestModel,
        ormQuery: queryBuilder().compile(),
      }
      const actual = toRedisSearchQuery(input)
      const expected = '*'
      assert.deepEqual(actual, expected)
    })

    it('should build a redis query for string equality', () => {
      const input = {
        model: TestModel,
        ormQuery: queryBuilder().property('name', 'alpha').compile(),
      }
      const actual = toRedisSearchQuery(input)
      const expected = '(@name__tag:{alpha})'
      assert.deepEqual(actual, expected)
    })

    it('should build a redis query for number ranges', () => {
      const input = {
        model: TestModel,
        ormQuery: queryBuilder()
          .property('score', 10, {
            type: DatastoreValueType.number,
            equalitySymbol: EqualitySymbol.gte,
          })
          .compile(),
      }
      const actual = toRedisSearchQuery(input)
      const expected = '(@score:[10 +inf])'
      assert.deepEqual(actual, expected)
    })

    it('should build a redis query for datesBefore', () => {
      const input = {
        model: TestModel,
        ormQuery: queryBuilder()
          .datesBefore('createdAt', '2024-01-01', {
            valueType: DatastoreValueType.date,
          })
          .compile(),
      }
      const actual = toRedisSearchQuery(input)
      const expected = '(@createdAt__ts:[-inf 1704067200000])'
      assert.deepEqual(actual, expected)
    })

    it('should build a redis query for datesAfter', () => {
      const input = {
        model: TestModel,
        ormQuery: queryBuilder()
          .datesAfter('createdAt', '2024-01-01', {
            valueType: DatastoreValueType.date,
          })
          .compile(),
      }
      const actual = toRedisSearchQuery(input)
      const expected = '(@createdAt__ts:[1704067200000 +inf])'
      assert.deepEqual(actual, expected)
    })

    it('should build an OR query expression', () => {
      const input = {
        model: TestModel,
        ormQuery: queryBuilder()
          .property('name', 'alpha')
          .or()
          .property('name', 'beta')
          .compile(),
      }
      const actual = toRedisSearchQuery(input)
      const expected = '(@name__tag:{alpha} | @name__tag:{beta})'
      assert.deepEqual(actual, expected)
    })

    it('should throw for unsupported value type', () => {
      const input = {
        model: TestModel,
        ormQuery: {
          query: [
            {
              type: 'property',
              key: 'obj',
              // @ts-ignore
              valueType: DatastoreValueType.object,
              value: { ok: true },
              equalitySymbol: EqualitySymbol.eq,
              options: {},
            },
          ],
        },
      }
      const actual = () => toRedisSearchQuery(input as any)
      const expected = 'Unsupported Redis Stack valueType: object'
      assert.throws(actual, expected)
    })

    it('should build a redis query for string inequality', () => {
      const input = {
        model: TestModel,
        ormQuery: queryBuilder()
          .property('name', 'alpha', {
            type: DatastoreValueType.string,
            equalitySymbol: EqualitySymbol.ne,
          })
          .compile(),
      }
      const actual = toRedisSearchQuery(input)
      const expected = '(-@name__tag:{alpha})'
      assert.deepEqual(actual, expected)
    })

    it('should build a redis query for string includes search', () => {
      const input = {
        model: TestModel,
        ormQuery: {
          query: [
            {
              type: 'property',
              key: 'name',
              value: 'alpha',
              valueType: DatastoreValueType.string,
              equalitySymbol: EqualitySymbol.eq,
              options: {
                includes: true,
              },
            },
          ],
        } as any,
      }
      const actual = toRedisSearchQuery(input)
      const expected = '(@name__text:alpha)'
      assert.deepEqual(actual, expected)
    })

    it('should build a redis query for startsWith search', () => {
      const input = {
        model: TestModel,
        ormQuery: {
          query: [
            {
              type: 'property',
              key: 'name',
              value: 'alpha',
              valueType: DatastoreValueType.string,
              equalitySymbol: EqualitySymbol.eq,
              options: {
                startsWith: true,
              },
            },
          ],
        } as any,
      }
      const actual = toRedisSearchQuery(input)
      const expected = '(@name__text:alpha*)'
      assert.deepEqual(actual, expected)
    })

    it('should build a redis query for endsWith search', () => {
      const input = {
        model: TestModel,
        ormQuery: {
          query: [
            {
              type: 'property',
              key: 'name',
              value: 'alpha',
              valueType: DatastoreValueType.string,
              equalitySymbol: EqualitySymbol.eq,
              options: {
                endsWith: true,
              },
            },
          ],
        } as any,
      }
      const actual = toRedisSearchQuery(input)
      const expected = '(@name__text:*alpha)'
      assert.deepEqual(actual, expected)
    })

    it('should default undefined string values to empty text', () => {
      const input = {
        model: TestModel,
        ormQuery: {
          query: [
            {
              type: 'property',
              key: 'name',
              value: undefined,
              valueType: DatastoreValueType.string,
              equalitySymbol: EqualitySymbol.eq,
              options: {},
            },
          ],
        } as any,
      }
      const actual = toRedisSearchQuery(input)
      const expected = '(@name__tag:{})'
      assert.deepEqual(actual, expected)
    })

    it('should build a redis query for date property equality', () => {
      const input = {
        model: TestModel,
        ormQuery: queryBuilder()
          .property('createdAt', new Date('2024-01-01T00:00:00.000Z'), {
            type: DatastoreValueType.date,
            equalitySymbol: EqualitySymbol.eq,
          })
          .compile(),
      }
      const actual = toRedisSearchQuery(input)
      const expected = '(@createdAt__ts:[1704067200000 1704067200000])'
      assert.deepEqual(actual, expected)
    })

    it('should build a redis query for date property less-than', () => {
      const input = {
        model: TestModel,
        ormQuery: queryBuilder()
          .property('createdAt', '2024-01-01T00:00:00.000Z', {
            type: DatastoreValueType.date,
            equalitySymbol: EqualitySymbol.lt,
          })
          .compile(),
      }
      const actual = toRedisSearchQuery(input)
      const expected = '(@createdAt__ts:[-inf (1704067200000])'
      assert.deepEqual(actual, expected)
    })

    it('should build a redis query for number greater-than', () => {
      const input = {
        model: TestModel,
        ormQuery: queryBuilder()
          .property('score', 5, {
            type: DatastoreValueType.number,
            equalitySymbol: EqualitySymbol.gt,
          })
          .compile(),
      }
      const actual = toRedisSearchQuery(input)
      const expected = '(@score:[(5 +inf])'
      assert.deepEqual(actual, expected)
    })

    it('should build a redis query for number inequality', () => {
      const input = {
        model: TestModel,
        ormQuery: queryBuilder()
          .property('score', 5, {
            type: DatastoreValueType.number,
            equalitySymbol: EqualitySymbol.ne,
          })
          .compile(),
      }
      const actual = toRedisSearchQuery(input)
      const expected = '(-@score:[5 5])'
      assert.deepEqual(actual, expected)
    })

    it('should build a redis query for number less-than-or-equal', () => {
      const input = {
        model: TestModel,
        ormQuery: queryBuilder()
          .property('score', 5, {
            type: DatastoreValueType.number,
            equalitySymbol: EqualitySymbol.lte,
          })
          .compile(),
      }
      const actual = toRedisSearchQuery(input)
      const expected = '(@score:[-inf 5])'
      assert.deepEqual(actual, expected)
    })

    it('should build a redis query for boolean equality', () => {
      const input = {
        model: TestModel,
        ormQuery: queryBuilder()
          .property('enabled', true, {
            type: DatastoreValueType.boolean,
            equalitySymbol: EqualitySymbol.eq,
          })
          .compile(),
      }
      const actual = toRedisSearchQuery(input)
      const expected = '(@enabled:{true})'
      assert.deepEqual(actual, expected)
    })

    it('should build a redis query for boolean inequality', () => {
      const input = {
        model: TestModel,
        ormQuery: queryBuilder()
          .property('enabled', false, {
            type: DatastoreValueType.boolean,
            equalitySymbol: EqualitySymbol.ne,
          })
          .compile(),
      }
      const actual = toRedisSearchQuery(input)
      const expected = '(-@enabled:{false})'
      assert.deepEqual(actual, expected)
    })

    it('should build a redis query for explicit AND expression', () => {
      const input = {
        model: TestModel,
        ormQuery: queryBuilder()
          .property('name', 'alpha')
          .and()
          .property('score', 10, {
            type: DatastoreValueType.number,
            equalitySymbol: EqualitySymbol.gte,
          })
          .compile(),
      }
      const actual = toRedisSearchQuery(input)
      const expected = '(@name__tag:{alpha}   @score:[10 +inf])'
      assert.deepEqual(actual, expected)
    })

    it('should build a redis query for exclusive datesBefore option', () => {
      const input = {
        model: TestModel,
        ormQuery: {
          query: [
            {
              type: 'datesBefore',
              key: 'createdAt',
              date: '2024-01-01',
              valueType: DatastoreValueType.date,
              options: {
                equalToAndBefore: false,
              },
            },
          ],
        } as any,
      }
      const actual = toRedisSearchQuery(input)
      const expected = '(@createdAt__ts:[-inf (1704067200000])'
      assert.deepEqual(actual, expected)
    })

    it('should build a redis query for exclusive datesAfter option', () => {
      const input = {
        model: TestModel,
        ormQuery: {
          query: [
            {
              type: 'datesAfter',
              key: 'createdAt',
              date: '2024-01-01',
              valueType: DatastoreValueType.date,
              options: {
                equalToAndAfter: false,
              },
            },
          ],
        } as any,
      }
      const actual = toRedisSearchQuery(input)
      const expected = '(@createdAt__ts:[(1704067200000 +inf])'
      assert.deepEqual(actual, expected)
    })
  })

  describe('#toRedisSearchSortArgs()', () => {
    it('should map datetime fields to __ts sort keys', () => {
      const input = {
        model: TestModel,
        ormQuery: queryBuilder()
          .property('name', 'alpha')
          .sort('createdAt', SortOrder.dsc)
          .compile(),
      }
      const actual = toRedisSearchSortArgs(input)
      const expected = ['SORTBY', 'createdAt__ts', 'DESC']
      assert.deepEqual(actual, expected)
    })

    it('should return empty args when sort is not provided', () => {
      const input = {
        model: TestModel,
        ormQuery: queryBuilder().property('name', 'alpha').compile(),
      }
      const actual = toRedisSearchSortArgs(input)
      const expected: readonly string[] = []
      assert.deepEqual(actual, expected)
    })

    it('should map integer fields directly for sort', () => {
      const input = {
        model: TestModel,
        ormQuery: queryBuilder()
          .property('name', 'alpha')
          .sort('score', SortOrder.asc)
          .compile(),
      }
      const actual = toRedisSearchSortArgs(input)
      const expected = ['SORTBY', 'score', 'ASC']
      assert.deepEqual(actual, expected)
    })

    it('should map boolean fields directly for sort', () => {
      const input = {
        model: TestModel,
        ormQuery: queryBuilder()
          .property('name', 'alpha')
          .sort('enabled', SortOrder.asc)
          .compile(),
      }
      const actual = toRedisSearchSortArgs(input)
      const expected = ['SORTBY', 'enabled', 'ASC']
      assert.deepEqual(actual, expected)
    })

    it('should fallback to tag sort field when property does not exist', () => {
      const input = {
        model: TestModel,
        ormQuery: {
          query: [
            {
              type: 'property',
              key: 'name',
              value: 'alpha',
              valueType: DatastoreValueType.string,
              equalitySymbol: EqualitySymbol.eq,
              options: {},
            },
          ],
          sort: {
            key: 'missing',
            order: 'asc',
          },
        } as any,
      }
      const actual = toRedisSearchSortArgs(input)
      const expected = ['SORTBY', 'missing__tag', 'ASC']
      assert.deepEqual(actual, expected)
    })
  })

  describe('#toRedisSearchLimitArgs()', () => {
    it('should map take to redis limit args', () => {
      const input = queryBuilder().take(5).compile()
      const actual = toRedisSearchLimitArgs(input)
      const expected = ['LIMIT', '0', '5']
      assert.deepEqual(actual, expected)
    })

    it('should default take to 10000 when omitted', () => {
      const input = queryBuilder().compile()
      const actual = toRedisSearchLimitArgs(input)
      const expected = ['LIMIT', '0', '10000']
      assert.deepEqual(actual, expected)
    })
  })

  describe('#fromRedisSearchResponse()', () => {
    it('should parse FT.SEARCH style response rows into instances', () => {
      const input = [
        2,
        'searchdoc:model:id-1',
        ['__raw', JSON.stringify({ id: 'id-1', name: 'alpha' })],
        'searchdoc:model:id-2',
        ['__raw', JSON.stringify({ id: 'id-2', name: 'beta' })],
      ]
      const actual = fromRedisSearchResponse(input)
      const expected = {
        instances: [
          { id: 'id-1', name: 'alpha' },
          { id: 'id-2', name: 'beta' },
        ],
        page: undefined,
      }
      assert.deepEqual(actual, expected)
    })

    it('should return an empty result for non-array response', () => {
      const input = 'not-an-array'
      const actual = fromRedisSearchResponse(input)
      const expected = {
        instances: [],
        page: undefined,
      }
      assert.deepEqual(actual, expected)
    })

    it('should ignore rows missing __raw field', () => {
      const input = [1, 'searchdoc:model:id-1', ['name', 'alpha']]
      const actual = fromRedisSearchResponse(input)
      const expected = {
        instances: [],
        page: undefined,
      }
      assert.deepEqual(actual, expected)
    })

    it('should ignore non-array document rows', () => {
      const input = [1, 'searchdoc:model:id-1', 'not-an-array']
      const actual = fromRedisSearchResponse(input)
      const expected = {
        instances: [],
        page: undefined,
      }
      assert.deepEqual(actual, expected)
    })

    it('should ignore rows when __raw value is undefined', () => {
      const input = [1, 'searchdoc:model:id-1', ['__raw', undefined]]
      const actual = fromRedisSearchResponse(input)
      const expected = {
        instances: [],
        page: undefined,
      }
      assert.deepEqual(actual, expected)
    })
  })

  describe('#toRedisSearchSchemaArgs()', () => {
    it('should build sortable schema args based on property types', () => {
      const input = {
        model: TestModel,
      }
      const actual = toRedisSearchSchemaArgs(input.model)
      const expected = [
        'id__tag',
        'TAG',
        'SORTABLE',
        'id__text',
        'TEXT',
        'name__tag',
        'TAG',
        'SORTABLE',
        'name__text',
        'TEXT',
        'score',
        'NUMERIC',
        'SORTABLE',
        'createdAt__ts',
        'NUMERIC',
        'SORTABLE',
        'enabled',
        'TAG',
        'SORTABLE',
      ]
      assert.deepEqual(actual, expected)
    })

    it('should verify datetime property type assumptions', () => {
      const input = {
        model: TestModel,
      }
      const actual = input.model
        .getModelDefinition()
        .properties.createdAt.getPropertyType()
      const expected = PropertyType.Datetime
      assert.deepEqual(actual, expected)
    })
  })

  describe('#toRedisSearchHashDocument()', () => {
    it('should map values to indexable redis hash fields', () => {
      const input = {
        model: TestModel,
        data: {
          id: 'id-1',
          name: 'alpha',
          score: 42,
          createdAt: '2024-05-01T12:00:00.000Z',
          enabled: true,
        },
      }
      const actual = toRedisSearchHashDocument(input)
      const expected = {
        __raw: JSON.stringify(input.data),
        id__tag: 'id-1',
        id__text: 'id-1',
        name__tag: 'alpha',
        name__text: 'alpha',
        score: 42,
        createdAt__ts: new Date('2024-05-01T12:00:00.000Z').getTime(),
        enabled: 'true',
      }
      assert.deepEqual(actual, expected)
    })

    it('should skip null and undefined values while keeping __raw', () => {
      const model = Model({
        pluralName: 'Model2',
        namespace: 'functional-models-orm-redis',
        properties: {
          id: TextProperty(),
          name: TextProperty(),
          score: IntegerProperty(),
          enabled: BooleanProperty(),
        },
      })
      const input = {
        model,
        data: {
          id: 'id-1',
          name: undefined,
          score: null,
          enabled: false,
        },
      }
      const actual = toRedisSearchHashDocument(input as any)
      const expected = {
        __raw: JSON.stringify(input.data),
        id__tag: 'id-1',
        id__text: 'id-1',
        enabled: 'false',
      }
      assert.deepEqual(actual, expected)
    })
  })
})
