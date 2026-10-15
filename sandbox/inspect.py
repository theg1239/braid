"""Read tracked manifests as data; never choose installation or test commands."""
import json
from datetime import date, time as clock_time
import math
import os
from pathlib import Path
import subprocess
import sys
import time
import tomllib

MANIFESTS = {"package.json", "pyproject.toml", "Cargo.toml", "go.mod", "go.work"}
LOCKS = {"package-lock.json", "npm-shrinkwrap.json", "pnpm-lock.yaml", "yarn.lock", "bun.lock", "bun.lockb", "uv.lock", "poetry.lock", "Pipfile.lock", "Cargo.lock", "go.sum"}
VERSIONS = {".node-version", ".nvmrc", ".python-version", ".tool-versions", "rust-toolchain", "rust-toolchain.toml", "mise.toml", ".mise.toml"}


def json_data(value):
    if isinstance(value, dict):
        return {key: json_data(item) for key, item in value.items()}
    if isinstance(value, list):
        return [json_data(item) for item in value]
    if isinstance(value, (date, clock_time)):
        return value.isoformat()
    if isinstance(value, float) and not math.isfinite(value):
        return str(value)
    return value


def inspect(root, go="/opt/braid/go/bin/go"):
    result = subprocess.run(["git", "ls-files", "-z", "--cached"], cwd=root, capture_output=True, check=True)
    paths = sorted(set(result.stdout.decode("utf-8", errors="surrogateescape").split("\0")) - {""})
    manifests, lockfiles, instructions = [], [], []
    deadline, omitted = time.monotonic() + 40, 0
    for path in paths:
        file = Path(root) / path
        name = file.name
        if name in LOCKS:
            lockfiles.append(path)
        if name in {"AGENTS.md", "README.md", "CONTRIBUTING.md", "Makefile"} or path.startswith(".github/workflows/"):
            instructions.append(path)
        if name not in MANIFESTS | VERSIONS and name != "requirements.txt":
            continue
        if len(manifests) >= 256 or time.monotonic() >= deadline:
            omitted += 1
            continue
        entry = {"path": path}
        manifests.append(entry)
        # A tracked symlink is a fact, not permission to read outside the checkout.
        if file.is_symlink() or not file.is_file():
            entry["error"] = "not_regular_file"
            continue
        if file.stat().st_size > 64 * 1024:
            entry["error"] = "manifest_too_large"
            continue
        try:
            text = file.read_text(encoding="utf-8")
            if name == "package.json":
                data = json.loads(text)
                entry["data"] = {key: data[key] for key in ("name", "scripts", "engines", "devEngines", "volta", "packageManager", "workspaces") if key in data} if isinstance(data, dict) else data
            elif name.endswith(".toml"):
                entry["data"] = json_data(tomllib.loads(text))
            elif name in {"go.mod", "go.work"}:
                parsed = subprocess.run([go, "mod" if name == "go.mod" else "work", "edit", "-json", str(file.resolve())],
                                        cwd=root, capture_output=True, timeout=min(20, max(0.01, deadline - time.monotonic())),
                                        env={**os.environ, "GOTOOLCHAIN": "local", "GOWORK": "off", "GOFLAGS": ""})
                if parsed.returncode:
                    entry["error"] = "invalid_manifest"
                    entry["exitCode"] = parsed.returncode
                else:
                    entry["data"] = json.loads(parsed.stdout)
            else:
                # Requirements and version files remain declarations for the model, never a guessed command.
                entry["text"] = text
        except (json.JSONDecodeError, tomllib.TOMLDecodeError, UnicodeDecodeError):
            entry["error"] = "invalid_manifest"
        except FileNotFoundError:
            entry["error"] = "parser_unavailable"
        except subprocess.TimeoutExpired:
            entry["error"] = "parser_timeout"
        except OSError:
            entry["error"] = "unreadable_manifest"
    output = {"manifests": [], "lockfiles": [], "instructions": [], "omitted": omitted}
    for group, entries in [("manifests", manifests), ("lockfiles", lockfiles), ("instructions", instructions)]:
        for entry in entries:
            if len(output[group]) >= 256 or len(json.dumps(output)) + len(json.dumps(entry)) > 48 * 1024:
                output["omitted"] += 1
            else:
                output[group].append(entry)
    return output


if __name__ == "__main__":
    print(json.dumps(inspect(Path.cwd(), sys.argv[1] if len(sys.argv) > 1 else "/opt/braid/go/bin/go"), separators=(",", ":")))
