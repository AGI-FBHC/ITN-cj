package itn_desktop_core.unittests

import std.unittest.*
import std.unittest.testmacro.*
import std.fs.*
import stdx.encoding.json.*
import itn_desktop_core.harvest.*
import itn_desktop_core.agent.buildDomainToolDefs
import itn_desktop_core.agent.listSkills
import itn_desktop_core.agent.listSkillsWithHome
import itn_desktop_core.store.Store
import itn_desktop_core.pi.ScriptedProvider
import itn_desktop_core.pi.scriptTool
import itn_desktop_core.pi.scriptText
import itn_desktop_core.pi_app.PiAgent
import itn_desktop_core.util.boolOf
import itn_desktop_core.util.intOf
import itn_desktop_core.util.strOf
import itn_desktop_core.session.SessionStore

@Test
func harvestRejectsEscapeAndIgnoredDirectories(): Unit {
    @Expect(harvestPathAllowed("docs/hello.md"), true)
    @Expect(harvestPathAllowed("../outside.md"), false)
    @Expect(harvestPathAllowed("C:/outside.md"), false)
    @Expect(harvestPathAllowed("docs\\outside.md"), false)
    @Expect(harvestPathAllowed("docs/.git/config.json"), false)
    @Expect(harvestPathAllowed("node_modules/a/readme.md"), false)
    @Expect(harvestPathAllowed("dist/readme.md"), false)
    @Expect(harvestPathAllowed("target/readme.md"), false)
}

@Test
func harvestModelCannotConfirmIngest(): Unit {
    let dataDir = freshDir("harvest-model-guard")
    let store = Store(dataDir)
    var found = false
    for (d in buildDomainToolDefs(store, "", true)) {
        if (d.name == "kb_ingest") {
            found = true
            let args = JsonObject()
            args.put("id", JsonString("source-123"))
            args.put("confirmed", JsonBool(true))
            let r = d.run(args)
            @Expect(r.ok, true)
            @Expect(r.content.contains("尚未并入"), true)
        }
    }
    @Expect(found, true)
    @Expect(exists(dataDir + "/staging"), false)
    for (d in buildDomainToolDefs(store, "", false)) {
        @Expect(d.name == "kb_stage" || d.name == "kb_ingest", false)
    }
}

@Test
func hostLoadsEverySiblingSkill(): Unit {
    let dir = freshDir("host-multiple-skills")
    for (id in ["first", "second"]) {
        Directory.create(Path(dir + "/skills/" + id), recursive: true)
        File.writeTo(dir + "/skills/" + id + "/SKILL.md",
            ("---\nname: " + id + "\ntools: [list_documents]\n---\n正文").toArray())
    }
    let skills = listSkills(dir, true)
    var first = false
    var second = false
    for (s in skills) {
        if (s.id == "first") { first = true }
        if (s.id == "second") { second = true }
    }
    @Expect(first && second, true)
}

@Test
func luminBridgeHonorsHostIngestGuard(): Unit {
    let dir = freshDir("lumin-ingest-guard")
    let model = ScriptedProvider([
        scriptTool("kb_ingest", "{\"id\":\"source-123\",\"confirmed\":true}"),
        scriptText("资料尚未并入，请在界面确认。")
    ])
    let result = PiAgent(Store(dir)).askWithProvider(model, "", "把资料并入", "", "auto", "")
    @Expect(boolOf(result, "ok"), true)
    @Expect(intOf(result, "turns"), 2)
    var guarded = false
    for (e in SessionStore(dir).events(strOf(result, "sessionId"))) {
        if (strOf(e, "type") == "tool/result") {
            let p = jsonObjOf(e.get("payload"))
            if (strOf(p, "tool") == "kb_ingest" && strOf(p, "summary").contains("尚未并入")) { guarded = true }
        }
    }
    @Expect(guarded, true)
    @Expect(exists(dir + "/staging"), false)
}

@Test
func luminDiscoversSkillsAndEnforcesTheirTools(): Unit {
    // 显式绑定（第 6 个参数）：白名单才生效；绑定后 skill_read 自身仍要放行。
    let dir = freshDir("lumin-skill-scope")
    Directory.create(Path(dir + "/skills/read-only"), recursive: true)
    File.writeTo(dir + "/skills/read-only/SKILL.md",
        "---\nname: read-only\ndescription: Only inspect documents\ntools: [list_documents]\n---\nDo not create artifacts.".toArray())
    let model = ScriptedProvider([
        scriptTool("skill_read", "{\"id\":\"read-only\"}"),
        scriptTool("save_artifact", "{\"name\":\"must-not-exist.md\",\"content\":\"blocked\"}"),
        scriptText("这项技能只允许查看文档。")
    ])
    let result = PiAgent(Store(dir)).askWithProvider(model, "", "看看资料", "", "off", "read-only")
    @Expect(boolOf(result, "ok"), true)
    @Expect(model.seenSystems[0].contains("read-only"), true)
    @Expect(exists(dir + "/drafts/must-not-exist.md"), false)
    var denied = false
    var readDenied = false
    for (e in SessionStore(dir).events(strOf(result, "sessionId"))) {
        if (strOf(e, "type") == "tool/denied") {
            denied = true
            if (strOf(e, "payload").contains("skill_read")) { readDenied = true }
        }
    }
    @Expect(denied, true)
    @Expect(readDenied, false)
}

