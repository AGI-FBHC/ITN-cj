package itn_spire

import std.core.*
import std.collection.*
import std.convert.*
import std.fs.*
import std.env.*

/*
 * Filesystem helpers for the presentation read-side.
 *
 * Ported from public.py `_presentation_roots` / `_resolve_presentation_output`
 * / `_slideshow_asset_dir` / `_slide_images` / `_slide_image_for_index`.
 *
 * Cangjie std.fs probes that made this possible:
 *   exists(path): Bool
 *   FileInfo(path).size / .name / .isDirectory() / .isRegular()
 *   File.readFrom(path): Array<Byte>
 *   Directory.readFrom(path): iterable of FileInfo
 *   removeIfExists(path, recursive: false)
 * PDF→PNG rendering and TTS warm stay in the Python service.
 */

/* Normalise separators so Windows and container paths compare equal. */
func normPath(p: String): String {
    var out = ""
    for (ch in p.toRuneArray()) {
        out = out + (if (runeCode(ch) == 0x5c) { "/" } else { ch.toString() })
    }
    /* strip a trailing slash except for a bare root */
    while (out.size > 1 && out.endsWith("/")) {
        out = out[0..(out.size - 1)]
    }
    return out
}

func pathFileName(p: String): String {
    let n = normPath(p)
    var i = n.size
    while (i > 0) {
        i -= 1
        if (n[i] == 0x2f) {
            return n[(i + 1)..n.size]
        }
    }
    return n
}

func pathParent(p: String): String {
    let n = normPath(p)
    var i = n.size
    while (i > 0) {
        i -= 1
        if (n[i] == 0x2f) {
            if (i == 0) {
                return "/"
            }
            return n[0..i]
        }
    }
    return ""
}

func pathJoin(a: String, b: String): String {
    if (a.isEmpty()) {
        return b
    }
    if (b.isEmpty()) {
        return a
    }
    if (a.endsWith("/")) {
        return a + b
    }
    return a + "/" + b
}

/*
 * Python Path.is_relative_to(root) — prefix match after normalisation.
 * Case-sensitive, matching Path behaviour on the Linux container; the Windows
 * host is only used for local debugging.
 */
func pathIsUnder(candidate: String, root: String): Bool {
    let c = normPath(candidate)
    let r = normPath(root)
    if (r.isEmpty()) {
        return false
    }
    if (c == r) {
        return true
    }
    if (r.endsWith("/")) {
        return c.startsWith(r)
    }
    return c.startsWith(r + "/")
}

func fileIsFile(p: String): Bool {
    try {
        return exists(p) && FileInfo(p).isRegular()
    } catch (_: Exception) {
        return false
    }
}

/*
 * Python Settings.presentation_output_dir (env PRESENTATION_OUTPUT_DIR,
 * default "data/presentations") plus the two container mounts.
 */
func presentationOutputRoots(): Array<String> {
    var configured = getVariable("PRESENTATION_OUTPUT_DIR") ?? "data/presentations"
    if (configured.trimAscii().isEmpty()) {
        configured = "data/presentations"
    }
    let raw = [normPath(configured), "/app/data/presentations", "/data/presentations"]
    let seen = HashSet<String>()
    let out = ArrayList<String>()
    for (root in raw) {
        if (root.isEmpty() || seen.contains(root)) {
            continue
        }
        seen.add(root)
        out.add(root)
    }
    return out.toArray()
}

func presentationOutputDir(): String {
    var configured = getVariable("PRESENTATION_OUTPUT_DIR") ?? "data/presentations"
    if (configured.trimAscii().isEmpty()) {
        configured = "data/presentations"
    }
    return normPath(configured)
}

/*
 * _resolve_presentation_output: accept the persisted path when it lives under a
 * known root and is a file, else try {root}/{persisted.name}, else
 * {root}/{task_id}.pptx. Returns the path or None.
 */
func resolvePresentationOutput(taskIdText: String, rawPath: String): ?String {
    let roots = presentationOutputRoots()
    if (!rawPath.isEmpty()) {
        let persisted = normPath(rawPath)
        for (root in roots) {
            if (pathIsUnder(persisted, root) && fileIsFile(persisted)) {
                return Some(persisted)
            }
        }
        let name = pathFileName(persisted)
        if (!name.isEmpty()) {
            for (root in roots) {
                let candidate = pathJoin(root, name)
                if (fileIsFile(candidate)) {
                    return Some(candidate)
                }
            }
        }
    }
    for (root in roots) {
        let candidate = pathJoin(root, taskIdText + ".pptx")
        if (fileIsFile(candidate)) {
            return Some(candidate)
        }
    }
    return None
}

/* _slideshow_asset_dir(pptx_path, task_id) = pptx_path.parent / str(task_id) */
func slideshowAssetDir(pptxPath: String, taskIdText: String): String {
    pathJoin(pathParent(pptxPath), taskIdText)
}

/*
 * _slide_number(path): trailing digits of the stem, else 0.
 * "slide-1.png" → 1, "slide-01.png" → 1, "slide-003.png" → 3.
 */
