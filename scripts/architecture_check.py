from __future__ import annotations

import ast
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
BACKEND = ROOT / "backend" / "app"
FRONTEND = ROOT / "frontend"
errors: list[str] = []

forbidden = {
    "modules/data_twin": (
        "backend.app.modules.intelligence",
        "backend.app.modules.decision_control",
        "backend.app.modules.llm_agent",
    ),
    "modules/intelligence": (
        "backend.app.modules.decision_control",
        "backend.app.modules.llm_agent",
    ),
    "modules/decision_control": ("backend.app.modules.llm_agent",),
}

for path in BACKEND.rglob("*.py"):
    source = path.read_text(encoding="utf-8")
    try:
        tree = ast.parse(source, filename=str(path))
    except SyntaxError as exc:
        errors.append(f"Python syntax: {path}: {exc}")
        continue
    rel = path.relative_to(BACKEND).as_posix()
    denied_imports = ()
    for prefix, denied in forbidden.items():
        if rel.startswith(prefix):
            denied_imports = denied
            break
    for node in ast.walk(tree):
        if isinstance(node, ast.ImportFrom):
            module = node.module or ""
            for denied in denied_imports:
                if module.startswith(denied):
                    errors.append(f"Architecture boundary: {rel} imports {module}")
        elif isinstance(node, ast.Import):
            for alias in node.names:
                for denied in denied_imports:
                    if alias.name.startswith(denied):
                        errors.append(f"Architecture boundary: {rel} imports {alias.name}")

for path in FRONTEND.rglob("*.js"):
    text = path.read_text(encoding="utf-8")
    if re.search(r"backend/app|backend\.app", text):
        errors.append(f"Frontend boundary: {path.relative_to(ROOT)} references backend internals")

suspicious = re.compile(r"(NIM_API_KEY\s*=\s*[A-Za-z0-9_-]{12,}|Bearer\s+[A-Za-z0-9_-]{20,})")
for path in ROOT.rglob("*"):
    if not path.is_file() or ".git" in path.parts or path.suffix in {".zip", ".pyc", ".joblib"}:
        continue
    try:
        text = path.read_text(encoding="utf-8")
    except UnicodeDecodeError:
        continue
    if suspicious.search(text):
        errors.append(f"Possible committed secret: {path.relative_to(ROOT)}")

if errors:
    print("ARCHITECTURE CHECK FAILED")
    for error in errors:
        print(f"- {error}")
    sys.exit(1)
print("Architecture check: PASS")
