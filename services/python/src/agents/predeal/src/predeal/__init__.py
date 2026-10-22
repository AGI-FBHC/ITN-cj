"""ITN Knowledge Core document preprocessing pipeline."""

from pathlib import Path

from dotenv import load_dotenv

# Load .env from agents/ directory (shared by KnowledgeCore and predeal)
_agents_dir = Path(__file__).resolve().parent.parent.parent.parent
load_dotenv(_agents_dir / ".env")
