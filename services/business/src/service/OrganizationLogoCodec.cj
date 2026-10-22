package web.service

import std.collection.*
import std.env.getVariables
import std.fs.canonicalize
import std.process.*
import std.unicode.*
import stdx.encoding.base64.*

// Windows image adapter. Business rules and database writes remain in Cangjie.
public class OrganizationLogoCodec {
    public static func normalize(upload: Array<UInt8>): Array<UInt8> {
        if (upload.size == 0 || upload.size > 2097152) { throw ProfileJson.invalid("Logo 文件不能为空且不能超过 2MB") }
        var windowsRoot = ""
        var pythonExecutable = "/opt/itn-python/venv/bin/python"
        for ((key, value) in getVariables()) {
            let upper = key.toUpper(CasingOption.Other)
            if (upper == "SYSTEMROOT") {
                windowsRoot = value
            } else if (upper == "ITN_LOGO_PYTHON") {
                pythonExecutable = value
            }
        }
        let isWindows = !windowsRoot.isEmpty()
        let helper = canonicalize(if (isWindows) { "normalize-organization-logo.ps1" } else { "normalize_organization_logo.py" }).toString()
        let executable: String = if (isWindows) {
            windowsRoot + "\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"
        } else {
            pythonExecutable
        }
        let args: Array<String> = if (isWindows) {
            ["-NoLogo", "-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden",
             "-ExecutionPolicy", "Bypass", "-File", helper]
        } else {
            [helper]
        }
        let child = launch(executable, args, stdIn: Pipe, stdOut: Pipe, stdErr: Pipe)
        child.stdInPipe.write((toBase64String(upload) + "\n").toArray())
        let output = ArrayList<UInt8>()
        let buffer = Array<UInt8>(65536, repeat: 0)
        var tooLarge = false
        while (true) {
            let count = child.stdOutPipe.read(buffer)
            if (count == 0) { break }
            if (output.size + count <= 8388608) { for (i in 0..count) { output.add(buffer[i]) } } else { tooLarge = true }
        }
        // The adapter only returns fixed numeric failure codes; no uploaded data is logged.
        while (child.stdErrPipe.read(buffer) > 0) { () }
        let status = child.wait()
        if (status == 2) { throw ProfileJson.invalid("Logo 文件不能为空且不能超过 2MB") }
        if (status == 3) { throw ProfileJson.invalid("Logo 图片尺寸过大") }
        if (status != 0 || tooLarge) { throw ProfileJson.invalid("Logo 无法解析，请上传 PNG 或 JPEG 图片") }
        let png = fromBase64String(String.fromUtf8(output.toArray()).trim()).getOrDefault({ => throw Exception("Logo adapter returned invalid output") })
        if (png.size < 8 || png[0] != 137u8 || png[1] != 80u8 || png[2] != 78u8 || png[3] != 71u8) { throw Exception("Logo adapter did not produce PNG") }
        return png
    }
}
