package itn_desktop_core.agent

import std.collection.*
import std.random.*
import std.sync.*
import std.time.*
import stdx.encoding.json.*
import itn_desktop_core.course.CourseStore
import itn_desktop_core.knowledge.KnowledgeStore
import itn_desktop_core.learning.LearningStore
import itn_desktop_core.llm.LlmClient
import itn_desktop_core.resource.jsonObjectFromModel
import itn_desktop_core.store.ModelConfig
import itn_desktop_core.store.Store
import itn_desktop_core.tools.ToolRegistry
import itn_desktop_core.util.*

/*
 * 学习型多智能体协作树。
 *
 * 这一版刻意不开放任意 Agent 编排接口，只提供学习场景的高层工具：
 *   research_topic_team  多来源研究
 *   plan_study_team      个性化学习计划
 *
 * 工具负责给出角色和输出约束，模型负责规划树结构；仓颉负责：
 *   - 校验深度/节点数/并发数；
 *   - 并行执行叶子节点；
 *   - 按深度汇总内部节点；
 *   - 把每个节点的简化过程和最终回答写成 team 事件。
 */

class TeamNode {
    public var id: String = ""
    public var parentId: String = ""
    public var depth: Int64 = 0
    public var role: String = "学习助手"
    public var title: String = ""
    public var objective: String = ""
    public var status: String = "queued"
    public var ok: Bool = true
    public var process = ArrayList<String>()
    public var children = ArrayList<Int64>()
    public var answer: String = ""
    public var error: String = ""
    public var elapsedMs: Int64 = 0
}

class TeamTreeBuilder {
    let maxDepth: Int64
    let maxNodes: Int64
    public var nodes = ArrayList<TeamNode>()

    public init(maxDepth: Int64, maxNodes: Int64) {
        this.maxDepth = maxDepth
        this.maxNodes = maxNodes
    }

    public func build(root: JsonObject): ArrayList<TeamNode> {
        let rootTitle = trimStr(strOf(root, "title"))
        let rootObjective = trimStr(strOf(root, "objective"))
        addNode(root, "", 0, if (rootTitle.size > 0) { rootTitle } else { "学习任务" },
            if (rootObjective.size > 0) { rootObjective } else { "完成本次学习任务" })
        return nodes
    }

    private func addNode(raw: JsonObject, parentId: String, depth: Int64, fallbackTitle: String,
        fallbackObjective: String): Int64 {
        if (nodes.size >= maxNodes) {
            return -1
        }
        let node = TeamNode()
        node.id = "n" + (nodes.size + 1).toString()
        node.parentId = parentId
        node.depth = depth
        node.role = trimStr(strOf(raw, "role"))
        if (node.role.size == 0) {
            node.role = "学习助手"
        }
        node.title = trimStr(strOf(raw, "title"))
        if (node.title.size == 0) {
            node.title = fallbackTitle
        }
        node.objective = trimStr(strOf(raw, "objective"))
        if (node.objective.size == 0) {
            node.objective = fallbackObjective
        }
        let index = nodes.size
        nodes.add(node)
        if (depth >= maxDepth) {
            return index
        }
        match (raw.get("children")) {
            case Some(value) => match (arrOf(value)) {
                case Some(children) =>
                    var i = 0
                    while (i < children.size() && nodes.size < maxNodes) {
                        match (objOf(children[i])) {
                            case Some(child) =>
                                let childIndex = addNode(child, node.id, depth + 1,
                                    "子任务 " + (i + 1).toString(), "完成一个独立子任务")
                                if (childIndex >= 0) {
                                    nodes[index].children.add(childIndex)
                                }
                            case None => ()
                        }
                        i = i + 1
                    }
                case None => ()
            }
            case None => ()
        }
        return index
    }
}

class TeamNodeOutcome {
    public var ok: Bool = true
    public var answer: String = ""
    public var error: String = ""
    public var process = ArrayList<String>()
    public var elapsedMs: Int64 = 0
}

