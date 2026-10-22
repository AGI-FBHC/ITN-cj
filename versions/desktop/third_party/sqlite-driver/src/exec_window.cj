package sqlite_driver

import std.collection.*

/*
 * 窗口函数执行。
 *
 * SELECT 已经是物化执行器，因此窗口层保存 FROM/GROUP BY 之后的逻辑行快照，按每个 OVER
 * 定义独立分区和排序，再把结果写回对应逻辑行。最终 ORDER BY 仍由 exec_order.cj 处理。
 */

/** 窗口层的一行。聚合结果属于该逻辑行，不能只保存 FROM 源值。 */
class SelectRowState {
    let snapshot: ArrayList<SourceSnapshot>
    let aggregateResults: Option<HashMap<Int64, SqliteValue>>

    init(snapshot: ArrayList<SourceSnapshot>, aggregateResults: Option<HashMap<Int64, SqliteValue>>) {
        this.snapshot = snapshot
        this.aggregateResults = aggregateResults
    }
}

private class WindowEntry {
    let stateIndex: Int64
    let state: SelectRowState
    let partitionKeys: Array<SqliteValue>
    let orderKeys: Array<SqliteValue>

    init(stateIndex: Int64, state: SelectRowState, partitionKeys: Array<SqliteValue>, orderKeys: Array<SqliteValue>) {
        this.stateIndex = stateIndex
        this.state = state
        this.partitionKeys = partitionKeys
        this.orderKeys = orderKeys
    }
}

func hasWindowExpressions(columns: ArrayList<ResultColumn>, orderBy: ArrayList<OrderTerm>): Bool {
    !collectWindowExpressions(columns, orderBy).isEmpty()
}

private func collectWindowExpressions(columns: ArrayList<ResultColumn>, orderBy: ArrayList<OrderTerm>): ArrayList<WindowExpr> {
    let out = ArrayList<WindowExpr>()
    let seen = HashSet<Int64>()
    for (column in columns) {
        collectWindowExpressionsIn(column.expr, out, seen)
    }
    for (term in orderBy) {
        collectWindowExpressionsIn(term.expr, out, seen)
    }
    out
}

private func collectWindowExpressionsIn(expr: Expr, out: ArrayList<WindowExpr>, seen: HashSet<Int64>): Unit {
    if (expr is WindowExpr) {
        let window = (expr as WindowExpr).getOrThrow()
        if (!seen.contains(window.serial)) {
            seen.add(window.serial)
            out.add(window)
        }
    }
    for (child in childExpressions(expr)) {
        collectWindowExpressionsIn(child, out, seen)
    }
}

private func expressionContainsWindow(expr: Expr): Bool {
    if (expr is WindowExpr) {
        return true
    }
    for (child in childExpressions(expr)) {
        if (expressionContainsWindow(child)) {
            return true
        }
    }
    false
}

private func restoreSelectRow(ctx: EvalContext, state: SelectRowState): Unit {
    restoreSources(ctx, state.snapshot)
    ctx.aggregateResults = state.aggregateResults
    ctx.windowResults = None
}

/** 无 GROUP BY 的窗口路径。 */
func runPlainSelectWithWindows(ctx: EvalContext, stmt: SelectStmt, columns: ArrayList<ResultColumn>): ArrayList<Array<SqliteValue>> {
    let states = ArrayList<SelectRowState>()
    iterateJoinedRows(ctx, stmt) {
        =>
            states.add(SelectRowState(snapshotSources(ctx), None))
            true
    }
    projectWindowRows(ctx, stmt, columns, states)
}

