package sqlite_driver.unittests

import std.unittest.*
import std.unittest.testmacro.*

let WINDOW_SETUP: Array<String> = [
    "CREATE TABLE w (id INTEGER PRIMARY KEY, g TEXT, v INTEGER, s TEXT)",
    "INSERT INTO w VALUES (1,'a',10,'A'),(2,'a',10,'a'),(3,'a',20,'b')," + "(4,'b',5,'c'),(5,'b',15,'d'),(6,'b',15,'e')"
]

@Test
class WindowRankingTest {
    @TestCase
    func ranksRowsWithinEachPartition(): Unit {
        expectSameAsSqlite(WINDOW_SETUP,
            "SELECT id, row_number() OVER (PARTITION BY g ORDER BY v,id), " + "rank() OVER (PARTITION BY g ORDER BY v), " +
                "dense_rank() OVER (PARTITION BY g ORDER BY v), " + "percent_rank() OVER (PARTITION BY g ORDER BY v), " +
                "cume_dist() OVER (PARTITION BY g ORDER BY v) FROM w ORDER BY id", "window ranking functions")
    }

    @TestCase
    func honoursCollationWhenFindingPeers(): Unit {
        expectSameAsSqlite(WINDOW_SETUP,
            "SELECT id, rank() OVER (ORDER BY s COLLATE NOCASE), " +
                "dense_rank() OVER (ORDER BY s COLLATE NOCASE) FROM w ORDER BY id", "window peers use collation")
    }

    @TestCase
    func distributesNtileRemaindersIntoTheFirstBuckets(): Unit {
        expectSameAsSqlite(WINDOW_SETUP,
            "SELECT id, ntile(4) OVER (ORDER BY id), ntile(8) OVER (ORDER BY id) FROM w ORDER BY id",
            "ntile bucket distribution")
    }

    @TestCase
    func ranksTheWholePartitionWithoutOrderBy(): Unit {
        expectSameAsSqlite(WINDOW_SETUP,
            "SELECT id, row_number() OVER (PARTITION BY g), rank() OVER (PARTITION BY g), " +
                "dense_rank() OVER (PARTITION BY g), cume_dist() OVER (PARTITION BY g) " + "FROM w ORDER BY id",
            "ranking without window order")
    }
}

@Test
class WindowValueTest {
    @TestCase
    func readsLagAndLeadWithOffsetsAndDefaults(): Unit {
        expectSameAsSqlite(WINDOW_SETUP,
            "SELECT id, lag(v) OVER (PARTITION BY g ORDER BY id), " + "lead(v) OVER (PARTITION BY g ORDER BY id), " +
                "lag(v,2,-id) OVER (ORDER BY id), lead(v,2,-id) OVER (ORDER BY id) " + "FROM w ORDER BY id",
            "lag and lead")
    }

    @TestCase
    func usesTheDefaultRangeFrameForFirstAndLastValue(): Unit {
        expectSameAsSqlite(WINDOW_SETUP,
            "SELECT id, first_value(v) OVER (PARTITION BY g ORDER BY id), " +
                "last_value(v) OVER (PARTITION BY g ORDER BY v), " + "last_value(v) OVER (PARTITION BY g ORDER BY id " +
                "ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING) FROM w ORDER BY id",
            "first and last value frames")
    }

    @TestCase
    func returnsNthValueOnlyAfterItEntersTheFrame(): Unit {
        expectSameAsSqlite(WINDOW_SETUP,
            "SELECT id, nth_value(v,2) OVER (PARTITION BY g ORDER BY id " +
                "ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW), " +
                "nth_value(v,4) OVER (ORDER BY id ROWS BETWEEN 1 PRECEDING AND 2 FOLLOWING) " + "FROM w ORDER BY id",
            "nth_value frame membership")
    }
}

@Test
class WindowFrameTest {
    @TestCase
    func evaluatesRowsFramesAtBothPartitionEdges(): Unit {
        expectSameAsSqlite(WINDOW_SETUP,
            "SELECT id, sum(v) OVER (PARTITION BY g ORDER BY id " + "ROWS BETWEEN 1 PRECEDING AND 1 FOLLOWING), " +
                "count(*) OVER (ORDER BY id ROWS BETWEEN 2 FOLLOWING AND 3 FOLLOWING) " + "FROM w ORDER BY id",
            "ROWS frames")
    }

    @TestCase
    func evaluatesNumericRangeFramesInBothDirections(): Unit {
        expectSameAsSqlite(WINDOW_SETUP,
            "SELECT id, sum(v) OVER (ORDER BY v RANGE BETWEEN 5 PRECEDING AND 5 FOLLOWING), " +
                "sum(v) OVER (ORDER BY v DESC RANGE BETWEEN 5 PRECEDING AND 5 FOLLOWING) " + "FROM w ORDER BY id",
            "numeric RANGE frames")
    }

