package zhixun_learning

import std.collection.*
import std.core.*
import std.convert.*
import std.fs.*
import std.process.*
import stdx.encoding.base64.*
import soulsoft_web_http.*

func kbLogoUploadScript(): String {
    let root = envOr("ZHIXUN_PROJECT_ROOT", "")
    for (path in [root + "/services/learning/renderer/course-logo/normalize_logo.py",
                  "services/learning/renderer/course-logo/normalize_logo.py", "renderer/course-logo/normalize_logo.py"]) {
        if (exists(Path(path))) { return path }
    }
    throw Exception("课程 Logo 图片处理组件不存在")
}

func kbReadLogoUpload(request: HttpRequest): Array<Byte> {
    let limit: Int64 = 8 * 1024 * 1024
    let declared = Int64.tryParse(request.headers.get("Content-Length") ?? "") ?? -1
    if (declared > limit) { throw Exception("Logo 图片不要超过 8MB") }
    let data = ArrayList<Byte>()
    let buffer = Array<Byte>(65536, repeat: 0)
    while (true) {
        let count = request.body.read(buffer)
        if (count <= 0) { break }
        if (data.size + count > limit) { throw Exception("Logo 图片不要超过 8MB") }
        for (i in 0..count) { data.add(buffer[i]) }
    }
    if (data.size == 0 || (declared >= 0 && data.size != declared)) { throw Exception("图片上传不完整，请重试") }
    data.toArray()
}

func kbNormalizeLogoUpload(upload: Array<Byte>): String {
    let child = launch(envOr("ZHIXUN_IMAGE_PYTHON", "python"), ["-X", "utf8", kbLogoUploadScript()],
        stdIn: Pipe, stdOut: Pipe, stdErr: Pipe)
    try {
        child.stdInPipe.write((toBase64String(upload) + "\n").toArray())
        let output = ArrayList<Byte>()
        let buffer = Array<Byte>(65536, repeat: 0)
        while (true) {
            let count = child.stdOutPipe.read(buffer)
            if (count <= 0) { break }
            if (output.size + count > 180000) { throw Exception("Logo 压缩结果超过限制") }
            for (i in 0..count) { output.add(buffer[i]) }
        }
        while (child.stdErrPipe.read(buffer) > 0) { () }
        let code = child.wait()
        if (code == 3) { throw Exception("图片尺寸过大，请使用不超过2500万像素的图片") }
        if (code != 0) { throw Exception("图片无法处理，请上传有效的 PNG、JPEG、WebP 或 GIF") }
        let encoded = String.fromUtf8(output.toArray()).trimAscii()
        let webp = fromBase64String(encoded).getOrThrow()
        if (webp.size < 12 || webp.size > 131072 || String.fromUtf8(webp[0..4]) != "RIFF" || String.fromUtf8(webp[8..12]) != "WEBP") {
            throw Exception("Logo 图片处理失败")
        }
        // Only the trusted encoder can provide the payload; no uploaded SVG is accepted.
        "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 512 512\"><image width=\"512\" height=\"512\" href=\"data:image/webp;base64," + encoded + "\"/></svg>"
    } finally {
        try { child.terminate(force: true) } catch (_: Exception) {}
    }
}

func kbSaveUploadedLogo(cfg: Config, bundleId: String, ownerId: String, svg: String): String {
    let rows = query(cfg, "SELECT title,name FROM kb_bundles WHERE id=" + sqlQuote(bundleId))
    if (rows.size == 0) { throw Exception("没有找到这个资料包") }
    let id = uuidFormat(uuidV4())
    let statements = ArrayList<String>()
    statements.add("INSERT INTO logo_generations(id,owner_id,resource_type,resource_id,title,status,model,variants_json,selected_variant_id) VALUES(" +
        sqlQuote(id) + "," + sqlQuote(ownerId) + ",'kb_bundle'," + sqlQuote(bundleId) + "," + sqlQuote(rows[0].text("title")) + ",'ready','custom-upload','[]','')")
    statements.add("UPDATE kb_bundles SET logo_svg=" + sqlQuote(svg) + ",logo_status='ready',logo_error='',logo_model='custom-upload',logo_attempts=0,logo_generation_id=" + sqlQuote(id) + " WHERE id=" + sqlQuote(bundleId))
    transaction(cfg, statements.toArray())
    kbBumpVersion()
    id
}