/** GROUP BY/聚合完成后再运行窗口层。 */
func runGroupedSelectWithWindows(ctx: EvalContext, stmt: SelectStmt, columns: ArrayList<ResultColumn>,
    aggregates: ArrayList<FuncExpr>): ArrayList<Array<SqliteValue>> {
    let buckets = ArrayList<GroupBucket>()
    let byKey = HashMap<String, Int64>()
    iterateJoinedRows(ctx, stmt) {
        =>
            let keyValues = Array<SqliteValue>(stmt.groupBy.size, repeat: SqliteValue.SNull)
            for (i in 0..stmt.groupBy.size) {
                keyValues[i] = evalExpr(ctx, stmt.groupBy[i])
            }
            let key = groupKeyString(keyValues)
            let index = match (byKey.get(key)) {
                case Some(existing) => existing
                case None =>
                    let bucket = GroupBucket(keyValues)
                    for (aggregate in aggregates) {
                        bucket.states[aggregateKeyOf(ctx, aggregate)] = AggregateState(aggregate.name.toAsciiLower(),
                            aggregate.distinct)
                    }
                    buckets.add(bucket)
                    byKey[key] = buckets.size - 1
                    buckets.size - 1
            }
            let bucket = buckets[index]
            bucket.snapshot = snapshotSources(ctx)
            accumulateInto(ctx, bucket, aggregates)
            true
    }
    if (buckets.isEmpty() && stmt.groupBy.isEmpty()) {
        let bucket = GroupBucket(Array<SqliteValue>())
        for (aggregate in aggregates) {
            bucket.states[aggregateKeyOf(ctx, aggregate)] = AggregateState(aggregate.name.toAsciiLower(),
                aggregate.distinct)
        }
        bucket.snapshot = snapshotSources(ctx)
        buckets.add(bucket)
    }

    let states = ArrayList<SelectRowState>()
    for (bucket in buckets) {
        restoreSources(ctx, bucket.snapshot)
        let results = HashMap<Int64, SqliteValue>()
        for ((key, state) in bucket.states) {
            results[key] = finalizeAggregate(state)
        }
        ctx.aggregateResults = Some(results)
        if (let Some(having) <- stmt.having) {
            match (valueToTristate(evalExpr(ctx, having))) {
                case Some(true) => ()
                case _ =>
                    ctx.aggregateResults = None
                    continue
            }
        }
        states.add(SelectRowState(snapshotSources(ctx), Some(results)))
        ctx.aggregateResults = None
    }
    projectWindowRows(ctx, stmt, columns, states)
}

private func projectWindowRows(ctx: EvalContext, stmt: SelectStmt, columns: ArrayList<ResultColumn>,
    states: ArrayList<SelectRowState>): ArrayList<Array<SqliteValue>> {
    let windows = collectWindowExpressions(columns, stmt.orderBy)
    let values = computeWindowValues(ctx, states, windows)
    let rows = ArrayList<Array<SqliteValue>>()
    for (i in 0..states.size) {
        restoreSelectRow(ctx, states[i])
        ctx.windowResults = Some(values[i])
        let row = Array<SqliteValue>(columns.size, repeat: SqliteValue.SNull)
        for (columnIndex in 0..columns.size) {
            row[columnIndex] = evalExpr(ctx, columns[columnIndex].expr)
        }
        rows.add(row)
    }
    ctx.aggregateResults = None
    ctx.windowResults = None
    rows
}

private func computeWindowValues(ctx: EvalContext, states: ArrayList<SelectRowState>, windows: ArrayList<WindowExpr>): ArrayList<HashMap<Int64,
    SqliteValue>> {
    let values = ArrayList<HashMap<Int64, SqliteValue>>()
    for (_ in 0..states.size) {
        values.add(HashMap<Int64, SqliteValue>())
    }
    for (window in windows) {
        validateWindow(window)
        computeOneWindow(ctx, states, window, values)
    }
    values
}

