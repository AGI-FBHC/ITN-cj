import asyncio

from app.services.web_evidence_debate import WebEvidenceDebate


class FakeLlm:
    def __init__(self, result):
        self.result = result

    async def complete_json(self, *_args, **_kwargs):
        return self.result


def source(title, url, score=.82):
    return {"sourceType": "web", "document": title, "url": url, "content": f"{title} 对待验证主张提供直接说明。", "similarity": score, "snapshotType": "page_text"}


def test_two_independent_sources_are_admitted_after_debate():
    llm = FakeLlm({"claims": [{
        "claim": "某方法采用交替推理与行动", "revisedClaim": "某方法在原始论文所述任务中交替组织推理与行动",
        "supportSourceIds": [1, 2], "challengeSourceIds": [],
        "supportSummary": "原始论文与高校资料相互佐证。", "challengeSummary": "未发现直接反证。", "conditions": [],
    }]})
    admitted, archive = asyncio.run(WebEvidenceDebate(llm).run("某方法", [
        source("原始论文", "https://arxiv.org/paper"), source("高校课程", "https://example.edu/course"),
    ]))
    assert len(admitted) == 2
    assert all(item["debateVerified"] for item in admitted)
    assert archive["claims"][0]["verdict"] == "accepted"
    assert archive["scorecard"]["independentSourceCount"] == 2


def test_single_source_is_rejected_even_when_ranked_high():
    llm = FakeLlm({"claims": [{
        "claim": "未经交叉佐证的主张", "revisedClaim": "未经交叉佐证的主张",
        "supportSourceIds": [1], "challengeSourceIds": [],
        "supportSummary": "只有一个来源。", "challengeSummary": "缺少独立佐证。", "conditions": [],
    }]})
    admitted, archive = asyncio.run(WebEvidenceDebate(llm).run("单一来源", [source("官方页面", "https://docs.example.com/page", .95)]))
    assert admitted == []
    assert archive["claims"][0]["verdict"] == "rejected"


def test_challenge_source_forces_qualified_or_disputed_verdict():
    llm = FakeLlm({"claims": [{
        "claim": "宽泛结论", "revisedClaim": "仅在指定版本中成立的结论",
        "supportSourceIds": [1, 2], "challengeSourceIds": [3],
        "supportSummary": "两个独立来源支持。", "challengeSummary": "另一来源指出版本限制。", "conditions": ["仅适用于指定版本"],
    }]})
    admitted, archive = asyncio.run(WebEvidenceDebate(llm).run("版本结论", [
        source("官方文档", "https://docs.vendor.com/v2"), source("大学实验", "https://lab.example.edu/result"),
        source("版本说明", "https://release.example.org/note"),
    ]))
    assert archive["claims"][0]["verdict"] in {"qualified", "disputed"}
    if archive["claims"][0]["verdict"] == "qualified":
        assert len(admitted) == 2
