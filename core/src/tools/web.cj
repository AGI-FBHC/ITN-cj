package itn_desktop_core.tools

import stdx.net.http.*
import stdx.net.tls.*
import stdx.net.tls.common.*
import std.collection.*
import std.convert.*
import std.fs.*
import std.time.*
import stdx.encoding.json.*
import itn_desktop_core.kb.*
import itn_desktop_core.util.*

/**
 * 联网抓取（web_fetch）。
 *
 * 定位：**零新依赖**的那一半联网能力——不配任何搜索服务，"用户贴一个链接让 agent 读"
 * 也是完整可用的；它把「联网 → 落本机 → 进引用体系」这条最关键的链路先打通。
 *
 * 三条体面：
 * - 只允许 http/https；单页上限 2MB；超时 20 秒；最多跟 3 次跳转。
 * - content-type 不是文本/HTML 就直说"这个类型暂时读不了"，不假装读到了（与"读不了的文件如实报出来"同一个态度）。
 * - 抓到的东西落 <dataDir>/webcache/<hash>.md（frontmatter 记 URL / 标题 / 抓取时间）；
 *   同一 URL 再抓会覆盖并更新抓取时间——这就是"重新抓取"，也保证可审计、可删除。
 *
 * HTML → 正文复用第 9 轮给 HTML 资料写的 htmlToText（去 script/style、h1~h6 变标题）。
 */
public class WebFetchException <: Exception {
    public init(message: String) {
        super(message)
    }
}

/** 单页正文上限：抓回的东西最后要塞进提示词，不设限会把上下文顶爆。 */
let WEB_MAX_BYTES: Int64 = 2 * 1024 * 1024

/** 进提示词的正文上限。 */
let WEB_PROMPT_CHARS: Int64 = 6000

func isHttpUrl(url: String): Bool {
    return hasPrefix(url, "http://") || hasPrefix(url, "https://")
}

/** 子串查找：返回下标，找不到返回 -1（标准库的 indexOf 返回 Option，这里用着方便）。 */
func findFrom(s: String, sub: String, from: Int64): Int64 {
    let b = s.toArray()
    let n = sub.toArray()
    if (n.size == 0 || b.size < n.size) {
        return -1
    }
    var i = from
    while (i + n.size <= b.size) {
        var j = 0
        var ok = true
        while (j < n.size) {
            if (b[i + j] != n[j]) {
                ok = false
                break
            }
            j = j + 1
        }
        if (ok) {
            return i
        }
        i = i + 1
    }
    return -1
}

func findLastFrom(s: String, sub: String): Int64 {
    let b = s.toArray()
    let n = sub.toArray()
    if (n.size == 0 || b.size < n.size) {
        return -1
    }
    var i = b.size - n.size
    while (i >= 0) {
        var j = 0
        var ok = true
        while (j < n.size) {
            if (b[i + j] != n[j]) {
                ok = false
                break
            }
            j = j + 1
        }
        if (ok) {
            return i
        }
        i = i - 1
    }
    return -1
}

func containsStr(s: String, sub: String): Bool {
    return findFrom(s, sub, 0) >= 0
}

/** URL → 稳定的短哈希（取模保证不溢出）。同一个 URL 永远同一个缓存文件名。 */
public func urlHash(url: String): String {
    var h: Int64 = 5381
    for (c in url.toArray()) {
        h = (h * 31 + Int64(c)) % 1000000007
    }
    let table = "0123456789abcdef".toArray()
    var out = ""
    var v = h
    if (v < 0) {
        v = -v
    }
    var i = 0
    while (i < 8) {
        let d = v % 16
        out = String.fromUtf8([table[d]]) + out
        v = v / 16
        i = i + 1
    }
    return out
}

/** 从 HTML 里抠 <title>；抠不到就用 URL 的最后一段。 */
func pageTitle(html: String, url: String): String {
    let lower = html.toAsciiLower()
    let open = findFrom(lower, "<title", 0)
    if (open >= 0) {
        let gt = findFrom(lower, ">", open)
        let end = findFrom(lower, "</title", gt)
        if (gt > 0 && end > gt) {
            let t = trimStr(String.fromUtf8(html.toArray()[(gt + 1)..end]))
            if (t.size > 0) {
                return byteSafePrefix(t, 120)
            }
        }
    }
    var u = url
    if (hasSuffix(u, "/")) {
        u = String.fromUtf8(u.toArray()[0..(u.size - 1)])
    }
    let a = findLastFrom(u, "/")
    let b = findLastFrom(u, "?")
    var cut = a
    if (b > cut) {
        cut = b
    }
    if (cut > 0 && cut + 1 < u.size) {
        return String.fromUtf8(u.toArray()[(cut + 1)..u.size])
    }
    return u
}

