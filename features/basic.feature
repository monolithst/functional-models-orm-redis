Feature: Basic Redis Functionality

  Scenario: Can save and retrieve a model
    Given orm using the RedisDatastore
    And the orm is used to create Model1
    And the datastore is emptied of models
    When instances of the model are created with SingleModelDataAlpha
    And save is called on the instances
    And the datastore's retrieve is called with id from SingleModelDataAlpha
    Then the result matches SingleModelDataAlpha

  Scenario: Can delete a model by id
    Given orm using the RedisDatastore
    And the orm is used to create Model1
    And the datastore is emptied of models
    When instances of the model are created with SingleModelDataAlpha
    And save is called on the instances
    And the datastore's delete is called with id from SingleModelDataAlpha
    And the datastore's retrieve is called with id from SingleModelDataAlpha
    Then the result is null

  Scenario: Can count models
    Given orm using the RedisDatastore
    And the orm is used to create Model1
    And the datastore is emptied of models
    When instances of the model are created with ModelDataSet1
    And save is called on the instances
    And the datastore's count is called
    Then the count is 2

  Scenario: Can bulk insert models
    Given orm using the RedisDatastore
    And the orm is used to create Model1
    And the datastore is emptied of models
    When instances of the model are created with ModelDataSet1
    And the datastore's bulkInsert is called with instances
    And the datastore's count is called
    Then the count is 2

  Scenario: Can bulk delete models
    Given orm using the RedisDatastore
    And the orm is used to create Model1
    And the datastore is emptied of models
    When instances of the model are created with ModelDataSet1
    And save is called on the instances
    And the datastore's bulkDelete is called with instance ids
    And the datastore's count is called
    Then the count is 0

  Scenario: Can search models using regular Redis fallback
    Given orm using the RedisDatastore
    And the orm is used to create Model1
    And the datastore is emptied of models
    When instances of the model are created with ModelDataSet1
    And save is called on the instances
    And the datastore's search is called with SearchByName
    Then 1 search results are found
    And the first result matches SearchResultByName

  Scenario: Can search models using Redis Stack
    Given orm using the RedisStackDatastore
    And the orm is used to create Model1
    And the datastore is emptied of models
    When instances of the model are created with ModelDataSet1
    And save is called on the instances
    And the datastore's search is called with SearchByScore
    Then 1 search results are found
    And the first result matches SearchResultByScore
