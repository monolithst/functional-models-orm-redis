Feature: TTL Redis Functionality

  Scenario: Saved record is retrievable before ttl expires and null after
    Given orm using the RedisDatastore
    And the orm is used to create TtlModel
    And the datastore is emptied of models
    When instances of the model are created with TtlModelData
    And save is called on the instances
    And the datastore's retrieve is called with id from TtlModelData
    Then the result matches TtlModelData
    When 5 seconds elapse
    And the datastore's retrieve is called with id from TtlModelData
    Then the result is null

  Scenario: Bulk inserted record expires after ttl elapses
    Given orm using the RedisDatastore
    And the orm is used to create TtlModel
    And the datastore is emptied of models
    When instances of the model are created with TtlModelData
    And the datastore's bulkInsert is called with instances
    And the datastore's retrieve is called with id from TtlModelData
    Then the result matches TtlModelData
    When 5 seconds elapse
    And the datastore's retrieve is called with id from TtlModelData
    Then the result is null
