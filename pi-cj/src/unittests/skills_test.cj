package pi_cj.unittests

import std.collection.*
import std.fs.*
import stdx.encoding.json.*
import pi_cj.pi.*
import std.unittest.*
import std.unittest.testmacro.*

/*
 * Skills：照 Agent Skills 规范（SKILL.md + frontmatter）。
 * 关键设计：启动只播 name/description/location，正文让模型自己去 read。
 */
@Test
class SkillsTest {
    func writeSkill(root: String, dir: String, name: String, desc: String, extra: String): Unit {
        let full = root + "/" + dir
        Directory.create(full, recursive: true)
        let body = "---\nname: " + name + "\ndescription: " + desc + "\n" + extra + "---\n\n# " + name +
            "\n\n正文说明。\n"
        File.writeTo(full + "/SKILL.md", body.toArray())
    }

    @TestCase
    func skillsAreDiscoveredFromConfiguredRoots(): Unit {
        let d = freshDir("skills-basic")
        writeSkill(d, "pdf-tools", "pdf-tools", "Extract text from PDFs. Use when reading PDFs.", "")
        writeSkill(d, "git-helper", "git-helper", "Help with git. Use when doing git work.", "")
        let roots = ArrayList<String>()
        roots.add(d)
        let skills = loadSkills(roots)
        @Expect(skills.size, 2)
        var names = ""
        for (s in skills) {
            names = names + s.name + "|"
        }
        @Expect(containsSub(names, "pdf-tools"), true)
        @Expect(containsSub(names, "git-helper"), true)
        @Expect(findSkill(skills, "pdf-tools").isSome(), true)
        @Expect(findSkill(skills, "nope").isNone(), true)
    }

    @TestCase
    func frontmatterIsRequiredAndValidated(): Unit {
        let d = freshDir("skills-validate")
        // 没有 frontmatter 的目录要被跳过
        let bad = d + "/no-front"
        Directory.create(bad, recursive: true)
        File.writeTo(bad + "/SKILL.md", "# 没有 frontmatter\n".toArray())
        // name 空、description 空都要跳过
        writeSkill(d, "empty-desc", "empty-desc", "", "")
        writeSkill(d, "good", "good", "有用的说明。", "")
        let roots = ArrayList<String>()
        roots.add(d)
        let skills = loadSkills(roots)
        @Expect(skills.size, 1)
        @Expect(skills[0].name, "good")
    }

    @TestCase
    func thePromptOnlyAdvertisesNameDescriptionAndLocation(): Unit {
        let d = freshDir("skills-prompt")
        writeSkill(d, "pdf-tools", "pdf-tools", "Extract text from PDFs. Use when reading PDFs.", "")
        let roots = ArrayList<String>()
        roots.add(d)
        let text = formatSkillsForPrompt(loadSkills(roots))
        @Expect(containsSub(text, "<available_skills>"), true)
        @Expect(containsSub(text, "<name>pdf-tools</name>"), true)
        @Expect(containsSub(text, "Use when reading PDFs"), true)
        @Expect(containsSub(text, "SKILL.md"), true)
        // 正文（# pdf-tools 之后的内容）不该被塞进来
        @Expect(containsSub(text, "正文说明"), false)
    }

    @TestCase
    func disableModelInvocationHidesItFromTheModelButKeepsItLoadable(): Unit {
        let d = freshDir("skills-manual")
        writeSkill(d, "secret", "secret", "只允许手动触发。", "disable-model-invocation: true\n")
        let roots = ArrayList<String>()
        roots.add(d)
        let skills = loadSkills(roots)
        @Expect(skills.size, 1)
        @Expect(skills[0].disableModelInvocation, true)
        // 播报里不出现，但 /skill: 还能按名字找到
        @Expect(formatSkillsForPrompt(skills), "")
        @Expect(findSkill(skills, "secret").isSome(), true)
    }

    @TestCase
    func noSkillsMeansNoPromptSection(): Unit {
        let d = freshDir("skills-none")
        let roots = ArrayList<String>()
        roots.add(d)
        @Expect(loadSkills(roots).size, 0)
        @Expect(formatSkillsForPrompt(ArrayList<Skill>()), "")
    }
}
