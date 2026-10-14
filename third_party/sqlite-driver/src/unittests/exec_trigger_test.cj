package sqlite_driver.unittests

import sqlite_driver.*
import std.unittest.*
import std.unittest.testmacro.*

@Test
class TriggerTimingAndRowsTest {
    @TestCase
    func beforeAndAfterObserveDifferentTableStates(): Unit {
        expectSameAsSqlite(
            [
                "CREATE TABLE t(id INT)",
                "CREATE TABLE audit(stage TEXT, n INT)",
                "CREATE TRIGGER before_i BEFORE INSERT ON t BEGIN " +
                    "INSERT INTO audit SELECT 'before', count(*) FROM t; END",
                "CREATE TRIGGER after_i AFTER INSERT ON t BEGIN " +
                    "INSERT INTO audit SELECT 'after', count(*) FROM t; END",
                "INSERT INTO t VALUES (1)"
            ],
            "SELECT stage, n FROM audit ORDER BY n, stage",
            "BEFORE runs before the row is visible and AFTER runs after it"
        )
    }

    @TestCase
    func omittedTimingUsesSqlitesDefault(): Unit {
        expectSameAsSqlite(
            [
                "CREATE TABLE t(id INT)",
                "CREATE TABLE audit(n INT)",
                "CREATE TRIGGER default_i INSERT ON t BEGIN " + "INSERT INTO audit SELECT count(*) FROM t; END",
                "INSERT INTO t VALUES (1)"
            ],
            "SELECT n FROM audit",
            "default trigger timing"
        )
    }

    @TestCase
    func updateExposesOldAndNewRows(): Unit {
        expectSameAsSqlite(
            [
                "CREATE TABLE t(id INTEGER PRIMARY KEY, v TEXT)",
                "CREATE TABLE audit(old_id INT, old_v TEXT, new_id INT, new_v TEXT)",
                "INSERT INTO t VALUES (1,'a')",
                "CREATE TRIGGER log_u AFTER UPDATE ON t BEGIN " +
                    "INSERT INTO audit VALUES (OLD.id, OLD.v, NEW.id, NEW.v); END",
                "UPDATE t SET id=2, v='b' WHERE id=1"
            ],
            "SELECT * FROM audit",
            "OLD and NEW on UPDATE"
        )
    }

    @TestCase
    func deleteExposesTheOldRow(): Unit {
        expectSameAsSqlite(
            [
                "CREATE TABLE t(id INT, v TEXT)",
                "CREATE TABLE audit(id INT, v TEXT)",
                "INSERT INTO t VALUES (1,'gone')",
                "CREATE TRIGGER log_d AFTER DELETE ON t BEGIN " + "INSERT INTO audit VALUES (OLD.id, OLD.v); END",
                "DELETE FROM t WHERE id=1"
            ],
            "SELECT * FROM audit",
            "OLD on DELETE"
        )
    }

    @TestCase
    func beforeUpdateChangesToTheSameRowArePreserved(): Unit {
        expectSameAsSqlite(
            [
                "CREATE TABLE t(id INTEGER PRIMARY KEY, v TEXT, touched INT DEFAULT 0)",
                "INSERT INTO t VALUES (1,'a',0)",
                "CREATE TRIGGER touch BEFORE UPDATE OF v ON t BEGIN " +
                    "UPDATE t SET touched=touched+1 WHERE id=OLD.id; END",
                "UPDATE t SET v='b' WHERE id=1"
            ],
            "SELECT id, v, touched FROM t",
            "BEFORE UPDATE changes survive the main update"
        )
    }

    @TestCase
    func updateOfFiltersByTheSetColumnList(): Unit {
        expectSameAsSqlite(
            [
                "CREATE TABLE t(id INT, a INT, b INT)",
                "CREATE TABLE audit(n INT)",
                "INSERT INTO t VALUES (1,10,20)",
                "CREATE TRIGGER only_a AFTER UPDATE OF a ON t BEGIN INSERT INTO audit VALUES (NEW.a); END",
                "UPDATE t SET b=21 WHERE id=1",
                "UPDATE t SET a=11 WHERE id=1"
            ],
            "SELECT * FROM audit",
            "UPDATE OF trigger filtering"
        )
    }

