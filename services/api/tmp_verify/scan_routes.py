"""Static scan: compare Spire local routes against Python / Java upstream routes.

Read-only. Prints three difference sets per upstream so we can decide what is
migratable. Placeholder params are normalised to `{}`.
"""
import re
import os
import glob

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "..", ".."))
API_SRC = os.path.join(ROOT, "ITN-cj-main", "services", "api", "src")
PY_ROUTERS = os.path.join(ROOT, "src", "agents", "app", "routers")
JAVA_WEB = os.path.join(ROOT, "src", "backend", "src", "main", "java", "com", "itn", "backend", "web")


def norm(path: str) -> str:
    # Python {x} / Java {x} / Spire {x} and {*rest} -> {}
    p = re.sub(r"\{[^}]*\}", "{}", path)
    if p != "/" and p.endswith("/"):
        p = p[:-1]
    if not p.startswith("/"):
        p = "/" + p
    return p


# ---------- Spire local routes ----------
spire = {}  # (method, normpath) -> "file:line"
for f in glob.glob(os.path.join(API_SRC, "*.cj")):
    if os.path.basename(f) == "gateway.cj":
        continue
    text = open(f, encoding="utf-8").read()
    for m in re.finditer(r'app\.map(Get|Post|Put|Delete|Patch)?\(\s*"([^"]+)"', text):
        verb = (m.group(1) or "ANY").upper()
        line = text[: m.start()].count("\n") + 1
        spire[(verb, norm(m.group(2)))] = f"{os.path.basename(f)}:{line}"

# gateway catch-alls
for m in re.finditer(r'app\.map\(\s*"([^"]+)"', open(os.path.join(API_SRC, "gateway.cj"), encoding="utf-8").read()):
    spire[("ANY", norm(m.group(1)))] = "gateway.cj"

spire_paths = {p for (v, p) in spire}

# ---------- Python routes ----------
py = {}
for f in [os.path.join(PY_ROUTERS, "public.py"), os.path.join(PY_ROUTERS, "internal.py")]:
    text = open(f, encoding="utf-8").read()
    pre = re.search(r'APIRouter\(prefix="([^"]+)"', text).group(1)
    for m in re.finditer(r'@router\.(get|post|put|delete|patch)\(\s*"([^"]*)"', text):
        verb = m.group(1).upper()
        full = pre + m.group(2)
        line = text[: m.start()].count("\n") + 1
        py[(verb, norm(full))] = f"{os.path.basename(f)}:{line}"

# ---------- Java routes ----------
java = {}
for f in glob.glob(os.path.join(JAVA_WEB, "*Controller.java")):
    text = open(f, encoding="utf-8").read()
    cm = re.search(r'@RequestMapping\(\s*(?:value\s*=\s*)?"([^"]*)"', text)
    base = cm.group(1) if cm else ""
    # only literal method mappings; skip class-level @RequestMapping with /**
    for m in re.finditer(r'@(Get|Post|Put|Delete|Patch)Mapping\(\s*(?:value\s*=\s*)?(?:"/\*\*"\s*,\s*)?(?:value\s*=\s*)?"([^"]*)"', text):
        verb = m.group(1).upper()
        full = base + m.group(2)
        if "**" in full:
            continue
        line = text[: m.start()].count("\n") + 1
        java[(verb, norm(full))] = f"{os.path.basename(f)}:{line}"

# ---------- differences ----------
def report(name, upstream):
    missing = []
    covered = 0
    for key, loc in sorted(upstream.items(), key=lambda kv: (kv[0][1], kv[0][0])):
        verb, path = key
        hit = path in spire_paths
        if hit:
            covered += 1
        else:
            missing.append((verb, path, loc))
    print(f"\n==== {name}: {len(upstream)} routes, {covered} covered by a Spire path, {len(missing)} NOT covered ====")
    for verb, path, loc in missing:
        print(f"  {verb:6} {path:55} {loc}")


report("PYTHON /v1 + /internal/v1", py)
report("JAVA /api/v1", java)

print(f"\nSpire local route entries: {len(spire)} (unique paths {len(spire_paths)})")