@Test
func skillReadDoesNotLockTheToolset(): Unit {
    // 只是读技能正文（没有绑定）：读完照常出产物，不该被技能白名单锁住。
    let dir = freshDir("lumin-skill-read-free")
    Directory.create(Path(dir + "/skills/read-only"), recursive: true)
    File.writeTo(dir + "/skills/read-only/SKILL.md",
        "---\nname: read-only\ndescription: Only inspect documents\ntools: [list_documents]\n---\nDo not create artifacts.".toArray())
    let model = ScriptedProvider([
        scriptTool("skill_read", "{\"id\":\"read-only\"}"),
        scriptTool("save_artifact", "{\"name\":\"allowed-now.md\",\"content\":\"ok\"}"),
        scriptText("读技能只是看说明，工具不受它限制。")
    ])
    let result = PiAgent(Store(dir)).askWithProvider(model, "", "看看资料", "", "off", "")
    @Expect(boolOf(result, "ok"), true)
    @Expect(exists(dir + "/drafts/allowed-now.md"), true)
    var denied = false
    for (e in SessionStore(dir).events(strOf(result, "sessionId"))) {
        if (strOf(e, "type") == "tool/denied") { denied = true }
    }
    @Expect(denied, false)
}

@Test
func luminRejectsUnavailableBoundSkills(): Unit {
    let dir = freshDir("lumin-skill-unavailable")
    Directory.create(Path(dir + "/skills/network"), recursive: true)
    File.writeTo(dir + "/skills/network/SKILL.md",
        "---\nname: network\ntools: [web_fetch]\nrequires_consent: web\n---\nRead a page.".toArray())
    let model = ScriptedProvider([scriptText("不应调用模型")])
    let result = PiAgent(Store(dir)).askWithProvider(model, "", "读网页", "", "off", "network")
    @Expect(boolOf(result, "ok"), false)
    @Expect(model.seenSystems.size, 0)
}

@Test
func sharedSkillRootsExposeCodexClaudeAndAgentsConventions(): Unit {
    let dir = freshDir("shared-skills-data")
    let home = freshDir("shared-skills-home")
    // .agents / .claude / .codex 三个共享目录都要被扫到
    Directory.create(Path(home + "/.agents/skills/agents-ref"), recursive: true)
    File.writeTo(home + "/.agents/skills/agents-ref/SKILL.md",
        ("---\nname: agents-ref\ndescription: 与 Codex 共用的说明型技能。\n---\n正文").toArray())
    Directory.create(Path(home + "/.claude/skills/claude-tool"), recursive: true)
    File.writeTo(home + "/.claude/skills/claude-tool/SKILL.md",
        ("---\nname: claude-tool\ntools: [list_documents]\n---\n正文").toArray())
    Directory.create(Path(home + "/.codex/skills/codex-ref"), recursive: true)
    File.writeTo(home + "/.codex/skills/codex-ref/SKILL.md",
        ("---\nname: codex-ref\ndescription: 只读参考。\n---\n正文").toArray())
    // 用户自己的同名技能要盖过共享的（共享副本不再出现）
    Directory.create(Path(dir + "/skills/agents-ref"), recursive: true)
    File.writeTo(dir + "/skills/agents-ref/SKILL.md",
        ("---\nname: agents-ref\ntools: [list_documents]\n---\n本地覆盖").toArray())
    let skills = listSkillsWithHome(dir, true, home)
    var agentsCount: Int64 = 0
    var agentsUser = false
    var agentsShared = false
    var sharedUsable = 0
    var refListedWithReason = false
    for (s in skills) {
        if (s.id == "agents-ref") {
            agentsCount = agentsCount + 1
            if (s.source == "user") { agentsUser = true }
            if (s.source == "shared") { agentsShared = true }
        }
        if (s.id == "claude-tool" && s.source == "shared" && s.available) { sharedUsable = sharedUsable + 1 }
        if (s.id == "codex-ref" && s.source == "shared") {
            sharedUsable = sharedUsable + 1
            refListedWithReason = !s.available && s.reason.size > 0
        }
    }
    @Expect(agentsCount, 1)      // 同名去重：只留用户那一份
    @Expect(agentsUser, true)
    @Expect(agentsShared, false)
    @Expect(sharedUsable, 2)     // .claude 的可用 + .codex 的列出
    @Expect(refListedWithReason, true)  // 没声明 tools 的共享技能：列出且标原因
}