private func validateWindow(window: WindowExpr): Unit {
    let function = window.funcExpr
    let name = function.name.toAsciiLower()
    for (argument in function.args) {
        if (expressionContainsWindow(argument)) {
            throw SqliteRuntimeException("sql", "misuse of window function ${name}()")
        }
    }
    if (let Some(filter) <- window.filter) {
        if (expressionContainsWindow(filter)) {
            throw SqliteRuntimeException("sql", "misuse of window function ${name}()")
        }
        if (!isAggregateName(name, function.args.size)) {
            throw SqliteRuntimeException("sql", "FILTER may only be used with an aggregate window function")
        }
    }
    for (partition in window.spec.partitionBy) {
        if (expressionContainsWindow(partition)) {
            throw SqliteRuntimeException("sql", "misuse of window function ${name}()")
        }
    }
    for (term in window.spec.orderBy) {
        if (expressionContainsWindow(term.expr)) {
            throw SqliteRuntimeException("sql", "misuse of window function ${name}()")
        }
    }
    if (function.distinct) {
        throw SqliteRuntimeException("sql", "DISTINCT is not supported for window functions")
    }
    validateWindowArguments(function, name)
    validateFrameShape(window.spec)
}

private func validateWindowArguments(function: FuncExpr, name: String): Unit {
    if (function.starArg && name != "count") {
        throw SqliteRuntimeException("sql", "'*' may only be used with count()")
    }
    match (name) {
        case "row_number" | "rank" | "dense_rank" | "percent_rank" | "cume_dist" => requireWindowArgumentCount(function,
            0, 0)
        case "ntile" => requireWindowArgumentCount(function, 1, 1)
        case "lag" | "lead" => requireWindowArgumentCount(function, 1, 3)
        case "first_value" | "last_value" => requireWindowArgumentCount(function, 1, 1)
        case "nth_value" => requireWindowArgumentCount(function, 2, 2)
        case "count" =>
            if (!function.starArg) {
                requireWindowArgumentCount(function, 1, 1)
            }
        case "sum" | "total" | "avg" | "min" | "max" => requireWindowArgumentCount(function, 1, 1)
        case "group_concat" => requireWindowArgumentCount(function, 1, 2)
        case _ => throw SqliteRuntimeException("sql", "no such window function: ${function.name}")
    }
}

private func requireWindowArgumentCount(function: FuncExpr, min: Int64, max: Int64): Unit {
    let count = function.args.size
    if (count < min || count > max || function.starArg) {
        let expected = if (min == max) {
            "${min}"
        } else {
            "${min} to ${max}"
        }
        throw SqliteRuntimeException("sql",
            "wrong number of arguments to function ${function.name}(): expected ${expected}, got ${count}")
    }
}

private func validateFrameShape(spec: WindowSpec): Unit {
    let startCategory = windowBoundCategory(spec.frameStart.kind)
    let endCategory = windowBoundCategory(spec.frameEnd.kind)
    if (startCategory > endCategory) {
        throw SqliteRuntimeException("sql", "unsupported frame specification")
    }
    let hasOffset = windowBoundHasOffset(spec.frameStart.kind) || windowBoundHasOffset(spec.frameEnd.kind)
    match (spec.frameType) {
        case FrameRange =>
            if (hasOffset && spec.orderBy.size != 1) {
                throw SqliteRuntimeException("sql",
                    "RANGE with offset PRECEDING/FOLLOWING requires one ORDER BY expression")
            }
        case _ => ()
    }
}

private func windowBoundCategory(kind: WindowBoundType): Int64 {
    match (kind) {
        case BoundUnboundedPreceding => 0
        case BoundPreceding => 1
        case BoundCurrentRow => 2
        case BoundFollowing => 3
        case BoundUnboundedFollowing => 4
    }
}

private func windowBoundHasOffset(kind: WindowBoundType): Bool {
    match (kind) {
        case BoundPreceding | BoundFollowing => true
        case _ => false
    }
}