func slideNumber(stem: String): Int64 {
    let rs = stem.toRuneArray()
    var end = rs.size
    var start = end
    while (start > 0) {
        let v = runeCode(rs[start - 1])
        if (v < 0x30 || v > 0x39) {
            break
        }
        start -= 1
    }
    if (start == end) {
        return 0
    }
    var text = ""
    var i = start
    while (i < end) {
        text = text + rs[i].toString()
        i += 1
    }
    return Int64.tryParse(text) ?? 0
}

func pngStem(name: String): String {
    if (name.toAsciiLower().endsWith(".png") && name.size >= 4) {
        return name[0..(name.size - 4)]
    }
    return ""
}

/*
 * _slide_images(slide_dir) — public.py:57-60:
 *     list(slide_dir.glob("slide-*.png")) or list(slide_dir.glob("slide_*.png"))
 * The `or` is list truthiness: when ANY dash-prefixed PNG exists the underscore
 * ones are ignored entirely. Two passes keep that precedence.
 * Sorted by trailing digits of the stem.
 *
 * Directory.readFrom replaces Python's glob; the pattern filter is applied
 * here because std.fs has no glob helper.
 */
func slideImages(slideDir: String): Array<String> {
    let dash = ArrayList<(Int64, String)>()
    let under = ArrayList<(Int64, String)>()
    try {
        for (entry in Directory.readFrom(slideDir)) {
            if (entry.isDirectory()) {
                continue
            }
            let name = entry.name
            let stem = pngStem(name)
            if (stem.isEmpty()) {
                continue
            }
            if (stem.startsWith("slide-")) {
                dash.add((slideNumber(stem), name))
            } else if (stem.startsWith("slide_")) {
                under.add((slideNumber(stem), name))
            }
        }
    } catch (_: Exception) {
        return Array<String>(0, repeat: "")
    }
    /* Python `a or b` keeps `a` whenever it is non-empty. */
    let names = if (dash.isEmpty()) { under } else { dash }
    /* stable sort by page number — insertion sort keeps equal numbers in listing order */
    let arr = names.toArray()
    var i: Int64 = 1
    while (i < arr.size) {
        var j = i
        while (j > 0 && arr[j - 1][0] > arr[j][0]) {
            let tmp = arr[j - 1]
            arr[j - 1] = arr[j]
            arr[j] = tmp
            j -= 1
        }
        i += 1
    }
    let out = ArrayList<String>()
    for (item in arr) {
        out.add(pathJoin(slideDir, item[1]))
    }
    return out.toArray()
}

func slideImageForIndex(slideDir: String, slideIndex: Int64): ?String {
    let pageNumber = slideIndex + 1
    for (p in slideImages(slideDir)) {
        if (slideNumber(pngStem(pathFileName(p))) == pageNumber) {
            return Some(p)
        }
    }
    return None
}

/*
 * _slide_images count fallback for /slides when outline.slides is empty.
 */
func slideImageCount(slideDir: String): Int64 {
    slideImages(slideDir).size
}

/* audioDir/assetDir — Python: pptx_path.parent / task_id / "audio" / "pcm_stretch_v3" / voice */
func slideshowAudioVoiceDir(assetDir: String, voice: String): String {
    pathJoin(pathJoin(pathJoin(assetDir, "audio"), "pcm_stretch_v3"), voice)
}

/*
 * MIMO_PRESET_VOICES (services/tts.py:20). _assistant_voice reads the learner
 * profile through Spring Boot and falls back to "苏打"; Spire cannot call that
 * service on this read path, so audio availability is true when the wav exists
 * under ANY preset voice directory. Documented divergence.
 */
func presetVoices(): Array<String> {
    ["冰糖", "茉莉", "苏打", "白桦", "Mia", "Chloe", "Milo", "Dean"]
}

func audioAvailableAt(assetDir: String, index: Int64): Bool {
    let wavName = "slide_" + pad3(index) + ".wav"
    for (voice in presetVoices()) {
        if (fileIsFile(pathJoin(slideshowAudioVoiceDir(assetDir, voice), wavName))) {
            return true
        }
    }
    return false
}

func pad3(v: Int64): String {
    if (v >= 100) {
        return v.toString()
    }
    if (v >= 10) {
        return "0" + v.toString()
    }
    return "00" + v.toString()
}

/* Unlink the persisted PPTX when it resolves under the configured root. */
func unlinkPresentationOutput(rawPath: String): Unit {
    if (rawPath.isEmpty()) {
        return
    }
    let root = presentationOutputDir()
    let path = normPath(rawPath)
    if (!pathIsUnder(path, root)) {
        return
    }
    try {
        if (fileIsFile(path)) {
            removeIfExists(path, recursive: false)
        }
    } catch (_: Exception) {
        /* Python unlink is best-effort inside the route; a failure is not fatal. */
    }
}

/* Read a whole file as bytes; None when missing or unreadable. */
func readWholeFile(path: String): ?Array<Byte> {
    try {
        if (!fileIsFile(path)) {
            return None
        }
        return Some(File.readFrom(path))
    } catch (_: Exception) {
        return None
    }
}
