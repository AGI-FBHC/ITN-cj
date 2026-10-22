import io
import math
import struct
import wave

from app.routers.public import (
    _ReplyLeakGuard,
    _assistant_reply_leaked,
    _json_string_progress,
    _local_assistant_plan,
    _presentation_voice_control,
    _sanitize_assistant_plan,
    _strip_prompt_echo,
    _valid_presentation_transcript,
    _wav_contains_speech,
)


def test_presentation_voice_control_handles_unambiguous_commands():
    assert _presentation_voice_control("继续播放", 12) == ("play", None, True)
    assert _presentation_voice_control("请翻到下一页", 12) == ("next", None, False)
    assert _presentation_voice_control("跳到第3页", 12) == ("goto", 3, False)
    assert _presentation_voice_control("第三页主要讲了什么", 12) is None
    assert _presentation_voice_control("你是谁", 12) is None


def test_assistant_reply_leak_detection():
    assert _assistant_reply_leaked("你是亲切、简洁的小鼋助手，同时负责网页操作意图路由。")
    assert _assistant_reply_leaked("你是ITN在线演示助手，正在和用户围绕一份正在播放的PPT实时交流。")
    assert _assistant_reply_leaked("好的。只返回紧凑JSON，严格按照以下字段顺序。")
    assert not _assistant_reply_leaked("我是伴学助手。")
    assert not _assistant_reply_leaked("这一页讲的是线性表的顺序存储结构。")
    assert not _assistant_reply_leaked("")


def test_strip_prompt_echo_keeps_real_answer():
    echoed = (
        "你是亲切、简洁的伴学助手。直接回答用户问题，自然口语化。"
        "线性表是一种最基本的数据结构。"
    )
    assert _strip_prompt_echo(echoed) == "线性表是一种最基本的数据结构。"
    assert _strip_prompt_echo("这一页讲的是图遍历。") == "这一页讲的是图遍历。"
    assert _strip_prompt_echo("只输出合法JSON。") == ""


def test_sanitize_plan_strips_prompt_echo_from_reply():
    plan = _sanitize_assistant_plan({
        "action": "none",
        "arguments": {},
        "reply": "你是亲切、简洁的小鼋助手，同时负责网页操作意图路由。",
    })
    assert plan["reply"]
    assert not _assistant_reply_leaked(plan["reply"])


def test_reply_leak_guard_holds_back_and_swallows_prompt_echo():
    guard = _ReplyLeakGuard()
    emitted = ""
    for ch in "你是亲切、简洁的小鼋助手，同时负责网页操作意图路由。真正回答。":
        emitted += guard.feed(ch)
    emitted += guard.flush()
    assert guard.leaked
    assert emitted == ""


def test_reply_leak_guard_streams_normal_reply_with_small_delay():
    guard = _ReplyLeakGuard()
    text = "这一页讲的是线性表的顺序存储结构，特点是随机存取。"
    emitted = ""
    for ch in text:
        emitted += guard.feed(ch)
    assert not guard.leaked
    assert len(emitted) == len(text) - 16
    emitted += guard.flush()
    assert emitted == text