private func computeOneWindow(ctx: EvalContext, states: ArrayList<SelectRowState>, window: WindowExpr,
    values: ArrayList<HashMap<Int64, SqliteValue>>): Unit {
    if (states.isEmpty()) {
        return
    }
    restoreSelectRow(ctx, states[0])
    let partitionCollations = expressionCollations(ctx, window.spec.partitionBy)
    let orderCollations = orderCollationsFor(ctx, window.spec.orderBy)
    let entries = ArrayList<WindowEntry>()
    for (i in 0..states.size) {
        restoreSelectRow(ctx, states[i])
        let partitionKeys = Array<SqliteValue>(window.spec.partitionBy.size, repeat: SqliteValue.SNull)
        for (keyIndex in 0..window.spec.partitionBy.size) {
            partitionKeys[keyIndex] = evalExpr(ctx, window.spec.partitionBy[keyIndex])
        }
        let orderKeys = Array<SqliteValue>(window.spec.orderBy.size, repeat: SqliteValue.SNull)
        for (keyIndex in 0..window.spec.orderBy.size) {
            orderKeys[keyIndex] = evalExpr(ctx, window.spec.orderBy[keyIndex].expr)
        }
        entries.add(WindowEntry(i, states[i], partitionKeys, orderKeys))
    }

    let partitions = ArrayList<ArrayList<WindowEntry>>()
    for (entry in entries) {
        var found = -1
        for (i in 0..partitions.size) {
            if (sameWindowKeys(entry.partitionKeys, partitions[i][0].partitionKeys, partitionCollations)) {
                found = i
                break
            }
        }
        if (found < 0) {
            let partition = ArrayList<WindowEntry>()
            partition.add(entry)
            partitions.add(partition)
        } else {
            partitions[found].add(entry)
        }
    }

    for (partition in partitions) {
        let sorted = sortWindowPartition(partition, window.spec.orderBy, orderCollations)
        evaluateWindowPartition(ctx, window, sorted, orderCollations, values)
    }
}

private func expressionCollations(ctx: EvalContext, expressions: ArrayList<Expr>): Array<SqliteCollation> {
    let collations = Array<SqliteCollation>(expressions.size, repeat: SqliteCollation.CollBinary)
    for (i in 0..expressions.size) {
        collations[i] = expressionCollation(ctx, expressions[i])
    }
    collations
}

private func orderCollationsFor(ctx: EvalContext, terms: ArrayList<OrderTerm>): Array<SqliteCollation> {
    let collations = Array<SqliteCollation>(terms.size, repeat: SqliteCollation.CollBinary)
    for (i in 0..terms.size) {
        collations[i] = if (!terms[i].collation.isEmpty()) {
            collationByName(terms[i].collation)
        } else {
            expressionCollation(ctx, terms[i].expr)
        }
    }
    collations
}

private func expressionCollation(ctx: EvalContext, expression: Expr): SqliteCollation {
    if (let Some(collation) <- explicitCollation(expression)) {
        return collation
    }
    match (columnCollation(ctx, expression)) {
        case Some(collation) => collation
        case None => SqliteCollation.CollBinary
    }
}

private func sameWindowKeys(left: Array<SqliteValue>, right: Array<SqliteValue>, collations: Array<SqliteCollation>): Bool {
    if (left.size != right.size) {
        return false
    }
    for (i in 0..left.size) {
        let collation = if (i < collations.size) {
            collations[i]
        } else {
            SqliteCollation.CollBinary
        }
        if (compareValues(left[i], right[i], collation) != CMP_EQ) {
            return false
        }
    }
    true
}

private func sortWindowPartition(partition: ArrayList<WindowEntry>, terms: ArrayList<OrderTerm>,
    collations: Array<SqliteCollation>): ArrayList<WindowEntry> {
    if (terms.isEmpty()) {
        return partition
    }
    let keys = ArrayList<Array<SqliteValue>>()
    for (entry in partition) {
        keys.add(entry.orderKeys)
    }
    let indexes = sortedIndexes(keys, terms, collations)
    let sorted = ArrayList<WindowEntry>()
    for (index in indexes) {
        sorted.add(partition[index])
    }
    sorted
}

