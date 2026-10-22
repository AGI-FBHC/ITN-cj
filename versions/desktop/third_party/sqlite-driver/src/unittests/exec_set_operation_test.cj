package sqlite_driver.unittests

import std.unittest.*
import std.unittest.testmacro.*

@Test
class SetOperationChainTest {
    @TestCase
    func keepsEveryTermInAThreeItemChain(): Unit {
        expectSameAsSqlite(Array<String>(), "SELECT 1 UNION ALL SELECT 2 UNION ALL SELECT 3",
            "three UNION ALL terms remain in the result")
    }

    @TestCase
    func keepsEveryTermInAFourItemChain(): Unit {
        expectSameAsSqlite(Array<String>(), "SELECT 1 UNION ALL SELECT 2 UNION ALL SELECT 3 UNION ALL SELECT 4",
            "four UNION ALL terms remain in the result")
    }

    @TestCase
    func unionThenExceptIsLeftAssociative(): Unit {
        expectSameAsSqlite(Array<String>(), "SELECT 1 UNION ALL SELECT 2 EXCEPT SELECT 1",
            "EXCEPT applies to the accumulated UNION result")
    }

    @TestCase
    func unionThenIntersectIsLeftAssociative(): Unit {
        expectSameAsSqlite(Array<String>(), "SELECT 1 UNION SELECT 2 INTERSECT SELECT 2",
            "INTERSECT applies to the accumulated UNION result")
    }

    @TestCase
    func orderAndLimitApplyAfterTheWholeChain(): Unit {
        expectSameAsSqlite(Array<String>(), "SELECT 3 AS n UNION ALL SELECT 1 UNION ALL SELECT 2 ORDER BY n LIMIT 2",
            "ORDER BY and LIMIT apply after every set term")
    }
}