def _test_wav(amplitude: float, duration: float = 0.3, sample_rate: int = 16000) -> bytes:
    samples = [
        int(amplitude * 32767 * math.sin(2 * math.pi * 220 * index / sample_rate))
        for index in range(int(duration * sample_rate))
    ]
    output = io.BytesIO()
    with wave.open(output, "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(sample_rate)
        wav.writeframes(b"".join(struct.pack("<h", sample) for sample in samples))
    return output.getvalue()


def test_wav_speech_gate_rejects_silence_and_accepts_voice_level_audio():
    assert _wav_contains_speech(_test_wav(0), "audio/wav") is False
    assert _wav_contains_speech(_test_wav(0.018, duration=1.0), "audio/wav") is False
    assert _wav_contains_speech(_test_wav(0.08, duration=0.15), "audio/wav") is False
    assert _wav_contains_speech(_test_wav(0.08, duration=0.5), "audio/wav") is True
    assert _wav_contains_speech(b"compressed", "audio/webm") is None


def test_presentation_transcript_rejects_prompt_leakage_and_context_copy():
    context = (
        "你是ITN在线演示助手，正在和用户围绕一份正在播放的PPT实时交流。"
        "当前页结构：大模型Agent的核心概念与工程实践。"
    )
    assert _valid_presentation_transcript("这一页主要讲什么？", context)
    assert not _valid_presentation_transcript(
        "**你** 你是ITN在线演示助手，正在和用户围绕一份正在播放的PPT实时交流。",
        context,
    )
    copied = (
        "你是ITN在线演示助手正在和用户围绕一份正在播放的PPT实时交流"
        "当前页结构大模型Agent的核心概念与工程实践"
    )
    assert not _valid_presentation_transcript(copied, context)


def test_local_assistant_plan_opens_pages_without_llm():
    result = _local_assistant_plan("小鼋龙，帮我打开知识库")

    assert result["action"] == "navigation.open"
    assert result["arguments"] == {"page": "knowledge"}


def test_local_assistant_plan_switches_resource_tab():
    result = _local_assistant_plan("切换到定制讲义")

    assert result["action"] == "resource.switch_tab"
    assert result["arguments"] == {"tab": "lecture"}


def test_local_assistant_plan_changes_voice():
    result = _local_assistant_plan("小鼋龙，把声音换成茉莉")

    assert result["action"] == "assistant.voice.set"
    assert result["arguments"] == {"voice": "茉莉"}


def test_local_assistant_plan_sets_five_level_speed():
    result = _local_assistant_plan("小鼋龙，把语速调成极速")

    assert result is not None
    assert result["action"] == "assistant.speed.set"
    assert result["arguments"] == {"speed": "very_fast"}


def test_local_assistant_plan_adjusts_speed_relatively():
    result = _local_assistant_plan("再慢一点")

    assert result is not None
    assert result["action"] == "assistant.speed.adjust"
    assert result["arguments"] == {"direction": "slower"}


def test_local_assistant_plan_clamps_speed_above_supported_boundary():
    result = _local_assistant_plan("请切换到 2 倍速")

    assert result is not None
    assert result["arguments"] == {"speed": "very_fast"}
    assert "最高支持 1.2×" in result["reply"]


def test_local_assistant_plan_replies_to_greeting_without_claiming_unsupported():
    result = _local_assistant_plan("小鼋龙，你好！")

    assert result["action"] == "none"
    assert "很高兴见到你" in result["reply"]
    assert "不支持" not in result["reply"]


def test_local_assistant_plan_introduces_mascot():
    result = _local_assistant_plan("你是谁？")

    assert result["action"] == "none"
    assert "伴学助手" in result["reply"]


def test_local_assistant_plan_creates_presentation_task():
    result = _local_assistant_plan("帮我创建一份关于机器学习基础的PPT")

    assert result["action"] == "presentation.create"
    assert result["arguments"]["requirement"].startswith("帮我创建")
    assert result["arguments"]["title"] == "机器学习基础"


def test_local_assistant_plan_asks_for_detail_before_creating_vague_ppt():
    result = _local_assistant_plan("生成PPT")

    assert result["action"] == "none"
    assert "具体主题" in result["reply"]


def test_local_assistant_plan_creates_reviewable_note():
    result = _local_assistant_plan("帮我记下：依赖注入可以降低模块耦合")

    assert result["action"] == "notes.create"
    assert result["arguments"]["content"] == "依赖注入可以降低模块耦合"


def test_local_assistant_plan_searches_knowledge_base():
    result = _local_assistant_plan("在知识库中搜索 Spring Boot")

    assert result["action"] == "knowledge.search"
    assert result["arguments"] == {"query": "Spring Boot"}


def test_assistant_plan_sanitizes_presentation_options():
    result = _sanitize_assistant_plan({
        "action": "presentation.create",
        "arguments": {
            "requirement": "制作一份面向大学生的人工智能基础课程课件",
            "style": "unknown",
            "slideCount": 999,
        },
        "reply": "开始创建",
    })

    assert result["action"] == "presentation.create"
    assert result["arguments"]["style"] == "academic"
    assert result["arguments"]["slideCount"] == "0"


def test_json_string_progress_decodes_partial_reply():
    text, complete = _json_string_progress('{"reply":"你好，\\u4e1', "reply")
    assert text == "你好，"
    assert complete is False

    text, complete = _json_string_progress('{"reply":"你好，\\u4e16界。","action":"none"}', "reply")
    assert text == "你好，世界。"
    assert complete is True


def test_assistant_plan_rejects_unregistered_action():
    result = _sanitize_assistant_plan({
        "action": "browser.eval",
        "arguments": {"script": "alert(1)"},
        "reply": "执行脚本",
    })

    assert result["action"] == "none"
    assert result["arguments"] == {}


def test_assistant_plan_rejects_invalid_registered_arguments():
    result = _sanitize_assistant_plan({
        "action": "navigation.open",
        "arguments": {"page": "admin"},
        "reply": "打开管理后台",
    })

    assert result["action"] == "none"