private func evaluateWindowPartition(ctx: EvalContext, window: WindowExpr, entries: ArrayList<WindowEntry>,
    orderCollations: Array<SqliteCollation>, values: ArrayList<HashMap<Int64, SqliteValue>>): Unit {
    let size = entries.size
    let peerStarts = Array<Int64>(size, repeat: 0)
    let peerEnds = Array<Int64>(size, repeat: 0)
    let groupNumbers = Array<Int64>(size, repeat: 0)
    var start = 0
    var group = 0
    while (start < size) {
        var end = start
        while (end + 1 < size && sameWindowKeys(entries[start].orderKeys, entries[end + 1].orderKeys, orderCollations)) {
            end += 1
        }
        for (i in start..(end + 1)) {
            peerStarts[i] = start
            peerEnds[i] = end
            groupNumbers[i] = group
        }
        group += 1
        start = end + 1
    }

    for (position in 0..size) {
        let value = evaluateWindowAt(ctx, window, entries, position, peerStarts, peerEnds, groupNumbers, group)
        values[entries[position].stateIndex][window.serial] = value
    }
}

private func evaluateWindowAt(ctx: EvalContext, window: WindowExpr, entries: ArrayList<WindowEntry>, position: Int64,
    peerStarts: Array<Int64>, peerEnds: Array<Int64>, groupNumbers: Array<Int64>, groupCount: Int64): SqliteValue {
    let name = window.funcExpr.name.toAsciiLower()
    match (name) {
        case "row_number" => return SqliteValue.SInt(position + 1)
        case "rank" => return SqliteValue.SInt(peerStarts[position] + 1)
        case "dense_rank" => return SqliteValue.SInt(groupNumbers[position] + 1)
        case "percent_rank" =>
            if (entries.size <= 1) {
                return SqliteValue.SReal(0.0)
            }
            return SqliteValue.SReal(Float64(peerStarts[position]) / Float64(entries.size - 1))
        case "cume_dist" => return SqliteValue.SReal(Float64(peerEnds[position] + 1) / Float64(entries.size))
        case "ntile" => return evaluateNtile(ctx, window, entries, position)
        case "lag" => return evaluateLagLead(ctx, window, entries, position, false)
        case "lead" => return evaluateLagLead(ctx, window, entries, position, true)
        case _ => ()
    }

    let (frameStart, frameEnd) = windowFrame(ctx, window.spec, entries, position, peerStarts, peerEnds, groupNumbers,
        groupCount)
    // EXCLUDE 会把连续帧变成可能不连续的位置集合，因此取值与聚合使用位置清单。排名函数和
    // lag/lead 不依赖窗口帧，已在前面直接返回。
    let framePositions = windowFramePositions(window.spec, frameStart, frameEnd, position, peerStarts, peerEnds)
    if (name == "first_value") {
        if (framePositions.isEmpty()) {
            return SqliteValue.SNull
        }
        return evaluateAtState(ctx, entries[framePositions[0]].state, window.funcExpr.args[0])
    }
    if (name == "last_value") {
        if (framePositions.isEmpty()) {
            return SqliteValue.SNull
        }
        return evaluateAtState(ctx, entries[framePositions[framePositions.size - 1]].state, window.funcExpr.args[0])
    }
    if (name == "nth_value") {
        restoreSelectRow(ctx, entries[position].state)
        let nth = positiveInteger(evalExpr(ctx, window.funcExpr.args[1]),
            "second argument to nth_value must be a positive integer")
        if (nth > framePositions.size) {
            return SqliteValue.SNull
        }
        return evaluateAtState(ctx, entries[framePositions[nth - 1]].state, window.funcExpr.args[0])
    }
    evaluateWindowAggregate(ctx, window, entries, framePositions)
}

