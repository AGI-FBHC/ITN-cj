"""Read-only vendor audit. Never writes to lumin or copies upstream files blindly."""
from pathlib import Path
import hashlib
import sys

repo = Path(__file__).resolve().parents[1]
pairs = [("pi", "pi"), ("tools", "pi_tools")]
files = [(repo / "lumin/src" / a / p.name, repo / "core/src" / b / p.name)
         for a, b in pairs for p in sorted((repo / "lumin/src" / a).glob("*.cj"))]
files += [(repo / "lumin/src/cli" / n, repo / "core/src/lumin_cli" / n)
          for n in ("permissions.cj", "trust.cj", "util.cj", "workspaces.cj", "approvals.cj")]
failed = 0
for upstream, local in files:
    if not upstream.exists() or not local.exists():
        print("MISSING", upstream.name)
        failed += 1
        continue
    source = upstream.read_text(encoding="utf-8")
    for a, b in (("lumin.pi", "itn_desktop_core.pi"), ("lumin.tools", "itn_desktop_core.pi_tools"),
                 ("lumin.cli", "itn_desktop_core.lumin_cli")):
        source = source.replace(a, b)
    actual = local.read_text(encoding="utf-8")
    # Documented host-only extension: staged acquisition shares the web approval gate.
    if upstream.name == "approvals.cj":
        actual = actual.replace(' || name == "kb_stage"', '')
    same = source == actual
    print("PASS" if same else "DRIFT", local.relative_to(repo), hashlib.sha256(source.encode()).hexdigest()[:12])
    failed += not same
if len(files) != 23:
    print("DRIFT upstream file inventory changed; review added or removed modules")
    failed += 1
print(f"RESULT {len(files) - failed}/{len(files)} normalized vendor files match")
sys.exit(1 if failed else 0)
