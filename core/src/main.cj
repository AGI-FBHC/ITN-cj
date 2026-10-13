package itn_desktop_core

import std.sync.*
import std.time.*
import itn_desktop_core.api.*
import itn_desktop_core.util.*

main(args: Array<String>): Int64 {
    var dataDir = defaultDataDir()
    match (argValue(args, "--data-dir")) {
        case Some(v) => dataDir = v
        case None => ()
    }

    let server = buildServer(dataDir)
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