/**
 * 帧内实际参与计算的行位置, 按帧顺序。
 *
 * peer 表示窗口 ORDER BY 值相等的一组行；没有 ORDER BY 时整个分区属于同一 peer 组。
 *   NoOthers   全留
 *   CurrentRow 去掉当前行
 *   Group      去掉当前行所在 peer 组的全部行；没有 ORDER BY 时会清空整个帧
 *   Ties       去掉同组其他行, 留下当前行
 */
private func windowFramePositions(spec: WindowSpec, frameStart: Int64, frameEnd: Int64, position: Int64,
    peerStarts: Array<Int64>, peerEnds: Array<Int64>): ArrayList<Int64> {
    let out = ArrayList<Int64>()
    if (frameStart > frameEnd) {
        return out
    }
    let peerFrom = peerStarts[position]
    let peerTo = peerEnds[position]
    for (i in frameStart..(frameEnd + 1)) {
        let excluded = match (spec.exclude) {
            case ExcludeNoOthers => false
            case ExcludeCurrentRow => i == position
            case ExcludeGroup => i >= peerFrom && i <= peerTo
            case ExcludeTies => i >= peerFrom && i <= peerTo && i != position
        }
        if (!excluded) {
            out.add(i)
        }
    }
    out
}

private func evaluateNtile(ctx: EvalContext, window: WindowExpr, entries: ArrayList<WindowEntry>, position: Int64): SqliteValue {
    restoreSelectRow(ctx, entries[position].state)
    let buckets = positiveInteger(evalExpr(ctx, window.funcExpr.args[0]), "argument of ntile must be a positive integer")
    let quotient = entries.size / buckets
    let remainder = entries.size % buckets
    if (quotient == 0) {
        return SqliteValue.SInt(position + 1)
    }
    let largerRows = (quotient + 1) * remainder
    let bucket = if (position < largerRows) {
        position / (quotient + 1) + 1
    } else {
        remainder + (position - largerRows) / quotient + 1
    }
    SqliteValue.SInt(bucket)
}

private func evaluateLagLead(ctx: EvalContext, window: WindowExpr, entries: ArrayList<WindowEntry>, position: Int64,
    lead: Bool): SqliteValue {
    restoreSelectRow(ctx, entries[position].state)
    var offset = 1
    if (window.funcExpr.args.size >= 2) {
        offset = nonNegativeInteger(evalExpr(ctx, window.funcExpr.args[1]),
            "offset of lag/lead must be a non-negative integer")
    }
    let target = if (lead) {
        position + offset
    } else {
        position - offset
    }
    if (target < 0 || target >= entries.size) {
        if (window.funcExpr.args.size >= 3) {
            restoreSelectRow(ctx, entries[position].state)
            return evalExpr(ctx, window.funcExpr.args[2])
        }
        return SqliteValue.SNull
    }
    evaluateAtState(ctx, entries[target].state, window.funcExpr.args[0])
}

private func evaluateAtState(ctx: EvalContext, state: SelectRowState, expression: Expr): SqliteValue {
    restoreSelectRow(ctx, state)
    evalExpr(ctx, expression)
}

private func evaluateWindowAggregate(ctx: EvalContext, window: WindowExpr, entries: ArrayList<WindowEntry>,
    positions: ArrayList<Int64>): SqliteValue {
    let function = window.funcExpr
    let state = AggregateState(function.name.toAsciiLower(), false)
    for (position in positions) {
        restoreSelectRow(ctx, entries[position].state)
        if (let Some(filter) <- window.filter) {
            match (valueToTristate(evalExpr(ctx, filter))) {
                case Some(true) => ()
                case _ => continue
            }
        }
        accumulateOne(ctx, state, function)
    }
    finalizeAggregate(state)
}

private func positiveInteger(value: SqliteValue, message: String): Int64 {
    let integer = exactInteger(value, message)
    if (integer <= 0) {
        throw SqliteRuntimeException("sql", message)
    }
    integer
}

