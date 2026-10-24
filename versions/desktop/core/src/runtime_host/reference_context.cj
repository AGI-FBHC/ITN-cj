package itn_desktop_core.runtime_host

import std.collection.*
import std.sync.*
import stdx.encoding.json.*
import itn_desktop_core.agent.DomainTool
import itn_desktop_core.agent.DomainToolRun
import itn_desktop_core.util.*
import itn_desktop_core.kb.stamp

/** The numbers shown to the model and the renderer share one per-turn source registry. */
public class TurnReferenceIndex {
    private let lock = Mutex()
    private let local = ArrayList<JsonObject>()
    private let web = ArrayList<JsonObject>()
    private let localIds = HashMap<String, Int64>()
    private let webIds = HashMap<String, Int64>()

    public init() {}

    public func attach(definitions: ArrayList<DomainTool>): Unit {
        for (tool in definitions) {
            if (!["kb_search", "read_chunk", "resolve_knowledge_reference", "web_search", "web_fetch"].contains(tool.name)) { continue }
            let original = tool.run
            let name = tool.name
            tool.run = { args: JsonObject => annotate(name, original(args)) }
        }
    }

    public func annotate(name: String, result: DomainToolRun): DomainToolRun {
        if (!result.ok) { return result }
        let isWeb = name == "web_search" || name == "web_fetch"
        let entries = ArrayList<JsonObject>()
        match (result.details) {
            case values: JsonArray => for (i in 0..values.size()) { match (objOf(values[i])) { case Some(value) => entries.add(value); case None => () } }
            case value: JsonObject => entries.add(value)
            case _ => return result
        }
        let text = StringBuilder(); text.append(result.summary)
        synchronized(lock) {
            for (entry in entries) {
                if (isWeb && strOf(entry, "fetchedAt").size == 0) { entry.put("fetchedAt", JsonString(stamp())) }
                let identity = if (isWeb) { strOf(entry, "url") } else { strOf(entry, "kbId") + "\n" + strOf(entry, "docPath") + "\n" + strOf(entry, "id") + strOf(entry, "chunkId") }
                if ((isWeb && identity.size == 0) || (!isWeb && strOf(entry, "docPath").size == 0)) { continue }
                let ids = if (isWeb) { webIds } else { localIds }
                let sources = if (isWeb) { web } else { local }
                let number = match (ids.get(identity)) {
                    case Some(value) => value
                    case None =>
                        let value = sources.size + 1
                        sources.add(entry); ids[identity] = value
                        value
                }
                entry.put("index", JsonInt(number))
                text.append("\n[" + (if (isWeb) { "W" } else { "" }) + number.toString() + "] " + entry.toString())
            }
        }
        let formatted = text.toString()
        if (formatted.size > result.summary.size) { result.content = byteSafePrefix(formatted, 50000) }
        return result
    }

    public func localSources(): JsonArray {
        synchronized(lock) { let result = JsonArray(); for (source in local) { result.add(source) }; return result }
    }

    public func webSources(): ArrayList<JsonObject> {
        synchronized(lock) { let result = ArrayList<JsonObject>(); for (source in web) { result.add(source) }; return result }
    }
}
