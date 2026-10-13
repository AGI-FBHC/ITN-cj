package itn_desktop_core

import stdx.net.http.*
import stdx.net.tls.*
import std.sync.*
import std.time.*

func probe(url: String, alpn: Bool): String {
    var text = ""
    try {
        var tls = TlsClientConfig()
        if (alpn) {
            tls.supportedAlpnProtocols = ["http/1.1"]
        }
        let client = ClientBuilder().tlsConfig(tls).build()
        let resp = client.get(url)
        text = "OK " + resp.status.toString()
        client.close()
    } catch (e: Exception) {
        text = "ERR " + e.message
    }
    return text
}

main(args: Array<String>): Int64 {
    let server = ServerBuilder().addr("127.0.0.1").port(0).build()

    server.distributor.register("/health", { ctx: HttpContext =>
        ctx.responseBuilder.status(200)
        ctx.responseBuilder.header("Content-Type", "application/json; charset=utf-8")
        ctx.responseBuilder.body(#"{"status":"ok","service":"itn-desktop-core","cangjie":"1.2.0"}"#.toArray())
    })

    server.distributor.register("/selftest/tls", { ctx: HttpContext =>
        var lines = ""
        lines = lines + "cangjie-lang.cn alpn-h1: " + probe("https://cangjie-lang.cn/", true) + "\n"
        lines = lines + "cangjie-lang.cn default: " + probe("https://cangjie-lang.cn/", false) + "\n"
        lines = lines + "baidu default: " + probe("https://www.baidu.com/", false) + "\n"
        lines = lines + "example.com default: " + probe("https://www.example.com/", false) + "\n"
        ctx.responseBuilder.status(200)
        ctx.responseBuilder.body(lines.toArray())
    })

    spawn { server.serve() }
    sleep(Duration.millisecond * 400)
    println("ITN_DESKTOP_CORE_PORT=${server.port}")
    while (true) {
        sleep(Duration.second * 5)
    }
    return 0
}

