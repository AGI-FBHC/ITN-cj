import asyncio

from app.services.evidence_search import EvidenceSearch, compact_web_sources, filter_rag_sources_by_chapter


class FakeTool:
    def __init__(self, result, available=True):
        self.result = result
        self.available = available
        self.calls = []

    async def execute(self, params):
        self.calls.append(params)
        return self.result


def test_strong_rag_evidence_does_not_call_web_search():
    rag = FakeTool({"success": True, "chunks": [
        {"document": "教材", "content": "原文1", "similarity": .72, "chunk_id": "c1"},
        {"document": "教材", "content": "原文2", "similarity": .61, "chunk_id": "c2"},
    ]})
    web = FakeTool({"success": True, "results": []})

    sources, metadata = asyncio.run(EvidenceSearch(rag, web).retrieve("ReAct"))

    assert len(sources) == 2
    assert all(source["sourceType"] == "knowledge_base" for source in sources)
    assert metadata["webFallbackUsed"] is False
    assert metadata["toolsUsed"] == ["rag_search"]
    assert web.calls == []


def test_supplement_web_does_not_replace_strong_rag():
    rag = FakeTool({"success": True, "chunks": [
        {"document": "教材", "content": "原文1", "similarity": .72, "chunk_id": "c1"},
        {"document": "教材", "content": "原文2", "similarity": .61, "chunk_id": "c2"},
    ]})
    web = FakeTool({"success": True, "results": [
        {"title": "网页摘要", "url": "https://example.test/agent", "content": "搜索摘要"},
    ]})
    fetch = FakeTool({"success": True, "title": "网页正文", "content": "这是抓取后的完整网页正文。"})

    sources, metadata = asyncio.run(EvidenceSearch(rag, web, fetch).retrieve(
        "Agent", supplement_web=True,
    ))

    assert metadata["webFallbackUsed"] is False
    assert all(source["sourceType"] == "knowledge_base" for source in sources)
    assert web.calls == []


def test_mysql_slices_do_not_use_web_when_sufficient():
    rag = FakeTool({"success": True, "chunks": []})
    web = FakeTool({"success": True, "results": [
        {"title": "网页教程", "url": "https://example.test/web", "content": "网页证据"},
    ]})
    fetch = FakeTool({"success": True, "title": "网页正文", "content": "这是抓取后的完整网页正文。"})
    mysql = FakeTool({"success": True, "chunks": [
        {"document": "教材", "content": "这是课程知识库切片正文。", "similarity": 0.92,
         "chunk_id": "c-mysql", "knowledgeChunkId": 42},
        {"document": "教材", "content": "这是另一条课程知识库切片正文。", "similarity": 0.86,
         "chunk_id": "c-mysql-2", "knowledgeChunkId": 43},
    ]})

    sources, metadata = asyncio.run(EvidenceSearch(rag, web, fetch, mysql_tool=mysql).retrieve(
        "传统Agent", kp_id="kp-1", supplement_web=True,
    ))

    assert all(source["sourceType"] == "knowledge_base" for source in sources)
    assert sources[0]["knowledgeChunkId"] == 42
    assert metadata["toolsUsed"] == ["mysql_search"]
    assert rag.calls == []
    assert web.calls == []


def test_weak_rag_evidence_uses_web_search_fallback():
    rag = FakeTool({"success": True, "chunks": [
        {"document": "不相关教材", "content": "弱命中", "similarity": .24, "chunk_id": "weak"},
    ]})
    web = FakeTool({"success": True, "results": [
        {"title": "操作系统教程", "url": "https://example.test/os", "content": "进程调度与虚拟内存"},
        {"title": "虚拟内存示例", "url": "https://example.test/vm", "content": "页表与缺页中断"},
    ]})

    sources, metadata = asyncio.run(EvidenceSearch(rag, web).retrieve("操作系统"))

    assert [source["sourceType"] for source in sources] == ["web", "web"]
    assert [source["id"] for source in sources] == [1, 2]
    assert sources[0]["confidence"] == .76
    assert metadata["webFallbackUsed"] is True
    assert metadata["toolsUsed"] == ["rag_search", "web_search"]


def test_rag_only_search_never_uses_web_fallback():
    rag = FakeTool({"success": True, "chunks": []})
    web = FakeTool({"success": True, "results": [{"title": "网页", "url": "https://example.test", "content": "网页证据"}]})
    web.available = True
    sources, metadata = asyncio.run(EvidenceSearch(rag, web).retrieve("Agent", allow_web_fallback=False))
    assert sources == []
    assert metadata["webFallbackUsed"] is False
    assert "web_search" not in metadata["toolsUsed"]
    assert web.calls == []


def test_web_search_failure_keeps_available_rag_results():
    rag = FakeTool({"success": True, "chunks": [
        {"document": "教材", "content": "唯一命中", "similarity": .41, "chunk_id": "c1"},
    ]})
    web = FakeTool({"success": False, "error": "temporary outage"})

    sources, metadata = asyncio.run(EvidenceSearch(rag, web).retrieve("主题"))

    assert len(sources) == 1
    assert sources[0]["chunkId"] == "c1"
    assert metadata["webFallbackUsed"] is False


def test_web_confidence_is_rank_based_and_bounded():
    sources = compact_web_sources({"results": [
        {"title": str(index), "url": "https://example.test", "content": "资料"}
        for index in range(10)
    ]}, limit=10)
    assert sources[0]["confidence"] == .76
    assert sources[-1]["confidence"] == .55
    assert all(source["sourceType"] == "web" for source in sources)


def test_chapter_filter_drops_cross_chapter_rag_hits_but_keeps_web_sources():
    sources = [
        {"sourceType": "knowledge_base", "document": "第四章.md", "content": "# 第四章 智能体经典范式构建"},
        {"sourceType": "knowledge_base", "document": "第一章.md", "content": "# 第一章 初识智能体"},
        {"sourceType": "web", "document": "网页教程", "content": "外部补充"},
    ]
    filtered = filter_rag_sources_by_chapter(
        sources, "智能体构建 / 第四章 智能体经典范式构建 / ReAct工作流程",
    )
    assert [source["document"] for source in filtered] == ["第四章.md", "网页教程"]