func teamPlanNode(role: String, title: String, objective: String, children: JsonArray): JsonObject {
    let node = JsonObject()
    node.put("role", JsonString(role))
    node.put("title", JsonString(title))
    node.put("objective", JsonString(objective))
    node.put("children", children)
    return node
}

func teamFallbackPlan(toolName: String, goal: String): JsonObject {
    let children = JsonArray()
    if (toolName == "plan_study_team") {
        children.add(teamPlanNode("学情分析员", "现状与差距", "分析已有基础、目标、时间与待补内容", JsonArray()))
        children.add(teamPlanNode("目标拆解员", "能力目标", "把学习目标拆成可检查的能力点", JsonArray()))
        children.add(teamPlanNode("计划设计员", "学习节奏", "安排每周任务、练习与复习节奏", JsonArray()))
        children.add(teamPlanNode("质量审查员", "验收与调整", "给出验收标准、风险和调整机制", JsonArray()))
    } else {
        children.add(teamPlanNode("概念研究员", "核心概念与定义", "梳理主题中的关键概念、术语和边界", JsonArray()))
        children.add(teamPlanNode("机制研究员", "原理、机制与流程", "解释关键机制、执行流程和因果关系", JsonArray()))
        children.add(teamPlanNode("实践研究员", "案例、工具与实践", "整理真实案例、常用工具和落地方式", JsonArray()))
        children.add(teamPlanNode("风险审查员", "误区与适用边界", "指出常见误区、风险和适用边界", JsonArray()))
    }
    return teamPlanNode("协作调度员", if (goal.size > 0) { goal } else { "学习任务" },
        "协调子任务并汇总最终结果", children)
}

func teamModel(store: Store): ModelConfig {
    let settings = store.load()
    if (settings.chatModelId.size > 0) {
        match (settings.findModel(settings.chatModelId)) {
            case Some(model) => return model
            case None => ()
        }
    }
    if (settings.models.size > 0) {
        return settings.models[0]
    }
    throw Exception("没有可用的对话模型，请先在设置中配置")
}

func teamPlanPrompt(toolName: String, goal: String, context: String, maxDepth: Int64, maxNodes: Int64): String {
    let kind = if (toolName == "plan_study_team") { "个性化学习计划" } else { "主题研究" }
    let sb = StringBuilder()
    sb.append("请为下面的学习任务设计一棵多智能体协作树。只输出一个 JSON 对象，不要 Markdown 围栏，不要解释。\n")
    sb.append("根节点结构必须是：{\"role\":\"协作调度员\",\"title\":\"任务名\",\"objective\":\"总目标\",\"children\":[...]}。\n")
    sb.append("每个节点必须包含 role、title、objective、children。children 为空数组表示叶子任务。\n")
    sb.append("最大深度为 ")
    sb.append(maxDepth.toString())
    sb.append("，总节点数不超过 ")
    sb.append(maxNodes.toString())
    sb.append("。只有存在相互独立、需要不同研究或审查视角的子任务时才继续展开。\n")
    sb.append("角色要具体，例如概念研究员、资料研究员、案例研究员、计划设计员、质量审查员；不要写泛化的“助手”。\n")
    sb.append("任务类型：")
    sb.append(kind)
    sb.append("\n学习目标：")
    sb.append(goal)
    sb.append("\n")
    if (context.size > 0) {
        sb.append("学习上下文（只作事实依据，不要照抄）：\n")
        sb.append(byteSafePrefix(context, 9000))
        sb.append("\n")
    }
    sb.append("现在直接输出完整 JSON。")
    return sb.toString()
}

func teamNodePayload(runId: String, node: TeamNode): JsonObject {
    let payload = JsonObject()
    payload.put("runId", JsonString(runId))
    payload.put("nodeId", JsonString(node.id))
    payload.put("parentId", JsonString(node.parentId))
    payload.put("depth", JsonInt(node.depth))
    payload.put("role", JsonString(node.role))
    payload.put("title", JsonString(node.title))
    payload.put("objective", JsonString(node.objective))
    payload.put("status", JsonString(node.status))
    return payload
}

func teamProcessJson(process: ArrayList<String>): JsonArray {
    let out = JsonArray()
    for (item in process) {
        out.add(JsonString(item))
    }
    return out
}

