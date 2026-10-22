"""CLI entry point for the preprocessing pipeline.

NOTE (T5.3 唯一事实源收敛): the v1 pipeline module (``predeal.pipeline``) has
been retired and archived read-only under ``predeal/legacy/pipeline.py``.
The ``process`` command below no longer wires it up — use ``predeal2``
(``predeal.cli2:cli``, backed by ``predeal.pipeline2``) instead. Other
commands in this file (``domains`` / ``figures`` / ``info``) are unrelated
to the v1 pipeline and remain fully functional.
"""

from __future__ import annotations

from pathlib import Path

import click
from rich.console import Console
from rich.table import Table

from .config import load_domain_config, list_domains

console = Console()


@click.group()
def cli() -> None:
    """ITN Knowledge Core document preprocessing pipeline."""


@cli.command()
@click.option("--domain", required=True, help="Domain ID to process")
@click.option("--file", "file_filter", default=None, help="Filter to specific file name")
@click.option("--until", default=None, help="Stop after this step (for debugging)")
@click.option("--enable-ai", is_flag=True, help="Enable AI boundary planning")
@click.option("--output", "output_dir", default="output", help="Output directory")
@click.option("--domains-dir", default=None, help="Path to domains config directory")
@click.option("--ragflow-url", default=None, help="RAGFlow server URL (default: RAGFLOW_URL from .env)")
@click.option("--ragflow-key", default=None, help="RAGFlow API key (default: RAGFLOW_API_KEY from .env)")
@click.option("--dataset-name", default=None, help="Override RAGFlow dataset name")
@click.option("--storage-prefix", default=None, help="Image server storage prefix (e.g., ITN/hello_agents/chapter4)")
def process(
    domain: str,
    file_filter: str | None,
    until: str | None,
    enable_ai: bool,
    output_dir: str,
    domains_dir: str | None,
    ragflow_url: str,
    ragflow_key: str,
    dataset_name: str | None,
    storage_prefix: str | None,
) -> None:
    """[REMOVED] v1 pipeline retired — use ``predeal2 process`` instead."""
    console.print(
        "[bold red]Error:[/] the v1 pipeline (`predeal.pipeline`) was retired in "
        "T5.3 (唯一事实源收敛) and archived read-only under predeal/legacy/pipeline.py.\n"
        "Use [bold]predeal2 process[/] or [bold]predeal2 upload[/] instead "
        "(predeal.cli2:cli, backed by predeal.pipeline2)."
    )
    raise click.Abort()


@cli.command()
@click.option("--domains-dir", default=None, help="Path to domains config directory")
def domains(domains_dir: str | None) -> None:
    """List all available domains."""
    d_dir = Path(domains_dir) if domains_dir else None
    domain_list = list_domains(d_dir)

    if not domain_list:
        console.print("[yellow]No domains found.[/]")
        return

    table = Table(title="Available Domains")
    table.add_column("Domain ID", style="cyan")

    for d in domain_list:
        table.add_row(d)

    console.print(table)


@cli.command()
@click.option("--document-id", required=True, type=int, help="Document ID in database")
@click.option("--source-path", required=True, type=click.Path(exists=True), help="Source Markdown file")
@click.option("--storage-prefix", required=True, help="Storage prefix on image server (e.g., ITN/hello_agents/chapter4)")
def figures(document_id: int, source_path: str, storage_prefix: str) -> None:
    """Process images in a Markdown document.

    Downloads remote images, uploads to ITN image server,
    generates VLM descriptions, and creates normalized document.
    """
    from .images.pipeline import process_markdown_images

    source = Path(source_path)
    console.print(f"[bold]Processing images in:[/] {source}")
    console.print(f"[bold]Document ID:[/] {document_id}")
    console.print(f"[bold]Storage prefix:[/] {storage_prefix}")

    try:
        output_path = process_markdown_images(
            document_id=document_id,
            source_path=source,
            storage_prefix=storage_prefix,
        )
        console.print(f"\n[bold green]✓ Processing complete![/]")
        console.print(f"[bold]Output file:[/] {output_path}")
    except Exception as e:
        console.print(f"\n[bold red]✗ Processing failed:[/] {e}")
        raise click.Abort()


@cli.command()
@click.argument("domain_id")
@click.option("--domains-dir", default=None, help="Path to domains config directory")
def info(domain_id: str, domains_dir: str | None) -> None:
    """Show domain configuration details."""
    d_dir = Path(domains_dir) if domains_dir else None
    config = load_domain_config(domain_id, d_dir)

    console.print(f"[bold]Domain:[/] {config.domain_id}")
    console.print(f"[bold]Version:[/] {config.domain_version_id}")
    console.print(f"[bold]Profile:[/] {config.pipeline_profile}")
    console.print(f"[bold]Language:[/] {config.language}")
    console.print(f"[bold]Discovery root:[/] {config.discovery.root}")
    console.print(f"[bold]Include:[/] {config.discovery.include}")
    console.print(f"[bold]Exclude:[/] {config.discovery.exclude}")
    console.print(f"[bold]Chunk policy:[/] target={config.chunk_policy.target_min_chars}-{config.chunk_policy.target_max_chars}, hard_max={config.chunk_policy.hard_max_chars}")
    console.print(f"[bold]Figure policy:[/] download={config.figure_policy.download_remote_images}")