    @TestCase
    func treatsTextRangeOffsetsAsPeerFrames(): Unit {
        expectSameAsSqlite(WINDOW_SETUP,
            "SELECT id, sum(v) OVER (ORDER BY s RANGE BETWEEN 1 PRECEDING AND 1 FOLLOWING), " +
                "count(*) OVER (ORDER BY s COLLATE NOCASE RANGE CURRENT ROW) FROM w ORDER BY id",
            "text RANGE peer frames")
    }

    @TestCase
    func evaluatesGroupsFramesByPeerGroupRatherThanRow(): Unit {
        expectSameAsSqlite(WINDOW_SETUP,
            "SELECT id, count(*) OVER (ORDER BY v GROUPS BETWEEN 1 PRECEDING AND CURRENT ROW), " +
                "sum(v) OVER (ORDER BY v GROUPS BETWEEN CURRENT ROW AND 1 FOLLOWING) FROM w ORDER BY id",
            "GROUPS frames")
    }

    @TestCase
    func defaultsToTheWholePartitionWithoutOrderBy(): Unit {
        expectSameAsSqlite(WINDOW_SETUP,
            "SELECT id, sum(v) OVER (PARTITION BY g), first_value(v) OVER (PARTITION BY g), " +
                "last_value(v) OVER (PARTITION BY g) FROM w ORDER BY id", "default unordered frame")
    }
}

@Test
class WindowAggregateTest {
    @TestCase
    func supportsEveryExistingAggregateAsAWindow(): Unit {
        expectSameAsSqlite(WINDOW_SETUP,
            "SELECT id, count(*) OVER (PARTITION BY g ORDER BY id ROWS UNBOUNDED PRECEDING), " +
                "count(v) OVER (PARTITION BY g ORDER BY id ROWS UNBOUNDED PRECEDING), " +
                "sum(v) OVER (PARTITION BY g ORDER BY id ROWS UNBOUNDED PRECEDING), " +
                "total(v) OVER (PARTITION BY g ORDER BY id ROWS UNBOUNDED PRECEDING), " +
                "avg(v) OVER (PARTITION BY g ORDER BY id ROWS UNBOUNDED PRECEDING), " +
                "min(v) OVER (PARTITION BY g ORDER BY id ROWS UNBOUNDED PRECEDING), " +
                "max(v) OVER (PARTITION BY g ORDER BY id ROWS UNBOUNDED PRECEDING), " +
                "group_concat(id,':') OVER (PARTITION BY g ORDER BY id ROWS UNBOUNDED PRECEDING) " + "FROM w ORDER BY id",
            "aggregate window functions")
    }

    @TestCase
    func filtersRowsInsideTheWindowFrame(): Unit {
        expectSameAsSqlite(WINDOW_SETUP,
            "SELECT id, sum(v) FILTER (WHERE id%2=0) OVER " + "(ORDER BY id ROWS UNBOUNDED PRECEDING), " +
                "count(*) FILTER (WHERE v=10) OVER (ORDER BY id ROWS BETWEEN 1 PRECEDING AND 1 FOLLOWING) " +
                "FROM w ORDER BY id", "window FILTER")
    }

    @TestCase
    func runsAfterGroupingAndCanConsumeAnAggregate(): Unit {
        expectSameAsSqlite(WINDOW_SETUP,
            "SELECT g, sum(v) AS subtotal, sum(sum(v)) OVER (ORDER BY g), " +
                "rank() OVER (ORDER BY sum(v)) FROM w GROUP BY g ORDER BY g", "window functions after GROUP BY")
    }

    @TestCase
    func canAppearOnlyInTheFinalOrderBy(): Unit {
        expectSameAsSqlite(WINDOW_SETUP, "SELECT id,v FROM w ORDER BY row_number() OVER (ORDER BY v DESC,id), id",
            "window expression in final ORDER BY")
    }
}

@Test
class WindowErrorTest {
    @TestCase
    func rejectsDistinctWindowAggregates(): Unit {
        expectBothReject(WINDOW_SETUP, "SELECT sum(DISTINCT v) OVER (ORDER BY id) FROM w", "DISTINCT window aggregate")
    }

    @TestCase
    func rejectsWindowFunctionsWithoutOver(): Unit {
        expectBothReject(WINDOW_SETUP, "SELECT row_number() FROM w", "window function without OVER")
    }

    @TestCase
    func rejectsWindowFunctionsInWhere(): Unit {
        expectBothReject(WINDOW_SETUP, "SELECT id FROM w WHERE row_number() OVER (ORDER BY id)=1",
            "window function in WHERE")
    }

    @TestCase
    func rejectsInvalidOffsetsAndFrameShapes(): Unit {
        expectBothReject(WINDOW_SETUP, "SELECT ntile(0) OVER (ORDER BY id) FROM w", "zero ntile")
        expectBothReject(WINDOW_SETUP,
            "SELECT sum(v) OVER (ORDER BY id ROWS BETWEEN CURRENT ROW AND 1 PRECEDING) FROM w", "reversed frame")
        expectBothReject(WINDOW_SETUP,
            "SELECT sum(v) OVER (ORDER BY id,v RANGE BETWEEN 1 PRECEDING AND CURRENT ROW) FROM w",
            "offset RANGE with two order terms")
    }
}