    @TestCase
    func whenFiltersIndividualRows(): Unit {
        expectSameAsSqlite(
            [
                "CREATE TABLE t(id INT, v INT)",
                "CREATE TABLE audit(id INT)",
                "CREATE TRIGGER positive AFTER INSERT ON t WHEN NEW.v > 0 BEGIN " +
                    "INSERT INTO audit VALUES (NEW.id); END",
                "INSERT INTO t VALUES (1,-1),(2,0),(3,1),(4,2)"
            ],
            "SELECT id FROM audit ORDER BY id",
            "trigger WHEN condition"
        )
    }

    @TestCase
    func bodyStatementsRunInOrder(): Unit {
        expectSameAsSqlite(
            [
                "CREATE TABLE t(id INT)",
                "CREATE TABLE audit(seq INT, note TEXT)",
                "CREATE TRIGGER multi AFTER INSERT ON t BEGIN " + "INSERT INTO audit VALUES (1,'first'); " +
                    "INSERT INTO audit SELECT 2, note || '-second' FROM audit WHERE seq=1; END",
                "INSERT INTO t VALUES (9)"
            ],
            "SELECT * FROM audit ORDER BY seq",
            "multi-statement trigger body"
        )
    }
}

@Test
class TriggerRecursionTest {
    @TestCase
    func recursiveTriggersOffStopsSelfReentry(): Unit {
        expectSameAsSqlite(
            [
                "PRAGMA recursive_triggers=OFF",
                "CREATE TABLE t(id INT)",
                "CREATE TRIGGER grow AFTER INSERT ON t WHEN NEW.id < 3 BEGIN " + "INSERT INTO t VALUES (NEW.id + 1); END",
                "INSERT INTO t VALUES (1)"
            ],
            "SELECT id FROM t ORDER BY id",
            "recursive_triggers OFF"
        )
    }

    @TestCase
    func recursiveTriggersOnAllowsSelfReentry(): Unit {
        expectSameAsSqlite(
            [
                "PRAGMA recursive_triggers=ON",
                "CREATE TABLE t(id INT)",
                "CREATE TRIGGER grow AFTER INSERT ON t WHEN NEW.id < 3 BEGIN " + "INSERT INTO t VALUES (NEW.id + 1); END",
                "INSERT INTO t VALUES (1)"
            ],
            "SELECT id FROM t ORDER BY id",
            "recursive_triggers ON"
        )
    }

    @TestCase
    func pragmaReportsTheConfiguredValue(): Unit {
        expectSameAsSqlite(["PRAGMA recursive_triggers=ON"], "PRAGMA recursive_triggers", "recursive_triggers pragma")
    }
}

@Test
class TriggerRaiseTest {
    @TestCase
    func raiseIgnoreSkipsOnlyTheCurrentRow(): Unit {
        expectSameAsSqlite(
            [
                "CREATE TABLE t(id INT)",
                "CREATE TRIGGER skip_two BEFORE INSERT ON t WHEN NEW.id=2 BEGIN SELECT RAISE(IGNORE); END",
                "INSERT INTO t VALUES (1),(2),(3)"
            ],
            "SELECT id FROM t ORDER BY id",
            "RAISE(IGNORE)"
        )
    }

    @TestCase
    func raiseAbortRejectsTheStatement(): Unit {
        expectBothReject(
            [
                "CREATE TABLE t(id INT)",
                "CREATE TRIGGER stop BEFORE INSERT ON t WHEN NEW.id=2 BEGIN " + "SELECT RAISE(ABORT,'blocked'); END"
            ],
            "INSERT INTO t VALUES (1),(2),(3)",
            "RAISE(ABORT)"
        )
    }

    @TestCase
    func raiseFailRejectsTheStatement(): Unit {
        expectBothReject(
            [
                "CREATE TABLE t(id INT)",
                "CREATE TRIGGER stop BEFORE INSERT ON t WHEN NEW.id=2 BEGIN " + "SELECT RAISE(FAIL,'blocked'); END"
            ],
            "INSERT INTO t VALUES (1),(2),(3)",
            "RAISE(FAIL)"
        )
    }

