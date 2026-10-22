"""CLI entry point for the preprocessing pipeline."""

from __future__ import annotations

import os
from pathlib import Path

import click
from rich.console import Console
from rich.table import Table

from .config import load_domain_config, list_domains
from .pipeline2 import PipelineOptions, process_document, process_domain
from .ragflow_client import RAGFlowConfig

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
@click.option("--storage-prefix", default=None, help="Image server storage prefix (e.g., ITN/hello_agents/chapter6)")
@click.option("--force", is_flag=True, help="Re-run all steps even if content is unchanged")
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
    force: bool,
) -> None:
    """Process documents in a domain (RAGFlow upload always enabled)."""
    ragflow_url = ragflow_url or os.environ.get("RAGFLOW_URL", "")
    ragflow_key = ragflow_key or os.environ.get("RAGFLOW_API_KEY", "")
    if not ragflow_url or not ragflow_key:
        console.print("[bold red]Error:[/] RAGFLOW_URL and RAGFLOW_API_KEY must be set in .env or via CLI options")
        raise click.Abort()

    ragflow_config = RAGFlowConfig(base_url=ragflow_url, api_key=ragflow_key)

    opts = PipelineOptions(
        until=until,
        enable_ai=enable_ai,
        ragflow_config=ragflow_config,
        dataset_name=dataset_name,
        storage_prefix=storage_prefix,
        force=force,
    )
    out = Path(output_dir)
    d_dir = Path(domains_dir) if domains_dir else None

    console.print(f"[bold]Processing domain:[/] {domain}")
    if file_filter:
        console.print(f"[bold]File filter:[/] {file_filter}")
    console.print(f"[bold]RAGFlow upload:[/] {ragflow_url}")

    results = process_domain(domain, out, opts, d_dir, file_filter)

    table = Table(title="Processing Results")
    table.add_column("Document", style="cyan")
    table.add_column("Status", style="bold")
    table.add_column("Chunks", justify="right")
    table.add_column("Figures", justify="right")
    table.add_column("RAGFlow", style="magenta")
    table.add_column("Errors")

    for r in results:
        status_style = "green" if r.status in ("passed", "passed_with_warnings") else "red"
        rf_status = "-"
        if r.ragflow_result:
            rf_status = r.ragflow_result.get("status", "-")
        table.add_row(
            r.document_id,
            f"[{status_style}]{r.status}[/{status_style}]",
            str(r.chunk_count),
            str(r.figure_count),
            rf_status,
            "; ".join(r.errors) if r.errors else "-",
        )

    console.print(table)

    # Show RAGFlow details if uploaded
    for r in results:
        if r.ragflow_result and r.ragflow_result.get("dataset_id"):
            console.print(f"\n[bold green]RAGFlow dataset:[/] {r.ragflow_result['dataset_name']} (id: {r.ragflow_result['dataset_id']})")
            if r.ragflow_result.get("document_id"):
                console.print(f"[bold green]RAGFlow document:[/] {r.ragflow_result['document_id']}")


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
@click.argument("file_path", type=click.Path(exists=True))
@click.option("--domain", required=True, help="Domain ID (e.g. hello_agents)")
@click.option("--title", default=None, help="Document title (default: file name)")
@click.option("--document-type", default=None, help="course_markdown / 教材 / 论文 / 企业文档")
@click.option("--source-type", default="upload", help="upload / web / github / api")
@click.option("--source-name", default=None, help="Source name (default: file name)")
@click.option("--publisher", default=None, help="Publisher")
@click.option("--publish-year", type=int, default=None, help="Publish year")
@click.option("--version", default=None, help="Document version")
@click.option("--reliability-score", type=float, default=None, help="Reliability score 0..1")
@click.option("--language", default="zh-CN", help="Language (default: zh-CN)")
@click.option("--storage-prefix", default=None, help="Image server storage prefix")
@click.option("--no-ragflow", is_flag=True, help="Skip RAGFlow sync")
@click.option("--dataset-name", default=None, help="Override RAGFlow dataset name")
@click.option("--no-vlm", is_flag=True, help="Skip VLM image descriptions")
@click.option("--no-classify", is_flag=True, help="Skip LLM category classification")
@click.option("--force", is_flag=True, help="Re-run all steps even if content unchanged")
def upload(
    file_path: str,
    domain: str,
    title: str | None,
    document_type: str | None,
    source_type: str,
    source_name: str | None,
    publisher: str | None,
    publish_year: int | None,
    version: str | None,
    reliability_score: float | None,
    language: str,
    storage_prefix: str | None,
    no_ragflow: bool,
    dataset_name: str | None,
    no_vlm: bool,
    no_classify: bool,
    force: bool,
) -> None:
    """Upload a single document into the knowledge base (full predeal flow).

    The file is staged under <discovery_root>/uploads/ so re-uploads are
    idempotent and same-name edits become incremental updates.
    """
    from .upload_service import UploadOptions, upload_document_file

    if not os.environ.get("RAGFLOW_URL") or not os.environ.get("RAGFLOW_API_KEY"):
        console.print("[bold red]Error:[/] RAGFLOW_URL and RAGFLOW_API_KEY must be set in .env")
        raise click.Abort()

    opts = UploadOptions(
        domain_id=domain,
        title=title,
        document_type=document_type,
        source_type=source_type,
        source_name=source_name,
        publisher=publisher,
        publish_year=publish_year,
        version=version,
        reliability_score=reliability_score,
        language=language,
        storage_prefix=storage_prefix,
        enable_ragflow=not no_ragflow,
        dataset_name=dataset_name,
        enable_vlm=not no_vlm,
        enable_classify=not no_classify,
        force=force,
        progress_callback=lambda ev: console.print(
            f"  [{'✔' if ev.status=='end' else '•'}][{ev.step_num:02d}] "
            f"{ev.step_name}: {ev.message}"
        ),
    )
    console.print(f"[bold]Uploading:[/] {file_path} -> domain {domain}")
    result = upload_document_file(Path(file_path), opts)

    if result.status == "failed":
        console.print("[bold red]FAILED[/]")
        for e in result.errors:
            console.print(f"  [red]- {e}[/]")
        raise click.Abort()

    status_style = "green" if result.status in ("passed", "passed_with_warnings", "reused") else "yellow"
    console.print(f"\n[bold]Status:[/] [{status_style}]{result.status}[/]")
    console.print(f"  document_key : {result.document_key}")
    console.print(f"  db id        : {result.db_document_id}")
    console.print(f"  document id  : {result.document_id}")
    console.print(f"  chunks       : {result.chunk_count}  (sync: {result.sync_report})")
    console.print(f"  figures      : {result.figure_count}")
    if result.ragflow_result:
        console.print(f"  ragflow      : {result.ragflow_result.get('status')}  "
                      f"doc={result.ragflow_result.get('document_id')}")
    if result.artifacts_dir:
        console.print(f"  artifacts    : {result.artifacts_dir}")


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


if __name__ == "__main__":
    cli()
