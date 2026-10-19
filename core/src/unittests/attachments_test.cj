package itn_desktop_core.unittests

import std.unittest.*
import std.unittest.testmacro.*
import stdx.encoding.json.*
import itn_desktop_core.runtime.*
import itn_desktop_core.runtime_host.*
import itn_desktop_core.store.Store
import itn_desktop_core.session.*
import itn_desktop_core.agent.sessionTools

@Test
func attachmentsStayOutOfUserTextAndBecomeNativeModelParts(): Unit {
    let a = JsonArray()
    let file = JsonObject(); file.put("kind", JsonString("file")); file.put("name", JsonString("sample.csv")); file.put("path", JsonString("D:/sample.csv")); a.add(file)
    let image = JsonObject(); image.put("kind", JsonString("image")); image.put("name", JsonString("sample.png")); image.put("dataUrl", JsonString("data:image/png;base64,aGVsbG8=")); a.add(image)
    let m = Message(UserMsg); m.text = "分析附件"; m.attachments = validatedAttachments(Some(a))
    @Expect(strOf(m.toJson(), "content"), "分析附件")
    @Expect(m.toChatJson().toString().contains("image_url"), true)
    @Expect(m.toChatJson().toString().contains("D:/sample.csv"), true)
    match (messageFromJson(m.toJson())) { case Some(copy) => @Expect(copy.attachments.size(), 2); case None => @Expect(false, true) }
    @Expect(attachmentMetadata(m.attachments).toString().contains("data:image"), false)
}

@Test
func imageAttachmentsRejectRemoteUrlsAndUnknownTypes(): Unit {
    let a = JsonArray(); let image = JsonObject(); image.put("kind", JsonString("image")); image.put("dataUrl", JsonString("https://example.com/private.png")); a.add(image)
    var failed = false
    try { validatedAttachments(Some(a)) } catch (_: Exception) { failed = true }
    @Expect(failed, true)
}

@Test
func applicationSessionReadingDoesNotDependOnWorkDirectory(): Unit {
    let dir = freshDir("read-app-session")
    let store = Store(dir); let sessions = SessionStore(dir)
    for ((kind,text) in [("user/message","第一章讲了什么"),("assistant/message","第一章介绍智能体的感知、决策与行动。")]) {
        let event = SessionEvent(); event.sessionId = "target"; event.turnId = "t"; event.kind = kind; event.payload.put("text", JsonString(text)); sessions.append(event)
    }
    let tool = sessionTools(store)[0]; let args = JsonObject(); args.put("session_id", JsonString("lumin://thread/target"))
    @Expect(tool.run(args).content.contains("感知、决策与行动"), true)
    let work = WorkContext(); work.dir = dir; work.chatMode = false; work.allowExec = false
    let result = LuminAgent(store).askFull(ScriptedProvider([scriptTool("read_session", "{\"session_id\":\"lumin://thread/target\"}"),scriptText("已读到第一章记录")]), "", "读一下lumin://thread/target", "work-reader", "off", "", Some(work))
    @Expect(boolOf(result,"ok",false), true)
    var got = false
    for(e in sessions.events("work-reader")) { if(strOf(e,"type")=="tool/result") { got = e.toString().contains("第一章介绍") } }
    @Expect(got, true)
    args.put("session_id",JsonString("absent"));var failed=false;try{tool.run(args)}catch(_:Exception){failed=true};@Expect(failed,true)
}