private func nonNegativeInteger(value: SqliteValue, message: String): Int64 {
    let integer = exactInteger(value, message)
    if (integer < 0) {
        throw SqliteRuntimeException("sql", message)
    }
    integer
}

private func exactInteger(value: SqliteValue, message: String): Int64 {
    let numeric = numericWindowValue(value, message)
    match (numeric) {
        case SInt(integer) => integer
        case SReal(real) =>
            let integer = floatToInt(real)
            if (Float64(integer) != real) {
                throw SqliteRuntimeException("sql", message)
            }
            integer
        case _ => throw SqliteRuntimeException("sql", message)
    }
}

private func numericWindowValue(value: SqliteValue, message: String): SqliteValue {
    match (value) {
        case SInt(_) | SReal(_) => value
        case SText(text) => match (textToNumber(text)) {
            case Some(number) => number
            case None => throw SqliteRuntimeException("sql", message)
        }
        case _ => throw SqliteRuntimeException("sql", message)
    }
}

private func windowFrame(ctx: EvalContext, spec: WindowSpec, entries: ArrayList<WindowEntry>, position: Int64,
    peerStarts: Array<Int64>, peerEnds: Array<Int64>, groupNumbers: Array<Int64>, groupCount: Int64): (Int64, Int64) {
    match (spec.frameType) {
        case FrameRows => (rowsFrameBound(ctx, spec.frameStart, entries[position].state, position, entries.size, true),
            rowsFrameBound(ctx, spec.frameEnd, entries[position].state, position, entries.size, false))
        case FrameGroups =>
            let currentGroup = groupNumbers[position]
            let startGroup = groupsFrameBound(ctx, spec.frameStart, entries[position].state, currentGroup, groupCount,
                true)
            let endGroup = groupsFrameBound(ctx, spec.frameEnd, entries[position].state, currentGroup, groupCount, false)
            (firstPositionOfGroup(groupNumbers, startGroup), lastPositionOfGroup(groupNumbers, endGroup))
        case FrameRange => rangeFrame(ctx, spec, entries, position, peerStarts, peerEnds)
    }
}

private func rowsFrameBound(ctx: EvalContext, bound: WindowFrameBound, state: SelectRowState, position: Int64,
    size: Int64, isStart: Bool): Int64 {
    match (bound.kind) {
        case BoundUnboundedPreceding => 0
        case BoundUnboundedFollowing => size - 1
        case BoundCurrentRow => position
        case BoundPreceding =>
            let offset = frameIntegerOffset(ctx, bound, state)
            let candidate = position - offset
            if (candidate < 0) {
                0
            } else {
                candidate
            }
        case BoundFollowing =>
            let offset = frameIntegerOffset(ctx, bound, state)
            let candidate = position + offset
            if (candidate >= size) {
                if (isStart) {
                    size
                } else {
                    size - 1
                }
            } else {
                candidate
            }
    }
}

private func groupsFrameBound(ctx: EvalContext, bound: WindowFrameBound, state: SelectRowState, currentGroup: Int64,
    groupCount: Int64, isStart: Bool): Int64 {
    match (bound.kind) {
        case BoundUnboundedPreceding => 0
        case BoundUnboundedFollowing => groupCount - 1
        case BoundCurrentRow => currentGroup
        case BoundPreceding =>
            let offset = frameIntegerOffset(ctx, bound, state)
            let candidate = currentGroup - offset
            if (candidate < 0) {
                0
            } else {
                candidate
            }
        case BoundFollowing =>
            let offset = frameIntegerOffset(ctx, bound, state)
            let candidate = currentGroup + offset
            if (candidate >= groupCount) {
                if (isStart) {
                    groupCount
                } else {
                    groupCount - 1
                }
            } else {
                candidate
            }
    }
}

private func firstPositionOfGroup(groupNumbers: Array<Int64>, group: Int64): Int64 {
    if (group >= groupNumbers.size) {
        return groupNumbers.size
    }
    for (i in 0..groupNumbers.size) {
        if (groupNumbers[i] == group) {
            return i
        }
    }
    groupNumbers.size
}

