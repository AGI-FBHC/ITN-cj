package itn_desktop_core.pi_app

import std.collection.*
import stdx.encoding.json.*
import itn_desktop_core.store.Store
import itn_desktop_core.agent.DomainTool
import itn_desktop_core.agent.DomainToolRun
import itn_desktop_core.util.*

func taskToolResult(body: JsonObject, summary: String): DomainToolRun {
    let r = DomainToolRun()
    r.details = body
    r.summary = summary
    r.content = byteSafePrefix(body.toString(), 50000)
    return r
}

func taskTool(name: String, label: String, snippet: String, description: String, schema: String,
    risk: String, fn: (JsonObject) -> DomainToolRun): DomainTool {
    let t = DomainTool()
    t.name = name
    t.label = label
    t.snippet = snippet
    t.description = description
    t.schema = schema
    t.risk = risk
    t.run = fn
    return t
}

/** 桌面右上角任务中心的 Lumin 对等工具：同一份聚合状态，不另建任务真相。 */
public func taskTools(store: Store, sid: String, userText: String): ArrayList<DomainTool> {
    let out = ArrayList<DomainTool>()
    let feed = TaskFeed(store)
    out.add(taskTool("list_activity_tasks", "查看任务中心", "正在运行的对话、导图与桌面任务，以及最近结果",
        "读取桌面任务中心的同一份数据：running 是当前任务，recent 是最近完成/失败/取消/中断。id 可用于 cancel_activity_task；link 指向对应会话或页面。回答“现在在跑什么/刚才任务完成了吗”之前使用。",
        "{\"type\":\"object\",\"properties\":{}}", "read", { _: JsonObject =>
            taskToolResult(feed.list(), "已读取当前与最近任务")
        }))
    out.add(taskTool("cancel_activity_task", "停止任务", "按任务中心 id 停止对话、导图或演示任务",
        "仅在用户明确要求停止/取消某个已命名任务时调用。id 必须来自 list_activity_tasks；不要把当前正在执行本工具的会话作为目标，也不要猜测 id。导图取消后保留旧图，对话取消保留已有事件。",
        "{\"type\":\"object\",\"properties\":{\"id\":{\"type\":\"string\"}},\"required\":[\"id\"]}", "write", { args: JsonObject =>
            let id = strOf(args, "id")
            if (id.size == 0) { throw Exception("缺少任务 id") }
            if (id.startsWith("turn:" + sid + ":")) { throw Exception("不能从当前任务内部停止它自己；请由用户点击停止") }
            if (!userText.contains("停止") && !userText.contains("取消") && !userText.contains("终止")) {
                throw Exception("用户本轮没有要求停止任务")
            }
            let result = feed.cancel(id)
            result.put("id", JsonString(id))
            return taskToolResult(result, "已请求停止任务；对话与导图会保留已有成果")
        }))
    return out
}
