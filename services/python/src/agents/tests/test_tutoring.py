from app.config import get_settings
from app.services.tutoring import TutoringService


def test_tutoring_scripts_cover_demo_learners():
    service = TutoringService(get_settings())
    scripts = service.scripts()
    codes = {script["learnerId"] for script in scripts}
    assert {"lin", "chen", "zhao"} <= codes
    for script in scripts:
        assert script["startId"] in script["nodes"]
        assert script["kpId"]


def test_tutoring_enter_node_adds_decision_and_end_message():
    service = TutoringService(get_settings())
    script = service.get_script("lin")
    assert script is not None
    messages: list[dict] = []
    decisions: list[dict] = []
    messages, decisions, level, current_node = service._enter_node(
        messages, decisions, 2, script, "n2b",
    )
    assert any(message["kind"] == "decision" for message in messages)
    assert decisions[0]["type"] == "simplify"
    assert level == 1

    messages, decisions, level, current_node = service._enter_node(
        messages, decisions, level, script, "n4",
    )
    assert current_node is None
    assert any(message["kind"] == "summary" for message in messages)


def test_dynamic_tutoring_script_uses_real_quiz_questions():
    resource = {
        "id": "4c96ecf1-50bf-4c3e-81bc-2e58fd395b31",
        "type": "quiz",
        "title": "算法复杂度分阶题",
        "topic": "复杂度分析",
        "kpId": "kp-ds",
        "kbRefs": ["KB-DS-001"],
        "content": {
            "knowledgePoints": [{"id": "kp-ds", "name": "时间复杂度", "description": "渐进复杂度"}],
            "questions": [
                {
                    "id": "q-real-1",
                    "stem": "二分查找的时间复杂度是什么？",
                    "options": ["O(1)", "O(log n)", "O(n)"],
                    "correctIndex": 1,
                    "explanation": "每轮都把搜索区间减半。",
                    "difficulty": "基础",
                    "kbRefs": ["KB-DS-002"],
                },
                {
                    "id": "q-real-2",
                    "stem": "双重独立循环的复杂度是什么？",
                    "options": ["O(n)", "O(log n)", "O(n²)"],
                    "correctIndex": 2,
                    "explanation": "两层循环次数相乘。",
                    "difficulty": "进阶",
                },
            ],
        },
    }

    script = TutoringService._script_from_quiz(resource)

    assert script is not None
    assert script["resourceId"] == resource["id"]
    assert script["startId"] == "q1"
    assert script["nodes"]["q1"]["tutor"] == "二分查找的时间复杂度是什么？"
    assert script["nodes"]["q1"]["options"][1]["correct"] is True
    assert script["nodes"]["q1"]["options"][0]["next"] == "q1-explain"
    assert script["nodes"]["q1-explain"]["decision"] == "simplify"
    assert script["nodes"]["q2"]["options"][2]["next"] == "summary"
    assert script["nodes"]["summary"]["end"] is True
    assert script["topics"][0]["name"] == "时间复杂度"


def test_dynamic_tutoring_script_rejects_non_quiz_resource():
    assert TutoringService._script_from_quiz({"id": "x", "type": "lecture", "content": {}}) is None


def test_tutoring_free_text_matches_nearest_option_without_guessing():
    options = [
        {"label": "调度器", "correct": True},
        {"label": "报告生成器", "correct": False},
    ]

    assert TutoringService._match_free_text("我认为核心组件是调度器", options) == options[0]
    assert TutoringService._match_free_text("完全不相关的回答", options) is None


def test_dynamic_topic_name_replaces_machine_identifier():
    resource = {"topic": "评测系统架构与验证机制", "title": "分阶题"}
    assert TutoringService._topic_name({"name": "agent_evaluation_system_architecture"}, resource, 0) == "评测系统架构与验证机制"
    assert TutoringService._topic_name({"categoryName": "调度器设计"}, resource, 1) == "调度器设计"
