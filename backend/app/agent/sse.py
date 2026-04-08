from __future__ import annotations

import json


def sse(event_type: str, payload: dict) -> str:
    """Format a single SSE data line."""
    return f"data: {json.dumps({'type': event_type, **payload})}\n\n"
