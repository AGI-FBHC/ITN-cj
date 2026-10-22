from app.services.agent_diagnosis import AgentDiagnosisService


def test_legacy_page_marker_is_not_part_of_user_speech():
    text = "[当前页面：/learn/resource/71106034-a6f9-4b0c-9a53-c65261bd9075] 这段代码为什么报错？"

    assert AgentDiagnosisService.clean_user_text(text) == "这段代码为什么报错？"


def test_free_question_prompt_requires_direct_answer_without_profile_talk():
    system, prompt = AgentDiagnosisService.build_ask_prompt(
        {"chapters": [], "resourceTotals": {"count": 0}},
        "free",
        "这个结论的依据是什么？",
    )

    assert "必须先直接回答" in system
    assert "禁止主动提及‘用户画像’" in system
    assert "自由提问必须就问题本身作答" in prompt
    assert "只回答学情类问题" not in prompt