func teamAnswerJson(node: TeamNode): JsonObject {
    let o = JsonObject()
    o.put("id", JsonString(node.id))
    o.put("parentId", JsonString(node.parentId))
    o.put("depth", JsonInt(node.depth))
    o.put("role", JsonString(node.role))
    o.put("title", JsonString(node.title))
    o.put("objective", JsonString(node.objective))
    o.put("status", JsonString(node.status))
    o.put("process", teamProcessJson(node.process))
    o.put("answer", JsonString(node.answer))
    o.put("error", JsonString(node.error))
    o.put("elapsedMs", JsonInt(node.elapsedMs))
    return o
}

class LearningTeamRun {
    let store: Store
    let toolName: String
    let goal: String
    let kbId: String
    let sessionId: String
    let turnId: String
    let emit: (String, JsonObject) -> Unit
    let shouldAbort: () -> Bool
    let maxDepth: Int64
    let maxNodes: Int64
    let maxConcurrency: Int64
    let model: ModelConfig
    let runId: String
    let eventLock = Mutex()
    var nodes = ArrayList<TeamNode>()
    var learningContext: String = ""

    public init(store: Store, toolName: String, goal: String, kbId: String, sessionId: String,
        turnId: String, emit: (String, JsonObject) -> Unit, shouldAbort: () -> Bool,
        maxDepth: Int64, maxNodes: Int64, maxConcurrency: Int64, runtimeModel!: ?ModelConfig = None) {
        this.store = store
        this.toolName = toolName
        this.goal = goal
        this.kbId = kbId
        this.sessionId = sessionId
        this.turnId = turnId
        this.emit = emit
        this.shouldAbort = shouldAbort
        this.maxDepth = if (maxDepth > 0 && maxDepth < 5) { maxDepth } else { 3 }
        this.maxNodes = if (maxNodes > 3 && maxNodes < 13) { maxNodes } else { 9 }
        this.maxConcurrency = if (maxConcurrency > 0 && maxConcurrency < 5) { maxConcurrency } else { 3 }
        this.model = match (runtimeModel) { case Some(cfg) => cfg; case None => teamModel(store) }
        this.runId = "team-" + Random().nextUInt64().toString()
    }

    private func ensureActive(): Unit {
        if (shouldAbort()) {
            throw Exception("已取消")
        }
    }

    private func send(kind: String, payload: JsonObject): Unit {
        eventLock.lock()
        try {
            emit(kind, payload)
        } finally {
            eventLock.unlock()
        }
    }

    private func client(): LlmClient {
        let c = LlmClient(model)
        c.shouldAbort = shouldAbort
        return c
    }

    private func planTree(): JsonObject {
        ensureActive()
        let prompt = teamPlanPrompt(toolName, goal, learningContext, maxDepth, maxNodes)
        let system = "你是 ITN 学习型多智能体调度器。你的职责是规划树，不是回答问题。"
        let reply = client().chat(system, prompt)
        match (jsonObjectFromModel(reply)) {
            case Some(value) =>
                let builder = TeamTreeBuilder(maxDepth, maxNodes)
                let planned = builder.build(value)
                if (planned.size > 0) {
                    return value
                }
            case None => ()
        }
        return teamFallbackPlan(toolName, goal)
    }

    private func buildNodes(root: JsonObject): Unit {
        let builder = TeamTreeBuilder(maxDepth, maxNodes)
        nodes = builder.build(root)
        if (nodes.size == 0) {
            nodes = TeamTreeBuilder(maxDepth, maxNodes).build(teamFallbackPlan(toolName, goal))
        }
    }

    private func emitCreatedNodes(): Unit {
        var i = 0
        while (i < nodes.size) {
            let payload = teamNodePayload(runId, nodes[i])
            payload.put("event", JsonString("created"))
            send("team/node_created", payload)
            i = i + 1
        }
    }

    private func processStage(node: TeamNode, process: ArrayList<String>, stage: String, label: String): Unit {
        process.add(label)
        let payload = teamNodePayload(runId, node)
        payload.put("stage", JsonString(stage))
        payload.put("label", JsonString(label))
        payload.put("process", teamProcessJson(process))
        send("team/node_stage", payload)
    }

