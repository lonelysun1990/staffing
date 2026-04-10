import os
import shutil
import subprocess
from pathlib import Path
from typing import List

SANDBOX_ENVS_DIR = Path(os.environ.get("SANDBOX_ENVS_DIR", "/sandbox-envs"))


def get_tool_python(tool_name: str) -> str:
    return str(SANDBOX_ENVS_DIR / tool_name / "bin" / "python")


def environment_exists(tool_name: str) -> bool:
    return Path(get_tool_python(tool_name)).exists()


def create_tool_environment(tool_name: str, requirements: List[str]) -> dict:
    """Create venv and install dependencies. Blocking — call from a background thread."""
    venv_path = SANDBOX_ENVS_DIR / tool_name
    try:
        subprocess.run(
            ["python", "-m", "venv", str(venv_path)],
            check=True, capture_output=True, timeout=60,
        )
        if requirements:
            pip = venv_path / "bin" / "pip"
            subprocess.run(
                [str(pip), "install", "--no-cache-dir"] + requirements,
                check=True, capture_output=True, timeout=300,
            )
        return {"ok": True}
    except subprocess.CalledProcessError as e:
        return {"ok": False, "error": e.stderr.decode() if e.stderr else str(e)}
    except Exception as e:
        return {"ok": False, "error": str(e)}


def delete_tool_environment(tool_name: str) -> None:
    venv_path = SANDBOX_ENVS_DIR / tool_name
    if venv_path.exists():
        shutil.rmtree(venv_path)
