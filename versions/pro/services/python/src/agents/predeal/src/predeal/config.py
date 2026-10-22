"""Domain configuration loader."""

from pathlib import Path
from typing import Any, Dict, List, Optional, Union

import yaml
from pydantic import BaseModel, Field


_DEFAULT_DOMAINS_DIR = Path(__file__).parent.parent.parent / "domains"


# T3.8: 切分优先级序列的策略名 -> 实现在 steps/chunk_compiler.py 的
# _SPLIT_STRATEGIES 里注册；此处只保留可配置的顺序列表。默认顺序与历史行为
# 完全一致（未来新增策略只需在 chunk_compiler 里注册同名 key）。
DEFAULT_SPLIT_PRIORITY: List[str] = [
    "h4", "h23", "cn_num", "step_word", "h3_long", "bold_long", "paragraph",
]


class ChunkPolicy(BaseModel):
    target_min_chars: int = 300
    target_max_chars: int = 1200
    hard_max_chars: int = 1800
    preserve_code_block: bool = True
    preserve_table: bool = True
    preserve_figure: bool = True
    # LLM 语义辅助切分（仅无规则锚点的超长段触发，见 semantic_splitter.py）
    semantic_split: bool = False
    # T3.8: 规则切分策略尝试顺序（最后总有 "safe" 安全点硬切兜底，不在此列出）
    split_priority: List[str] = Field(default_factory=lambda: list(DEFAULT_SPLIT_PRIORITY))


class FigurePolicy(BaseModel):
    download_remote_images: bool = True
    enable_ocr: bool = False
    enable_vlm_summary: bool = True
    keep_decorative_images: bool = False
    enable_image_pipeline: bool = True
    storage_prefix: str = ""
    vlm_api_key: str = ""


class DiscoveryConfig(BaseModel):
    root: str
    include: List[str] = Field(default_factory=lambda: ["**/*.md"])
    exclude: List[str] = Field(default_factory=list)


class DomainConfig(BaseModel):
    domain_id: str
    domain_code: Optional[str] = None  # knowledge_domain.code in MySQL (falls back to domain_id)
    domain_version_id: str = "v1"
    pipeline_profile: str = "markdown_tutorial"
    language: str = "zh-CN"
    discovery: DiscoveryConfig
    chunk_policy: ChunkPolicy = Field(default_factory=ChunkPolicy)
    figure_policy: FigurePolicy = Field(default_factory=FigurePolicy)
    metadata_defaults: Dict[str, Any] = Field(default_factory=dict)


# T3.8: chunk_policy 按 pipeline_profile 分化。Only applied when a domain
# YAML does not explicitly set `chunk_policy` (see load_domain_config below) —
# domains with an explicit chunk_policy (e.g. hello_agents.yaml) are
# untouched, preserving existing behavior exactly.
PROFILE_PRESETS: Dict[str, ChunkPolicy] = {
    "markdown_tutorial": ChunkPolicy(target_min_chars=300, target_max_chars=1200, hard_max_chars=1800),
    "reference": ChunkPolicy(target_min_chars=150, target_max_chars=600, hard_max_chars=900),
    "faq": ChunkPolicy(target_min_chars=100, target_max_chars=800, hard_max_chars=1200),
}


def load_domain_config(
    domain_id: str,
    domains_dir: Optional[Union[Path, str]] = None,
) -> DomainConfig:
    """Load a domain configuration from YAML file."""
    domains_path = Path(domains_dir) if domains_dir else _DEFAULT_DOMAINS_DIR
    config_file = domains_path / f"{domain_id}.yaml"
    if not config_file.exists():
        raise FileNotFoundError(
            f"Domain config not found: {config_file}\n"
            f"Available domains: {[f.stem for f in domains_path.glob('*.yaml')]}"
        )
    with open(config_file, encoding="utf-8") as f:
        data = yaml.safe_load(f)
    config = DomainConfig(**data)
    if "chunk_policy" not in data:
        preset = PROFILE_PRESETS.get(config.pipeline_profile)
        if preset is not None:
            config.chunk_policy = preset.model_copy(deep=True)
    return config


def list_domains(domains_dir: Optional[Union[Path, str]] = None) -> List[str]:
    """List all available domain IDs."""
    domains_path = Path(domains_dir) if domains_dir else _DEFAULT_DOMAINS_DIR
    if not domains_path.exists():
        return []
    return sorted(f.stem for f in domains_path.glob("*.yaml"))


def resolve_discovery_root(config: DomainConfig, config_dir: Optional[Path] = None) -> Path:
    """Resolve the discovery root to an absolute path.

    The domain YAML may use a relative root (e.g. ``../../../itn_source/...``)
    which only resolves when the repo sits at a specific depth relative to the
    source tree. If the literal resolution does not exist, we walk up from the
    domains directory looking for the first directory component of the root
    (e.g. ``itn_source``) and rebuild the path from there.
    """
    root = Path(config.discovery.root)
    if root.is_absolute():
        return root
    # Resolve relative to the domains directory
    base = config_dir or _DEFAULT_DOMAINS_DIR
    resolved = (base / root).resolve()
    if resolved.exists():
        return resolved
    # Fallback: walk up the tree and look for the leading component
    head, *tail = root.parts
    for parent in base.parents:
        candidate = (parent / head / Path(*tail))
        if candidate.exists():
            return candidate.resolve()
        if parent.parent == parent:
            break
    return resolved
