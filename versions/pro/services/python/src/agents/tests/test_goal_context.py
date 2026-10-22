from app.services.goal_context import GoalContextService


def test_recommendation_uses_observed_weakness():
    goal = {"title": "智能体工程", "expectedLevel": "PROFICIENT", "initialLevel": "BEGINNER"}
    mastery = [
        {"name": "工具调用", "score": .35, "attempts": 4},
        {"name": "记忆机制", "score": .8, "attempts": 3},
    ]
    result = GoalContextService._recommend(goal, {"learningPreference": "PRACTICAL"}, mastery, [])
    assert result["topic"] == "工具调用"
    assert result["ability"] == .35
    assert result["difficulty"] == "foundation"


def test_recommendation_cold_start_prefers_covered_point():
    goal = {"title": "智能体工程", "expectedLevel": "PROFICIENT", "initialLevel": "ELEMENTARY"}
    covered = [{"name": "ReAct 循环", "level": 3}]
    result = GoalContextService._recommend(goal, {}, [], covered)
    assert result["topic"] == "ReAct 循环"
    assert result["ability"] == .32
    assert result["questionCount"] == 9
    assert result["ppt"]["slideCount"] == 20


def test_recommendation_advances_after_high_mastery():
    goal = {"title": "智能体工程", "expectedLevel": "PROFICIENT", "initialLevel": "BEGINNER"}
    mastery = [{"name": "规划", "score": .78, "attempts": 5}]
    result = GoalContextService._recommend(goal, {}, mastery, [])
    assert result["nextResourceType"] == "quiz"
    assert result["difficulty"] == "challenge"
    assert result["ppt"]["slideCount"] == 12
