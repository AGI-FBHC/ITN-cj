from app.config import Settings


def resolve_resource_group(
    settings: Settings,
    domain_code: str,
    node_code: str,
    requested_group: str = "",
) -> str:
    """Return the requested group name without rewriting or appending labels.

    Empty input resolves to `默认分组`; duplicate names are preserved.
    """
    return (requested_group or "").strip()[:100] or "默认分组"