    private func runLeaf(index: Int64): TeamNodeOutcome {
        let node = nodes[index]
        let outcome = TeamNodeOutcome()
        let started = DateTime.now().toUnixTimeStamp().toMilliseconds()
        try {
            ensureActive()
            send("team/node_started", teamNodePayload(runId, node))
            processStage(node, outcome.process, "context", "读取学习上下文")
            processStage(node, outcome.process, "retrieve", "检索与任务相关的资料")
            let registry = ToolRegistry(store)
            registry.shouldAbort = shouldAbort
            let search = registry.kbSearch(kbId, node.title + " " + node.objective, 5)
            var evidence = ""
            if (search.ok) {
                evidence = byteSafePrefix(flattenForModel(search.data), 12000)
            } else {
                evidence = search.summary
            }
            processStage(node, outcome.process, "reason", "分析资料并形成节点结论")
            let rolePrompt = if (toolName == "plan_study_team") {
                "你是学习计划协作树中的“" + node.role + "”。只处理当前节点，输出具体、可执行、可检查的计划建议。"
            } else {
                "你是学习研究协作树中的“" + node.role + "”。只处理当前节点，输出清晰、准确、带资料依据的研究结论。"
            }
            let userPrompt = StringBuilder()
            userPrompt.append("总目标：")
            userPrompt.append(goal)
            userPrompt.append("\n节点角色：")
            userPrompt.append(node.role)
            userPrompt.append("\n节点标题：")
            userPrompt.append(node.title)
            userPrompt.append("\n节点任务：")
            userPrompt.append(node.objective)
            userPrompt.append("\n\n学习上下文：\n")
            userPrompt.append(byteSafePrefix(learningContext, 6000))
            userPrompt.append("\n\n检索到的资料：\n")
            userPrompt.append(evidence)
            userPrompt.append("\n\n请给出本节点的最终回答，使用 Markdown，300-800 字。引用资料时保留 [n] 编号。不要描述你的思考过程。")
            outcome.answer = client().chat(rolePrompt, userPrompt.toString())
            if (outcome.answer.size == 0) {
                throw Exception("模型返回空结果")
            }
            processStage(node, outcome.process, "done", "节点完成")
            outcome.ok = true
        } catch (e: Exception) {
            outcome.ok = false
            outcome.error = e.message
            processStage(node, outcome.process, "error", "节点失败")
        }
        outcome.elapsedMs = DateTime.now().toUnixTimeStamp().toMilliseconds() - started
        return outcome
    }

    private func runAggregate(index: Int64): TeamNodeOutcome {
        let node = nodes[index]
        let outcome = TeamNodeOutcome()
        let started = DateTime.now().toUnixTimeStamp().toMilliseconds()
        try {
            ensureActive()
            send("team/node_started", teamNodePayload(runId, node))
            processStage(node, outcome.process, "collect", "收集子节点结果")
            let material = StringBuilder()
            var i = 0
            while (i < node.children.size) {
                let child = nodes[node.children[i]]
                material.append("## ")
                material.append(child.title)
                material.append("\n角色：")
                material.append(child.role)
                material.append("\n结果：")
                material.append(if (child.ok) { child.answer } else { "子任务失败：" + child.error })
                material.append("\n\n")
                i = i + 1
            }
            processStage(node, outcome.process, "aggregate", "汇总并形成阶段性结论")
            let system = "你是学习协作树的汇总节点。综合子节点结果，保留资料引用，指出分歧和风险，输出最终 Markdown。"
            let user = "总目标：" + goal + "\n节点任务：" + node.objective + "\n\n子节点结果：\n" +
                byteSafePrefix(material.toString(), 24000) +
                "\n\n请输出本节点的最终回答，300-1000 字，不要描述思考过程。"
            outcome.answer = client().chat(system, user)
            if (outcome.answer.size == 0) {
                throw Exception("模型返回空结果")
            }
            processStage(node, outcome.process, "done", "汇总完成")
            outcome.ok = true
        } catch (e: Exception) {
            outcome.ok = false
            outcome.error = e.message
            processStage(node, outcome.process, "error", "汇总失败")
        }
        outcome.elapsedMs = DateTime.now().toUnixTimeStamp().toMilliseconds() - started
        return outcome
    }

