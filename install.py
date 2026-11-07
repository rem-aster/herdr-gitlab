#!/usr/bin/env python3
"""Installs or updates the GitLab panel in Herdr. Run it with Herdr open:

    python3 install.py

It copies mods/gitlab into the Herdr home (~/.config/herdr-app, or $HERDR_APP_HOME). The first
time, it also puts a "GitLab" button beside Files and Changes: Herdr's own layouts and mods are
replaced on every start, so the shown layout and its tab bar are cloned (layout.clone, mod.clone,
as Herdr's AGENTS.md says) and the clones get the panel. A personal layout is edited in place.
Running it again only updates the mod.
"""

import json
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
MARK = "// GitLab for the focused repo"
SKIP = {"gpui-kit.d.ts", "jsconfig.json"}  # Herdr writes these into every mod folder

# The two edits to the tab bar (Herdr's `tabs` mod, 0.1.11 to 0.1.13).
ENABLED = 'const enabled = shared("workspace.panels") ?? ["files", "changes"];'
ENABLED_GITLAB = '// The GitLab panel (mods/gitlab) sits in the same stack as Files and Changes.\n    const enabled = [...(shared("workspace.panels") ?? ["files", "changes"]), "gitlab"];'
CHANGES = '.when(enabled.includes("changes"), el => el.child(panelButton("changes", "Changes", "mods/changes/changes.svg")))'
GITLAB = '.when(enabled.includes("gitlab"), el => el.child(panelButton("gitlab", "GitLab", "mods/gitlab/icons/gitlab.svg")))'
BLOCK = {"id": "gitlab", "type": "block", "content": {"mod": "gitlab"}}

MANUAL = """
Put it in by hand (or ask your agent to, from RECIPE.md):
  1. herdr-app do layout.clone '{"name":"main","as":"main-gitlab"}'   (skip for a personal layout)
  2. herdr-app do mod.clone '{"name":"tabs","as":"tabs-gitlab"}'
  3. In mods/tabs-gitlab/main.js add "gitlab" to `enabled` and a panelButton("gitlab", ...) after Changes.
  4. In the layout: the "tabs" block's mod -> "tabs-gitlab"; append to the "panel-body" stack:
     {"id": "gitlab", "type": "block", "content": {"mod": "gitlab"}}"""


def herdr(command, args):
    r = subprocess.run(["herdr-app", "do", command, json.dumps(args)], capture_output=True, text=True)
    if r.returncode != 0:
        raise SystemExit(f"herdr-app do {command} failed (is Herdr open?): {(r.stdout + r.stderr).strip()}")


def walk(node):
    yield node
    for child in node.get("children", []):
        yield from walk(child)


def find(node, id):
    return next((n for n in walk(node) if n.get("id") == id), None)


def read_json(path, fallback=None):
    try:
        return json.loads(path.read_text())
    except (OSError, ValueError):
        return fallback


def copy_mod(app):
    dest = app / "mods" / "gitlab"
    main_js = dest / "main.js"
    ours = main_js.exists() and MARK in main_js.read_text(errors="ignore")
    if dest.exists() and any(dest.iterdir()) and not ours:
        raise SystemExit(f"{dest} is another mod: rename one of them first (ui.js MOD, the layout block)")
    dest.mkdir(parents=True, exist_ok=True)
    for src in (HERE / "mods" / "gitlab").rglob("*"):
        if src.name in SKIP or src.is_dir():
            continue
        target = dest / src.relative_to(HERE / "mods" / "gitlab")
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(src, target)
    print(f"✓ mod copied to {dest}")


def wire_tabs(app, name, shipped):
    """The tab bar mod with the GitLab button: a clone of a shipped one, or the person's own."""
    if name in shipped:
        clone = f"{name}-gitlab"
        if not (app / "mods" / clone).exists():
            herdr("mod.clone", {"name": name, "as": clone})
        name = clone
    path = app / "mods" / name / "main.js"
    text = path.read_text()
    if GITLAB in text:
        return name
    if ENABLED not in text or CHANGES not in text:
        raise SystemExit(f"mods/{name}/main.js doesn't look like Herdr's tab bar." + MANUAL)
    text = text.replace(ENABLED, ENABLED_GITLAB).replace(CHANGES, f"{CHANGES}\n      {GITLAB}")
    path.write_text(text)
    print(f"✓ GitLab button in mods/{name}")
    return name


def wire_layout(app, shipped):
    shown = (read_json(app / "shared.json", {}) or {}).get("layout", "main")
    path = app / "layouts" / f"{shown}.json"
    layout = read_json(path)
    if layout is None:
        raise SystemExit(f"Can't read {path}." + MANUAL)
    if any(n.get("content", {}).get("mod") == "gitlab" for n in walk(layout)):
        print(f"✓ layout {shown} already has the panel")
        return
    tabs, body = find(layout, "tabs"), find(layout, "panel-body")
    if not tabs or "mod" not in tabs.get("content", {}) or not body:
        raise SystemExit(f"Layout {shown} has no tab bar and side panel like Herdr's main." + MANUAL)
    tabs_mod = wire_tabs(app, tabs["content"]["mod"], shipped)
    if f"layout:{shown}" in shipped:
        clone = f"{shown}-gitlab"
        if (app / "layouts" / f"{clone}.json").exists():
            raise SystemExit(f"layouts/{clone}.json exists: switch to it (herdr-app do layout.switch) or remove it.")
        herdr("layout.clone", {"name": shown, "as": clone})  # also switches to it
        path = app / "layouts" / f"{clone}.json"
        for _ in range(50):
            if path.exists():
                break
            time.sleep(0.1)
        layout = read_json(path)
        shown = clone
    find(layout, "tabs")["content"]["mod"] = tabs_mod
    find(layout, "panel-body")["children"].append(dict(BLOCK))
    path.write_text(json.dumps(layout, indent=2, ensure_ascii=False) + "\n")
    print(f"✓ layout {shown}: the panel beside Files and Changes")


def main(app=None):
    app = Path(app or os.environ.get("HERDR_APP_HOME") or Path.home() / ".config" / "herdr-app")
    if not (app / "mods").is_dir():
        raise SystemExit(f"No Herdr home at {app}: start Herdr once first.")
    if not shutil.which("glab"):
        print("! glab isn't installed: https://gitlab.com/gitlab-org/cli — then: glab auth login --hostname <your GitLab>")
    copy_mod(app)
    shipped = set(read_json(app / "installed.json", {}) or {})
    wire_layout(app, shipped)
    if shutil.which("herdr-app"):
        r = subprocess.run(["herdr-app", "check", str(app / "mods" / "gitlab")], capture_output=True, text=True)
        print(("✓ " if r.returncode == 0 else "✗ ") + (r.stdout + r.stderr).strip())
    print("Done: the GitLab button is in the tab bar, next to Changes.")


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else None)
