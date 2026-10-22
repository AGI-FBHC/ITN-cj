"""稳定 rule_code 生成器（内容决定，与位置/时间无关）.

背景：domain_rule 的去重键是 rule_code（UNIQUE uk_rule_code），
upsert 靠 `ON DUPLICATE KEY UPDATE` 实现"重跑不产生重复"。
若 code 依赖位置（切片下标 / 抽取顺序），则：
  1. 同批不同规则撞码 → 互相覆盖（pipeline 旧实现的缺陷）
  2. 重跑时 code 漂移 → 同一规则产生新行 → 重复入库
因此 code 必须由**规则逻辑内容**确定性派生：

    rule_code = prefix + "-" + sha1(规范化(source_text + conclusions + 条件值集))[:10]

设计要点（2026-08-25 修订，修复跨 run 漂移）：
LLM 抽取非确定性——对同一句原文，两次抽取可能：
  - 给不同的条件**字段名**（implementation_type vs role，同义概念）
  - 给不同的**值大小写**（MCP_client vs mcp_client）
  - 给不同的 name（中文 vs 英文）
这些差异**不改变规则的逻辑含义**，但若都算进 hash 就会让同一条逻辑规则
拿到不同 code → 双双入库（实测 authorization 页产生 3 组真重复）。
因此 hash 只取**跨 run 稳定的逻辑维度**：
  - source_text：原文（折叠空白、去 markdown 加粗、小写）
  - conclusions：类型 + 内容（折叠空白、小写），排序去顺序依赖
  - 条件值集：(归一化值, 运算符, unit) 的集合（**不含字段名**），排序去顺序依赖
归一化值：小写 + 去首尾 + 折叠空白 + 去下划线/连字符
  （MCP_client / mcp-client / mcp client → mcpclient，统一同义写法）。
不同逻辑规则（不同原文 / 不同结论 / 不同条件值）→ 不同 code；
10 位 hex 碰撞概率 ~1e-12，MVP 可接受。
prefix 也参与 hash：同一逻辑规则来自不同文档/页面时保留为独立条目。
"""
from __future__ import annotations

import hashlib
import re
from typing import Any

from app.rule_engine.schemas import DomainRuleSchema


def _norm_text(s: str | None) -> str:
    """折叠全部连续空白为单空格（保留大小写，由调用方决定是否小写）."""
    return " ".join((s or "").split())


def _norm_key_text(s: str | None) -> str:
    """source_text / conclusion 内容 的 hash 归一化：去 markdown 加粗 + 折叠空白 + 小写 + 去末尾标点."""
    s = re.sub(r"\*+", "", s or "")
    s = _norm_text(s).lower()
    s = s.rstrip(".!?,;:。！？，；： ")  # 末尾标点漂移（LLM 有时带句号有时不带）
    return s


def _norm_value(v: Any) -> str:
    """条件值的 hash 归一化：bool→true/false；整值 float→int；
    字符串→小写+折叠空白+去下划线/连字符（统一 MCP_client/mcp-client/mcp client）."""
    if v is None:
        return ""
    if isinstance(v, bool):
        return "true" if v else "false"
    if isinstance(v, float) and v.is_integer():
        v = int(v)
    if isinstance(v, (int,)):
        return str(v)
    s = str(v).lower().strip()
    s = re.sub(r"[_\-\s]+", "", s)
    return s


def _cond_value_sig(rule: DomainRuleSchema) -> str:
    """条件值签名：只取 (归一化值, 运算符, 归一化unit) 集合，排序去顺序依赖.

    不含字段名：LLM 对同一逻辑条件会用不同字段名（role / implementation_type），
    字段名不改变规则逻辑含义，故不参与 hash。
    """
    parts = []
    for c in rule.conditions:
        val = _norm_value(c.value)
        op = (c.operator or "").strip().upper()
        unit = _norm_value(c.unit) if c.unit else ""
        parts.append(f"{val}\x01{op}\x01{unit}")
    return "\x02".join(sorted(parts))


def _concl_sig(rule: DomainRuleSchema) -> str:
    """结论签名：(类型, 归一化内容) 集合，排序去顺序依赖."""
    parts = [f"{(c.type or '').strip().upper()}\x01{_norm_key_text(c.content)}"
             for c in rule.conclusions]
    return "\x02".join(sorted(parts))


def canonical_rule_key(prefix: str, rule: DomainRuleSchema) -> str:
    """规则逻辑内容的规范化指纹（10 位 hex）."""
    src = _norm_key_text(rule.source_text)
    key = f"{prefix}\x00{_cond_value_sig(rule)}\x00{_concl_sig(rule)}\x00{src}"
    return hashlib.sha1(key.encode("utf-8")).hexdigest()[:10]


def stable_rule_code(prefix: str, rule: DomainRuleSchema) -> str:
    """生成稳定 rule_code。prefix 示例: 'MCP-lifecycle' / 'R38'.

    总长 ≤ 64（rule_code 列宽）：prefix ≤ 54 字符 + '-' + 10 hex。
    """
    code = f"{prefix}-{canonical_rule_key(prefix, rule)}"
    if len(code) > 64:
        # prefix 超长时截断 prefix 再重算（保持 hash 与 code 一致）
        prefix = prefix[:53]
        code = f"{prefix}-{canonical_rule_key(prefix, rule)}"[:64]
    return code