    @TestCase
    func raiseRollbackRejectsTheStatement(): Unit {
        expectBothReject(
            [
                "CREATE TABLE t(id INT)",
                "CREATE TRIGGER stop BEFORE INSERT ON t BEGIN SELECT RAISE(ROLLBACK,'blocked'); END"
            ],
            "INSERT INTO t VALUES (1)",
            "RAISE(ROLLBACK)"
        )
    }
}

@Test
class InsteadOfTriggerTest {
    @TestCase
    func anInsteadOfInsertMakesAViewWritable(): Unit {
        expectSameAsSqlite(
            [
                "CREATE TABLE base(id INT, v TEXT)",
                "CREATE VIEW v AS SELECT id, v FROM base",
                "CREATE TRIGGER v_i INSTEAD OF INSERT ON v BEGIN " +
                    "INSERT INTO base VALUES (NEW.id, NEW.v || '-stored'); END",
                "INSERT INTO v VALUES (1,'x'),(2,'y')"
            ],
            "SELECT * FROM base ORDER BY id",
            "INSTEAD OF INSERT"
        )
    }

    @TestCase
    func anInsteadOfUpdateReceivesOldAndNew(): Unit {
        expectSameAsSqlite(
            [
                "CREATE TABLE base(id INT, v TEXT)",
                "INSERT INTO base VALUES (1,'a'),(2,'b')",
                "CREATE VIEW v AS SELECT id, v FROM base",
                "CREATE TRIGGER v_u INSTEAD OF UPDATE ON v BEGIN " +
                    "UPDATE base SET id=NEW.id, v=OLD.v || ':' || NEW.v WHERE id=OLD.id; END",
                "UPDATE v SET id=id+10, v='changed' WHERE id=2"
            ],
            "SELECT * FROM base ORDER BY id",
            "INSTEAD OF UPDATE"
        )
    }

    @TestCase
    func anInsteadOfDeleteReceivesOld(): Unit {
        expectSameAsSqlite(
            [
                "CREATE TABLE base(id INT, v TEXT)",
                "INSERT INTO base VALUES (1,'a'),(2,'b')",
                "CREATE VIEW v AS SELECT id, v FROM base",
                "CREATE TRIGGER v_d INSTEAD OF DELETE ON v BEGIN " + "DELETE FROM base WHERE id=OLD.id; END",
                "DELETE FROM v WHERE id=1"
            ],
            "SELECT * FROM base ORDER BY id",
            "INSTEAD OF DELETE"
        )
    }
}

@Test
class TriggerDdlTest {
    @TestCase
    func sqliteSchemaStoresTriggersWithRootPageZero(): Unit {
        expectSameAsSqlite(
            [
                "CREATE TABLE t(id INT)",
                "CREATE TRIGGER tr AFTER INSERT ON t BEGIN SELECT NEW.id; END"
            ],
            "SELECT type, name, tbl_name, rootpage FROM sqlite_schema WHERE name='tr'",
            "trigger schema row"
        )
    }

    @TestCase
    func dropTriggerStopsFutureFirings(): Unit {
        expectSameAsSqlite(
            [
                "CREATE TABLE t(id INT)",
                "CREATE TABLE audit(id INT)",
                "CREATE TRIGGER tr AFTER INSERT ON t BEGIN INSERT INTO audit VALUES (NEW.id); END",
                "INSERT INTO t VALUES (1)",
                "DROP TRIGGER tr",
                "INSERT INTO t VALUES (2)"
            ],
            "SELECT * FROM audit",
            "DROP TRIGGER"
        )
    }

    @TestCase
    func insteadOfIsRejectedOnATable(): Unit {
        expectBothReject(["CREATE TABLE t(id INT)"], "CREATE TRIGGER bad INSTEAD OF INSERT ON t BEGIN SELECT 1; END",
            "INSTEAD OF trigger on a table")
    }

    @TestCase
    func beforeIsRejectedOnAView(): Unit {
        expectBothReject(
            [
                "CREATE TABLE t(id INT)",
                "CREATE VIEW v AS SELECT id FROM t"
            ],
            "CREATE TRIGGER bad BEFORE INSERT ON v BEGIN SELECT 1; END",
            "BEFORE trigger on a view"
        )
    }
}