    private func applyOutcome(index: Int64, outcome: TeamNodeOutcome): Unit {
        let node = nodes[index]
        node.answer = outcome.answer
        node.error = outcome.error
        node.process = outcome.process
        node.elapsedMs = outcome.elapsedMs
        node.status = if (outcome.ok) { "completed" } else { "failed" }
        node.ok = outcome.ok
        let payload = teamNodePayload(runId, node)
        payload.put("process", teamProcessJson(node.process))
        payload.put("answer", JsonString(node.answer))
        payload.put("error", JsonString(node.error))
        payload.put("elapsedMs", JsonInt(node.elapsedMs))
        if (outcome.ok) {
            send("team/node_completed", payload)
        } else {
            send("team/node_failed", payload)
        }
    }

    private func executeLeaves(): Unit {
        let leafIndices = ArrayList<Int64>()
        var i = 0
        while (i < nodes.size) {
            if (nodes[i].children.size == 0) {
                leafIndices.add(i)
            }
            i = i + 1
        }
        var start = 0
        while (start < leafIndices.size) {
            ensureActive()
            let futures = ArrayList<Future<TeamNodeOutcome>>()
            var count = 0
            while (count < maxConcurrency && start + count < leafIndices.size) {
                let index = leafIndices[start + count]
                futures.add(spawn { runLeaf(index) })
                count = count + 1
            }
            var j = 0
            while (j < futures.size) {
                applyOutcome(leafIndices[start + j], futures[j].get())
                j = j + 1
            }
            start = start + count
        }
    }

    private func executeParents(): Unit {
        var depth = maxDepth
        while (depth >= 0) {
            var i = 0
            while (i < nodes.size) {
                if (nodes[i].depth == depth && nodes[i].children.size > 0) {
                    ensureActive()
                    let outcome = runAggregate(i)
                    applyOutcome(i, outcome)
                }
                i = i + 1
            }
            depth = depth - 1
        }
    }

    private func treeJson(): JsonArray {
        let out = JsonArray()
        for (node in nodes) {
            out.add(teamAnswerJson(node))
        }
        return out
    }

    public func run(): DomainToolRun {
        let result = DomainToolRun()
        let started = DateTime.now().toUnixTimeStamp().toMilliseconds()
        try {
            ensureActive()
            let ls = LearningStore(store.dataDir)
            let context = JsonObject()
            context.put("learning", ls.context(kbId))
            context.put("courseTarget", CourseStore(store.dataDir).target(sessionId))
            context.put("knowledge", KnowledgeStore(store.dataDir).overview(8))
            learningContext = context.toString()
            let runPayload = JsonObject()
            runPayload.put("runId", JsonString(runId))
            runPayload.put("tool", JsonString(toolName))
            runPayload.put("goal", JsonString(goal))
            runPayload.put("maxDepth", JsonInt(maxDepth))
            runPayload.put("maxNodes", JsonInt(maxNodes))
            runPayload.put("maxConcurrency", JsonInt(maxConcurrency))
            send("team/run_started", runPayload)
            buildNodes(planTree())
            emitCreatedNodes()
            executeLeaves()
            executeParents()
            ensureActive()
            let root = nodes[0]
            let finished = DateTime.now().toUnixTimeStamp().toMilliseconds() - started
            let complete = JsonObject()
            complete.put("runId", JsonString(runId))
            complete.put("status", JsonString(if (root.status == "completed") { "completed" } else { "failed" }))
            complete.put("answer", JsonString(root.answer))
            complete.put("error", JsonString(root.error))
            complete.put("nodeCount", JsonInt(nodes.size))
            complete.put("elapsedMs", JsonInt(finished))
            send("team/run_completed", complete)
            result.ok = root.status == "completed"
            result.summary = "协作树完成：" + nodes.size.toString() + " 个节点"
            result.content = root.answer
            let details = JsonObject()
            details.put("runId", JsonString(runId))
            details.put("tool", JsonString(toolName))
            details.put("goal", JsonString(goal))
            details.put("tree", treeJson())
            details.put("answer", JsonString(root.answer))
            details.put("elapsedMs", JsonInt(finished))
            result.details = details
            return result
        } catch (e: Exception) {
            result.ok = false
            result.summary = e.message
            result.content = e.message
            let failed = JsonObject()
            failed.put("runId", JsonString(runId))
            failed.put("status", JsonString("failed"))
            failed.put("error", JsonString(e.message))
            send("team/run_completed", failed)
            return result
        }
    }
}

