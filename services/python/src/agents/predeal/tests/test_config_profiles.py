"""T3.8 chunk_policy 按 profile 分化."""

from __future__ import annotations

from pathlib import Path

from predeal.config import PROFILE_PRESETS, load_domain_config

_DOMAINS_DIR = Path(__file__).parent.parent / "domains"


def test_hello_agents_explicit_chunk_policy_unchanged():
    """hello_agents.yaml 显式声明了 chunk_policy -> preset 不生效，行为不变。"""
    config = load_domain_config("hello_agents", _DOMAINS_DIR)
    assert config.chunk_policy.target_min_chars == 300
    assert config.chunk_policy.target_max_chars == 1200
    assert config.chunk_policy.hard_max_chars == 1800


def test_cs_base_explicit_chunk_policy_unchanged():
    config = load_domain_config("cs_base", _DOMAINS_DIR)
    assert config.chunk_policy.target_min_chars == 200
    assert config.chunk_policy.target_max_chars == 1000
    assert config.chunk_policy.hard_max_chars == 1500


def test_reference_profile_without_explicit_chunk_policy_uses_preset(tmp_path):
    domains_dir = tmp_path / "domains"
    domains_dir.mkdir()
    (domains_dir / "ref_test.yaml").write_text(
        "domain_id: ref_test\n"
        "domain_version_id: v1\n"
        "pipeline_profile: reference\n"
        "language: zh-CN\n"
        "discovery:\n"
        "  root: .\n"
        "  include: [\"*.md\"]\n",
        encoding="utf-8",
    )
    config = load_domain_config("ref_test", domains_dir)
    preset = PROFILE_PRESETS["reference"]
    assert config.chunk_policy.target_min_chars == preset.target_min_chars == 150
    assert config.chunk_policy.target_max_chars == preset.target_max_chars == 600
    assert config.chunk_policy.hard_max_chars == preset.hard_max_chars == 900


def test_faq_profile_without_explicit_chunk_policy_uses_preset(tmp_path):
    domains_dir = tmp_path / "domains"
    domains_dir.mkdir()
    (domains_dir / "faq_test.yaml").write_text(
        "domain_id: faq_test\n"
        "domain_version_id: v1\n"
        "pipeline_profile: faq\n"
        "language: zh-CN\n"
        "discovery:\n"
        "  root: .\n"
        "  include: [\"*.md\"]\n",
        encoding="utf-8",
    )
    config = load_domain_config("faq_test", domains_dir)
    preset = PROFILE_PRESETS["faq"]
    assert config.chunk_policy.target_min_chars == preset.target_min_chars == 100
    assert config.chunk_policy.target_max_chars == preset.target_max_chars == 800
    assert config.chunk_policy.hard_max_chars == preset.hard_max_chars == 1200


def test_explicit_chunk_policy_overrides_preset(tmp_path):
    """即使 profile 有预设，yaml 显式给出的 chunk_policy 优先生效。"""
    domains_dir = tmp_path / "domains"
    domains_dir.mkdir()
    (domains_dir / "custom.yaml").write_text(
        "domain_id: custom\n"
        "domain_version_id: v1\n"
        "pipeline_profile: reference\n"
        "language: zh-CN\n"
        "discovery:\n"
        "  root: .\n"
        "  include: [\"*.md\"]\n"
        "chunk_policy:\n"
        "  target_min_chars: 50\n"
        "  target_max_chars: 400\n"
        "  hard_max_chars: 700\n",
        encoding="utf-8",
    )
    config = load_domain_config("custom", domains_dir)
    assert config.chunk_policy.target_min_chars == 50
    assert config.chunk_policy.target_max_chars == 400
    assert config.chunk_policy.hard_max_chars == 700


def test_unknown_profile_without_explicit_chunk_policy_keeps_default(tmp_path):
    """没有预设的 profile（且未显式给 chunk_policy）-> 保留 ChunkPolicy 默认值。"""
    domains_dir = tmp_path / "domains"
    domains_dir.mkdir()
    (domains_dir / "other.yaml").write_text(
        "domain_id: other\n"
        "domain_version_id: v1\n"
        "pipeline_profile: markdown_reference\n"
        "language: zh-CN\n"
        "discovery:\n"
        "  root: .\n"
        "  include: [\"*.md\"]\n",
        encoding="utf-8",
    )
    config = load_domain_config("other", domains_dir)
    assert config.chunk_policy.target_min_chars == 300
    assert config.chunk_policy.target_max_chars == 1200
    assert config.chunk_policy.hard_max_chars == 1800
