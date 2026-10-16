package itn_desktop_core

import std.sync.*
import std.time.*
import std.convert.*
import itn_desktop_core.api.*
import itn_desktop_core.agent.*
import itn_desktop_core.dev.*
import itn_desktop_core.util.*

main(args: Array<String>): Int64 {
    var dataDir = defaultDataDir()
    match (argValue(args, "--data-dir")) {
        case Some(v) => dataDir = v
        case None => ()
    }

    var uiDir = "ui"
    match (argValue(args, "--ui-dir")) {
        case Some(v) => uiDir = v
        case None => ()
    }

    // 随包内置的技能目录（外壳指进来；只读，用户改不了）
    match (argValue(args, "--skills-dir")) {
        case Some(v) => SKILLS_BUNDLED_DIR = v
        case None => ()
    }

    // 开发/自测夹具：灌一批会话数据（只在空库上生效；见 dev/fixture.cj）
    match (argValue(args, "--seed-fixture")) {
        case Some(v) =>
            var total: Int64 = 0
            try {
                total = Int64.parse(v)
            } catch (e: Exception) {
                total = 0
            }
            if (total > 0) {
                seedSessionFixture(dataDir, total)
            }
        case None => ()
    }

    let server = buildServer(dataDir, uiDir)
    spawn { server.serve() }
    sleep(Duration.millisecond * 300)

    let port = server.port
    match (argValue(args, "--port-file")) {
        case Some(pf) =>
            writeText(pf, port.toString())
        case None => ()
    }
    println("ITN_DESKTOP_CORE_PORT=" + port.toString())
    println("ITN_DESKTOP_CORE_DATA=" + dataDir)

    while (true) {
        sleep(Duration.second * 5)
    }
    return 0
}