func learningTeamTool(store: Store, toolName: String, kbId: String, sessionId: String, turnId: String,
    userText: String, emit: (String, JsonObject) -> Unit, shouldAbort: () -> Bool,
    args: JsonObject, runtimeModel!: ?ModelConfig = None): DomainToolRun {
    var goal = trimStr(strOf(args, "goal"))
    if (goal.size == 0) {
        goal = trimStr(strOf(args, "topic"))
    }
    if (goal.size == 0) {
        goal = trimStr(userText)
    }
    if (goal.size == 0) {
        let r = DomainToolRun()
        r.ok = false
        r.summary = "缺少学习目标"
        r.content = r.summary
        return r
    }
    let run = LearningTeamRun(store, toolName, goal, kbId, sessionId, turnId, emit, shouldAbort,
        intOf(args, "max_depth"), intOf(args, "max_nodes"), intOf(args, "max_concurrency"), runtimeModel: runtimeModel)
    return run.run()
}

public func learningTeamTools(store: Store, kbId: String, shouldAbort: () -> Bool, sid: String,
    turnId: String, userText: String, emit: (String, JsonObject) -> Unit, runtimeModel!: ?ModelConfig = None): ArrayList<DomainTool> {
    let out = ArrayList<DomainTool>()
    out.add(makeTool("research_topic_team", "主题研究小组", "用多级智能体协作树完成主题研究",
        "当用户需要多角度研究、概念对比、资料综述或需要多个独立视角时使用。工具会规划多级协作树，并行研究并由汇总节点形成最终回答；右侧会自动打开协作树。简单的一问一答不要调用。",
        "{\"type\":\"object\",\"properties\":{\"goal\":{\"type\":\"string\",\"description\":\"要研究的主题或问题\"},\"max_depth\":{\"type\":\"integer\",\"description\":\"最大树深度，默认3\"},\"max_nodes\":{\"type\":\"integer\",\"description\":\"最大节点数，默认9\"},\"max_concurrency\":{\"type\":\"integer\",\"description\":\"最大并行节点数，默认3\"}},\"required\":[\"goal\"]}",
        "read",
        { args: JsonObject => learningTeamTool(store, "research_topic_team", kbId, sid, turnId, userText,
            emit, shouldAbort, args, runtimeModel: runtimeModel) }))
    out.add(makeTool("plan_study_team", "学习计划小组", "用多级智能体协作树制定学习计划",
        "当用户需要根据学习目标、基础、时间或测验记录制定多阶段学习计划时使用。工具会规划多级协作树，由学情、目标、计划和审查节点协作；右侧会自动打开协作树。简单时间换算不要调用。",
        "{\"type\":\"object\",\"properties\":{\"goal\":{\"type\":\"string\",\"description\":\"学习目标或计划要求\"},\"max_depth\":{\"type\":\"integer\",\"description\":\"最大树深度，默认3\"},\"max_nodes\":{\"type\":\"integer\",\"description\":\"最大节点数，默认9\"},\"max_concurrency\":{\"type\":\"integer\",\"description\":\"最大并行节点数，默认3\"}},\"required\":[\"goal\"]}",
        "read",
        { args: JsonObject => learningTeamTool(store, "plan_study_team", kbId, sid, turnId, userText,
            emit, shouldAbort, args, runtimeModel: runtimeModel) }))
    return out
}
