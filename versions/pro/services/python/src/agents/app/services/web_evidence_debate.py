"""Claim-level multi-source debate for Web evidence admitted after RAG fallback."""
from __future__ import annotations

import json
from collections import defaultdict
from urllib.parse import urlparse


class WebEvidenceDebate:
    """Turn Web search candidates into auditable accepted/rejected evidence."""

    def __init__(self, llm):
        self.llm = llm

    @staticmethod
    def _domain(source: dict) -> str:
        host = (urlparse(str(source.get("url") or "")).hostname or "unknown").lower()
        return host.removeprefix("www.")

    @classmethod
    def _authority(cls, source: dict) -> float:
        domain = cls._domain(source)
        text = f"{source.get('document') or ''} {domain}".lower()
        if domain.endswith((".gov", ".gov.cn", ".edu", ".edu.cn")):
            return .95
        if any(token in text for token in ("official", "官方", "documentation", "docs.", "标准", "论文", "arxiv.org", "acm.org", "ieee.org")):
            return .9
        if any(token in domain for token in ("github.com", "nature.com", "science.org", "springer.com", "microsoft.com", "google.com", "openai.com")):
            return .84
        if any(token in text for token in ("博客", "blog", "社区", "专栏")):
            return .62
        return .68

    @classmethod
    def _source_cards(cls, sources: list[dict]) -> list[dict]:
        groups: dict[str, int] = {}
        cards = []
        for index, source in enumerate(sources, 1):
            domain = cls._domain(source)
            group = groups.setdefault(domain, len(groups) + 1)
            authority = cls._authority(source)
            directness = min(.92, max(.55, float(source.get("similarity") or source.get("confidence") or .6)))
            score = round(.30 * authority + .25 * directness + .20 * 1.0 + .15 * .75 + .10 * (.9 if source.get("snapshotType") else .65), 3)
            cards.append({
                "sourceId": index, "title": source.get("document") or "补充资料", "url": source.get("url") or "",
                "publisher": domain, "independentGroup": f"source-{group}", "authority": authority,
                "directness": directness, "score": score, "quote": str(source.get("content") or "")[:900],
            })
        return cards

    async def _debate(self, topic: str, cards: list[dict]) -> dict:
        fallback = {
            "claims": [{
                "claim": topic, "revisedClaim": topic,
                "supportSourceIds": [item["sourceId"] for item in cards], "challengeSourceIds": [],
                "supportSummary": "多个独立来源提供了与主题相关的补充说明。",
                "challengeSummary": "仍需注意来源适用范围和表述边界。", "conditions": [],
            }]
        }
        compact = [{"sourceId": c["sourceId"], "title": c["title"], "publisher": c["publisher"], "quote": c["quote"]} for c in cards]
        result = await self.llm.complete_json(
            "你是多源证据辩论庭的议题书记员。只返回JSON；不得补充输入中没有的事实。",
            f"学习主题：{topic}\n候选来源：{json.dumps(compact, ensure_ascii=False)[:16000]}\n"
            "将资料拆成最多3项可验证知识主张。每项返回claim、revisedClaim、supportSourceIds、"
            "challengeSourceIds、supportSummary、challengeSummary、conditions。支持和质疑只能引用给定sourceId；"
            "如果来源只能支持更窄的说法，必须在revisedClaim中收窄，不得夸大结论。",
            fallback, provider="mimo", max_tokens=2200, max_retries=1, thinking=False,
        )
        return result if isinstance(result.get("claims"), list) and result["claims"] else fallback

    @staticmethod
    def _verdict(claim: dict, cards_by_id: dict[int, dict]) -> dict:
        support_ids = {int(item) for item in claim.get("supportSourceIds") or [] if str(item).isdigit()}
        challenge_ids = {int(item) for item in claim.get("challengeSourceIds") or [] if str(item).isdigit()}
        supports = [cards_by_id[item] for item in support_ids if item in cards_by_id]
        challenges = [cards_by_id[item] for item in challenge_ids if item in cards_by_id]
        independent = len({item["independentGroup"] for item in supports})
        support_weight = sum(float(item["score"]) for item in supports)
        challenge_weight = sum(float(item["score"]) for item in challenges)
        primary = any(float(item["authority"]) >= .88 for item in supports)
        confidence = round(min(.96, max(0.0, .42 + .12 * independent + .08 * int(primary) + .08 * support_weight - .10 * challenge_weight)), 3)
        conditions = [str(item) for item in claim.get("conditions") or [] if str(item).strip()]
        if independent >= 2 and confidence >= .78 and not challenges:
            verdict = "accepted"
        elif independent >= 2 and confidence >= .65 and support_weight > challenge_weight:
            verdict = "qualified"
            if not conditions:
                conditions = ["仅在现有来源明确覆盖的范围内采用"]
        elif supports and challenges:
            verdict = "disputed"
        else:
            verdict = "rejected"
        return {**claim, "verdict": verdict, "confidence": confidence, "conditions": conditions,
                "supportWeight": round(support_weight, 3), "challengeWeight": round(challenge_weight, 3),
                "independentSourceCount": independent}

    async def run(self, topic: str, web_sources: list[dict]) -> tuple[list[dict], dict]:
        cards = self._source_cards(web_sources)
        if not cards:
            return [], {"triggered": False, "name": "多源证据辩论庭", "claims": [], "sources": [], "scorecard": {}}
        raw = await self._debate(topic, cards)
        cards_by_id = {item["sourceId"]: item for item in cards}
        claims = [self._verdict(item, cards_by_id) for item in raw.get("claims") or [] if isinstance(item, dict)][:3]
        accepted_source_ids: set[int] = set()
        for claim in claims:
            if claim["verdict"] in {"accepted", "qualified"}:
                accepted_source_ids.update(int(item) for item in claim.get("supportSourceIds") or [] if str(item).isdigit())
        admitted = []
        verdict_by_source: dict[int, list[str]] = defaultdict(list)
        for claim in claims:
            for source_id in claim.get("supportSourceIds") or []:
                if str(source_id).isdigit():
                    verdict_by_source[int(source_id)].append(claim["verdict"])
        for index, source in enumerate(web_sources, 1):
            if index not in accepted_source_ids:
                continue
            card = cards_by_id[index]
            verdicts = verdict_by_source[index]
            admitted.append({**source, "debateSourceId": index, "debateVerified": True, "debateVerdict": "accepted" if "accepted" in verdicts else "qualified",
                             "debateConfidence": max((c["confidence"] for c in claims if index in c.get("supportSourceIds", [])), default=card["score"]),
                             "independentGroup": card["independentGroup"], "publisher": card["publisher"]})
        scorecard = {
            "claimCount": len(claims), "pageCount": len(web_sources),
            "independentSourceCount": len({item["independentGroup"] for item in cards}),
            "accepted": sum(item["verdict"] == "accepted" for item in claims),
            "qualified": sum(item["verdict"] == "qualified" for item in claims),
            "disputed": sum(item["verdict"] == "disputed" for item in claims),
            "rejected": sum(item["verdict"] == "rejected" for item in claims),
            "admittedSourceCount": len(admitted),
            "overallConfidence": round(sum(item["confidence"] for item in claims) / len(claims), 3) if claims else 0,
        }
        return admitted, {"triggered": True, "name": "多源证据辩论庭", "topic": topic,
                          "rounds": ["多源调查与独立来源归并", "交叉佐证、质疑与边界修正"],
                          "claims": claims, "sources": cards, "scorecard": scorecard}