/* ---------- HTTP ---------- */

func hostOfUrl(url: String): String {
    let b = url.toArray()
    var i = 0
    while (i + 2 < b.size) {
        if (b[i] == 58 && b[i + 1] == 47 && b[i + 2] == 47) {
            i = i + 3
            break
        }
        i = i + 1
    }
    let start = i
    var end = b.size
    var j = i
    while (j < b.size) {
        if (b[j] == 47 || b[j] == 58) {
            end = j
            break
        }
        j = j + 1
    }
    return String.fromUtf8(b[start..end])
}

/**
 * 一次 GET。
 *
 * 返回 {statusText, ok, redirect, body, location, contentType}。
 * 状态码只在本函数里和字面量比（llm.cj 里也是这么比的），对外给的是布尔，免得依赖状态类型的内部结构。
 */
public func httpGet(url: String): JsonObject {
    var tls = TlsClientConfig()
    tls.serverName = Some(hostOfUrl(url))
    tls.supportedAlpnProtocols = ["http/1.1"]
    let client = ClientBuilder()
        .tlsConfig(tls)
        .readTimeout(Duration.second * 20)
        .writeTimeout(Duration.second * 20)
        .build()
    try {
        let req = HttpRequestBuilder()
            .method("GET")
            .url(url)
            .header("Accept", "text/html,application/xhtml+xml,text/plain,application/json;q=0.9,*/*;q=0.5")
            .header("User-Agent", "ITN-Desktop/0.1 (local study agent)")
            .build()
        let resp = client.send(req)
        let st = resp.status
        let body = readAllString(resp.body)
        var loc = ""
        var ctype = ""
        match (resp.headers.getFirst("location")) {
            case Some(v) => loc = v
            case None => ()
        }
        match (resp.headers.getFirst("content-type")) {
            case Some(v) => ctype = v
            case None => ()
        }
        let o = JsonObject()
        o.put("statusText", JsonString(st.toString()))
        o.put("ok", JsonBool(st == 200))
        o.put("redirect", JsonBool(st == 301 || st == 302 || st == 303 || st == 307 || st == 308))
        o.put("body", JsonString(byteSafePrefix(body, WEB_MAX_BYTES)))
        o.put("location", JsonString(loc))
        o.put("contentType", JsonString(ctype))
        return o
    } catch (e: WebFetchException) {
        throw e
    } catch (e: Exception) {
        throw WebFetchException("抓取失败：" + e.message)
    } finally {
        client.close()
    }
}

func joinUrl(base: String, loc: String): String {
    if (hasPrefix(loc, "/")) {
        return "https://" + hostOfUrl(base) + loc
    }
    return loc
}

/** 看起来像网页吗（用来决定要不要走 HTML 转文本）。 */
func looksHtml(body: String, ctype: String): Bool {
    if (containsStr(ctype, "html") || containsStr(ctype, "xml")) {
        return true
    }
    let head = byteSafePrefix(body, 400).toAsciiLower()
    return containsStr(head, "<!doctype html") || containsStr(head, "<html")
}

/** 前 4KB 里有 NUL 就当二进制：宁可说读不了，也不把乱码塞进知识库。 */
func looksBinary(body: String): Bool {
    let b = body.toArray()
    var i = 0
    let n = if (b.size > 4096) { 4096 } else { b.size }
    while (i < n) {
        if (b[i] == 0) {
            return true
        }
        i = i + 1
    }
    return false
}

/* ---------- 抓取 + 落本机 ---------- */

/**
 * 抓一个页面并落到 webcache。
 *
 * 返回 {url, title, path, bytes, fetchedAt, status, text, excerpt}：
 * text 是给模型看的正文（已截断），excerpt 给界面预览。
 */
