package zhixun_learning

import std.collection.*
import std.core.*
import std.fs.*
import std.process.*
import stdx.encoding.json.*

func presentationDir(id: String): String {
    let dir = "data/presentations/" + id
    if (!exists(Path(dir))) { Directory.create(Path(dir), recursive: true) }
    dir
}

func presentationBackgroundStyle(): String {
    let configured = envOr("ZHIXUN_PPT_BACKGROUND_STYLE", "clean-minimal").trimAscii()
    let allowed = HashSet<String>(["none", "colorful-ink", "sunset-mountains", "abstract-gradient",
        "clean-minimal", "cartoon-doodle", "blue-white-minimal", "blue-conference",
        "morandi-blue-gray", "business-gray", "watercolor"])
    if (allowed.contains(configured)) { configured } else { "clean-minimal" }
}

func presentationRendererDir(): String {
    let configuredRoot = envOr("ZHIXUN_PROJECT_ROOT", "")
    if (configuredRoot.size > 0) {
        let absolutePath = configuredRoot + "/services/learning/renderer/ppt-renderer"
        if (exists(Path(absolutePath + "/render_ppt.py"))) { return absolutePath }
    }
    let projectPath = "services/learning/renderer/ppt-renderer"
    if (exists(Path(projectPath + "/render_ppt.py"))) { return projectPath }
    let servicePath = "renderer/ppt-renderer"
    if (exists(Path(servicePath + "/render_ppt.py"))) { return servicePath }
    throw Exception("PPT渲染器目录不存在")
}

func presentationRequestJson(title: String, sourceLabel: String, slideCount: Int64): String {
    let out = JsonWriter()
    out.putStr("requirement", "根据《" + title + "》本章原文制作可直接授课的交互演示文稿；来源：" + sourceLabel)
    out.putStr("title", title)
    out.putStr("audience", "学生")
    out.putStr("purpose", "courseware")
    out.putStr("style", "education")
    out.putStr("backgroundStyle", presentationBackgroundStyle())
    out.putStr("language", "zh-CN")
    out.putInt("slideCount", slideCount)
    out.putStr("aspectRatio", "16:9")
    out.putStr("detailLevel", "detailed")
    out.putBool("includeSpeakerNotes", true)
    out.putStr("modelProvider", "cangjie")
    out.putStr("generationMode", "template")
    out.toJson()
}

class PresentationRenderResult {
    let metadataJson: String
    let slideCount: Int64
    let speakerNoteCount: Int64

    init(metadataJson: String, slideCount: Int64, speakerNoteCount: Int64) {
        this.metadataJson = metadataJson
        this.slideCount = slideCount
        this.speakerNoteCount = speakerNoteCount
    }
}

/**
 * Same pipeline as Lumin: the model supplies a validated structured outline,
 * while this renderer exclusively produces the actual PPTX, design JSON and
 * slide-shaped HTML preview.
 */
func renderPresentationPptx(id: String, title: String, sourceLabel: String,
                            outlineJson: String): PresentationRenderResult {
    let dir = presentationDir(id)
    let rendererDir = presentationRendererDir()
    let script = rendererDir + "/render_ppt.py"
    if (!exists(Path(script))) { throw Exception("PPT渲染器缺失：" + script) }
    let inputPath = dir + "/presentation.request.json"
    let outputPath = dir + "/presentation.pptx"
    let packet = "{\"request\":" + presentationRequestJson(title, sourceLabel, CW_PRESENTATION_SLIDE_COUNT) +
        ",\"outline\":" + outlineJson + "}"
    File.writeTo(Path(inputPath), packet.toArray())
    let (code, out, err) = executeWithOutput("python",
        ["-X", "utf8", script, inputPath, outputPath])
    if (code != 0 || !exists(Path(outputPath))) {
        let diagnostic = if (err.size > 0) { String.fromUtf8(err) } else { String.fromUtf8(out) }
        throw Exception("PPT渲染失败：" + kbTruncate(diagnostic, 1200))
    }
    var actualSlides: Int64 = CW_PRESENTATION_SLIDE_COUNT
    var actualNotes: Int64 = 0
    match (cwJsonObjectFrom(String.fromUtf8(out))) {
        case Some(result) =>
            actualSlides = jsonGetInt(result, "slides") ?? actualSlides
            actualNotes = jsonGetInt(result, "notes") ?? actualNotes
        case None => ()
    }
    let meta = JsonWriter()
    meta.putStr("kind", "pptx")
    meta.putStr("downloadUrl", "/api/presentation/" + id + "/download.pptx")
    meta.putStr("previewUrl", "/api/presentation/" + id + "/preview")
    meta.putInt("slideCount", actualSlides)
    meta.putInt("speakerNoteCount", actualNotes)
    meta.putStr("backgroundStyle", presentationBackgroundStyle())
    meta.putStr("generationMode", "template")
    meta.putStr("renderer", "lumin-python-pptx-v1")
    PresentationRenderResult(meta.toJson(), actualSlides, actualNotes)
}

func presentationWithMetadata(outlineJson: String, presentationJson: String): String {
    let text = outlineJson.trimAscii()
    if (!text.endsWith("}")) { return outlineJson }
    text[0..text.size - 1] + ",\"presentation\":" + presentationJson + "}"
}

func presentationFilePath(id: String, fileName: String): ?String {
    let path = presentationDir(id) + "/" + fileName
    if (exists(Path(path))) { Some(path) } else { None }
}
