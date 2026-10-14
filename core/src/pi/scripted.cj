package itn_desktop_core.pi

import std.collection.*
import stdx.encoding.json.*

/*
 * 脚本化提供方：按事先写好的脚本"播放"一次模型请求，用来离线演示与跑测试。
 * 它把 message_update 事件照 Pi 的名字推出去（text_delta / thinking_delta / toolcall_delta），
 * 所以主循环与界面代码在"真模型"和"脚本模型"下走的是同一条路。
 */

public class ScriptStep {
    public var text: String = ""
    public var thinking: String = ""
    public var toolName: String = ""
    public var toolArgs: String = "{}"
    public var callId: String = ""
    public var reasoningFirst: Bool = true
    /** 不为空表示这一步直接失败（测错误路径） */
    public var failWith: String = ""
    public var stopReason: String = ""

    public init(text: String) {
        this.text = text
    }
}

public func scriptText(text: String): ScriptStep {
    return ScriptStep(text)
}

public func scriptTool(name: String, argsJson: String): ScriptStep {
    let s = ScriptStep("")
    s.toolName = name
    s.toolArgs = argsJson
    return s
}

public class ScriptedProvider <: ChatProvider {
    private var steps = ArrayList<ScriptStep>()
    private var cursor: Int64 = 0
    /** 诊断用：每次请求看到的系统提示词 / 工具数 / 消息数 */
    public let seenSystems = ArrayList<String>()
    public let seenToolCounts = ArrayList<Int64>()
    public let seenMessageCounts = ArrayList<Int64>()
    public var chunkBytes: Int64 = 24

    public init(steps: Array<ScriptStep>) {
        for (s in steps) {
            this.steps.add(s)
        }
    }

    public func remaining(): Int64 {
        return steps.size - cursor
    }

    public func respond(ctx: StepContext, stream: EventStream): ModelReply {
        seenSystems.add(ctx.system)
        seenToolCounts.add(ctx.tools.size)
        seenMessageCounts.add(ctx.messages.size)
        let reply = ModelReply()
        if (cursor >= steps.size) {
            reply.stopReason = "stop"
            return reply
        }
        let s = steps[cursor]
        cursor = cursor + 1
        if (s.failWith.size > 0) {
            reply.stopReason = "error"
            reply.errorMessage = s.failWith
            return reply
        }
        if (s.thinking.size > 0) {
            emitChunks(stream, ctx, deltaThinkingDelta(), s.thinking)
            reply.thinking = s.thinking
        }
        if (s.toolName.size > 0) {
            let cid = if (s.callId.size > 0) { s.callId } else { "call_" + hex8(cursor * 7919) }
            let tc = ToolCallBlock(cid, s.toolName, s.toolArgs)
            reply.toolCalls.add(tc)
            reply.stopReason = "toolUse"
            // toolcall_start -> toolcall_delta（半截 JSON） -> message_end 由主循环统一发
            let partial = Message(AssistantMsg)
            stream.push(evMessageUpdate(deltaToolCallStart(), "", partial))
            var i: Int64 = 0
            let b = s.toolArgs.toArray()
            while (i < b.size) {
                var j = i + chunkBytes
                if (j > b.size) {
                    j = b.size
                }
                while (j < b.size && (b[j] & 192) == 128) {
                    j = j + 1
                }
                let piece = String.fromUtf8(b[i..j])
                partial.text = partial.text + piece
                stream.push(evMessageUpdate(deltaToolCallDelta(), piece, partial))
                i = j
            }
            return reply
        }
        if (s.text.size > 0) {
            emitChunks(stream, ctx, deltaTextDelta(), s.text)
            reply.text = s.text
        }
        reply.stopReason = if (s.stopReason.size > 0) { s.stopReason } else { "stop" }
        return reply
    }

    private func emitChunks(stream: EventStream, ctx: StepContext, deltaType: String, text: String): Unit {
        let partial = Message(AssistantMsg)
        let b = text.toArray()
        var i: Int64 = 0
        while (i < b.size) {
            var j = i + chunkBytes
            if (j > b.size) {
                j = b.size
            }
            while (j < b.size && (b[j] & 192) == 128) {
                j = j + 1
            }
            let piece = String.fromUtf8(b[i..j])
            partial.text = partial.text + piece
            stream.push(evMessageUpdate(deltaType, piece, partial))
            i = j
        }
    }
}