public func fetchPage(dataDir: String, url: String): JsonObject {
    if (!isHttpUrl(url)) {
        throw WebFetchException("只支持 http/https 链接，收到的是：" + byteSafePrefix(url, 60))
    }
    var current = url
    var hop: Int64 = 0
    var resp = httpGet(current)
    while (hop < 3 && boolOf(resp, "redirect")) {
        let loc = strOf(resp, "location")
        if (loc.size == 0) {
            break
        }
        current = if (isHttpUrl(loc)) { loc } else { joinUrl(current, loc) }
        if (!isHttpUrl(current)) {
            throw WebFetchException("跳转到了一个不支持的地址：" + byteSafePrefix(current, 80))
        }
        resp = httpGet(current)
        hop = hop + 1
    }
    if (!boolOf(resp, "ok")) {
        throw WebFetchException("这个地址返回 " + strOf(resp, "statusText") + "（只有 200 才当读到）")
    }
    let ctype = strOf(resp, "contentType").toAsciiLower()
    let raw = strOf(resp, "body")
    if (looksBinary(raw)) {
        throw WebFetchException("这个类型暂时读不了（content-type: " + byteSafePrefix(ctype, 60) + "）")
    }
    var text = raw
    if (looksHtml(raw, ctype)) {
        text = htmlToText(raw)
    }
    let title = pageTitle(raw, current)
    let now = DateTime.now().toString()
    let dir = webCacheDir(dataDir)
    ensureDir(dir)
    // 一律按"用户给的那个 URL"落盘与记出处：仓颉的 HTTP 客户端自己会跟 302/301，
    // 我们拿不到"最终地址"，而且用户要的本来就是"这个链接的内容"（重新抓取也照旧覆盖它）。
    let file = dir + Path.Separator + urlHash(url) + ".md"
    let fm = "---\nurl: " + url + "\ntitle: " + title + "\nfetchedAt: " + now +
        "\nbytes: " + raw.size.toString() + "\nstatus: 200\n---\n\n"
    writeText(file, fm + "# " + title + "\n\n" + text)
    let o = JsonObject()
    o.put("url", JsonString(url))
    o.put("title", JsonString(title))
    o.put("path", JsonString(file))
    o.put("bytes", JsonInt(raw.size))
    o.put("fetchedAt", JsonString(now))
    o.put("status", JsonString("200"))
    o.put("text", JsonString(byteSafePrefix(text, WEB_PROMPT_CHARS)))
    o.put("excerpt", JsonString(byteSafePrefix(text, 500)))
    return o
}

/* ---------- 缓存的可审计 / 可删除 ---------- */

public func webCacheDir(dataDir: String): String {
    return dataDir + Path.Separator + "webcache"
}

func fmValue(head: String, key: String): String {
    for (line in head.split("\n")) {
        let l = trimStr(line)
        if (hasPrefix(l, key + ":")) {
            let b = l.toArray()
            return trimStr(String.fromUtf8(b[(key.size + 1)..b.size]))
        }
    }
    return ""
}

/** 列出抓回来的页面（只读 frontmatter，不读正文）。目录不深，walk 一层即可。 */
public func listWebCache(dataDir: String): JsonArray {
    let arr = JsonArray()
    let dir = webCacheDir(dataDir)
    if (!exists(dir)) {
        return arr
    }
    try {
        Directory.walk(Path(dir), { fi: FileInfo =>
            if (!fi.isDirectory()) {
                let name = fi.name
                if (hasSuffix(name, ".md")) {
                    let p = dir + Path.Separator + name
                    let head = byteSafePrefix(readTextOr(p, ""), 600)
                    let o = JsonObject()
                    o.put("name", JsonString(name))
                    o.put("path", JsonString(p))
                    o.put("url", JsonString(fmValue(head, "url")))
                    o.put("title", JsonString(fmValue(head, "title")))
                    o.put("fetchedAt", JsonString(fmValue(head, "fetchedAt")))
                    o.put("bytes", JsonString(fmValue(head, "bytes")))
                    arr.add(o)
                }
            }
            false
        })
    } catch (e: Exception) {
        ()
    }
    return arr
}

/** 删一页缓存（只按文件名删，防路径穿越）。 */
public func deleteWebCache(dataDir: String, name: String): Bool {
    if (name.size == 0 || containsStr(name, "/") || containsStr(name, "\\") || !hasSuffix(name, ".md")) {
        return false
    }
    let p = webCacheDir(dataDir) + Path.Separator + name
    if (!exists(p)) {
        return false
    }
    remove(p)
    return true
}
