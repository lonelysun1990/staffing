import json
import os
import subprocess
import tempfile

from .env_manager import get_tool_python, environment_exists

TIMEOUT_SECONDS = 30


def execute_in_sandbox(tool_name: str, code: str, function_name: str, args: dict) -> dict:
    """Execute tool code in its isolated venv subprocess.
    Returns {"ok": True, "result": ...} or {"ok": False, "error": "..."}
    """
    if not environment_exists(tool_name):
        return {"ok": False, "error": f"Environment for '{tool_name}' not ready yet"}

    runner = f"""
import json, sys
{code}

if __name__ == "__main__":
    args = json.loads(sys.argv[1])
    try:
        result = {function_name}(**args)
        print(json.dumps({{"ok": True, "result": result}}, default=str))
    except Exception as e:
        print(json.dumps({{"ok": False, "error": str(e)}}))
"""
    with tempfile.NamedTemporaryFile(mode="w", suffix=".py", delete=False) as f:
        f.write(runner)
        script_path = f.name

    try:
        proc = subprocess.run(
            [get_tool_python(tool_name), script_path, json.dumps(args)],
            capture_output=True,
            text=True,
            timeout=TIMEOUT_SECONDS,
            env={"PATH": "/usr/bin:/bin", "HOME": "/tmp"},
        )
        if proc.returncode == 0 and proc.stdout.strip():
            return json.loads(proc.stdout.strip())
        return {"ok": False, "error": proc.stderr.strip() or "No output"}
    except subprocess.TimeoutExpired:
        return {"ok": False, "error": f"Timed out after {TIMEOUT_SECONDS}s"}
    except json.JSONDecodeError:
        return {"ok": False, "error": f"Unparseable output: {proc.stdout[:300]}"}
    finally:
        os.unlink(script_path)