private func lastPositionOfGroup(groupNumbers: Array<Int64>, group: Int64): Int64 {
    if (group < 0) {
        return -1
    }
    var i = groupNumbers.size - 1
    while (i >= 0) {
        if (groupNumbers[i] == group) {
            return i
        }
        i -= 1
    }
    -1
}

private func frameIntegerOffset(ctx: EvalContext, bound: WindowFrameBound, state: SelectRowState): Int64 {
    let expression = match (bound.offset) {
        case Some(offset) => offset
        case None => return 0
    }
    restoreSelectRow(ctx, state)
    nonNegativeInteger(evalExpr(ctx, expression), "frame offset must be a non-negative integer")
}

private func frameNumericOffset(ctx: EvalContext, bound: WindowFrameBound, state: SelectRowState): Float64 {
    let expression = match (bound.offset) {
        case Some(offset) => offset
        case None => return 0.0
    }
    restoreSelectRow(ctx, state)
    let value = numericWindowValue(evalExpr(ctx, expression), "frame offset must be a non-negative number")
    let number = valueToFloat(value)
    if (number < 0.0 || number.isNaN()) {
        throw SqliteRuntimeException("sql", "frame offset must be a non-negative number")
    }
    number
}

private func rangeFrame(ctx: EvalContext, spec: WindowSpec, entries: ArrayList<WindowEntry>, position: Int64,
    peerStarts: Array<Int64>, peerEnds: Array<Int64>): (Int64, Int64) {
    if (spec.orderBy.isEmpty()) {
        return (0, entries.size - 1)
    }
    let descending = spec.orderBy[0].desc
    let start = rangeFrameBound(ctx, spec.frameStart, entries, position, peerStarts, peerEnds, descending, true)
    let end = rangeFrameBound(ctx, spec.frameEnd, entries, position, peerStarts, peerEnds, descending, false)
    (start, end)
}

private func rangeFrameBound(ctx: EvalContext, bound: WindowFrameBound, entries: ArrayList<WindowEntry>,
    position: Int64, peerStarts: Array<Int64>, peerEnds: Array<Int64>, descending: Bool, isStart: Bool): Int64 {
    match (bound.kind) {
        case BoundUnboundedPreceding => return 0
        case BoundUnboundedFollowing => return entries.size - 1
        case BoundCurrentRow => return if (isStart) {
            peerStarts[position]
        } else {
            peerEnds[position]
        }
        case _ => ()
    }
    let current = entries[position].orderKeys[0]
    if (!isNumericValue(current)) {
        return if (isStart) {
            peerStarts[position]
        } else {
            peerEnds[position]
        }
    }
    let offset = frameNumericOffset(ctx, bound, entries[position].state)
    let preceding = match (bound.kind) {
        case BoundPreceding => true
        case _ => false
    }
    let currentNumber = valueToFloat(current)
    let threshold = if (!descending) {
        if (preceding) {
            currentNumber - offset
        } else {
            currentNumber + offset
        }
    } else {
        if (preceding) {
            currentNumber + offset
        } else {
            currentNumber - offset
        }
    }
    if (isStart) {
        for (i in 0..entries.size) {
            let candidate = entries[i].orderKeys[0]
            if (!isNumericValue(candidate)) {
                continue
            }
            let number = valueToFloat(candidate)
            if ((!descending && number >= threshold) || (descending && number <= threshold)) {
                return i
            }
        }
        return entries.size
    }
    var i = entries.size - 1
    while (i >= 0) {
        let candidate = entries[i].orderKeys[0]
        if (isNumericValue(candidate)) {
            let number = valueToFloat(candidate)
            if ((!descending && number <= threshold) || (descending && number >= threshold)) {
                return i
            }
        }
        i -= 1
    }
    -1
}
