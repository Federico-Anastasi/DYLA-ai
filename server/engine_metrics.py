"""What the local engine is actually doing, read from llama-server.

Dyla starts llama-server with --metrics, so there is a Prometheus endpoint sitting there
that nothing was reading. It answers the questions you actually have while waiting: is it
still working, how fast is it going, how full is the context, and is the wait prefill or
generation — which are different problems with different fixes.

Two numbers matter more than they look:

  prefill vs generation. On this hardware prefill runs at ~350 tokens/s and generation at
  ~30. A turn that takes a minute is almost always re-reading its own context, not
  thinking. Seeing them apart is what tells you whether to cut the prompt or accept the
  wait.

  context high-water mark. llama-server reports the largest prompt it has held. Compared
  with the window the engine was loaded with, that is how close this conversation has
  come to not fitting.
"""
from __future__ import annotations

import httpx

# The engine is on the loopback and either answers immediately or is busy generating;
# a long timeout here would just hold up the UI poll behind it.
TIMEOUT = 2.5

# Gauges llama-server reports directly. The counters we do the arithmetic on ourselves.
_WANTED = {
    "llamacpp:prompt_tokens_total": "prompt_tokens",
    "llamacpp:prompt_seconds_total": "prompt_seconds",
    "llamacpp:tokens_predicted_total": "predicted_tokens",
    "llamacpp:tokens_predicted_seconds_total": "predicted_seconds",
    "llamacpp:predicted_tokens_seconds": "predicted_gauge",
    "llamacpp:prompt_tokens_seconds": "prompt_gauge",
    "llamacpp:n_tokens_max": "context_peak",
    "llamacpp:requests_processing": "processing",
    "llamacpp:requests_deferred": "deferred",
}


def _parse(text: str) -> dict[str, float]:
    out: dict[str, float] = {}
    for line in text.splitlines():
        if line.startswith("#") or " " not in line:
            continue
        name, _, value = line.partition(" ")
        key = _WANTED.get(name)
        if key:
            try:
                out[key] = float(value)
            except ValueError:
                pass
    return out


class EngineMetrics:
    """Reads the engine and works out the rates.

    It keeps the previous counter reading because of a real trap: the
    `predicted_tokens_seconds` gauge does not fall back to zero when the model stops. It
    freezes at whatever it last was, so an idle engine reports a healthy tokens/s
    forever. While a request is in flight we compute the rate from the counters instead
    — the difference between two readings is the truth — and fall back to the gauge only
    when there is nothing running and no delta to take.
    """

    def __init__(self, base_url: str = "http://127.0.0.1:8080") -> None:
        self.base_url = base_url
        self._previous: dict[str, float] | None = None

    async def read(self) -> dict:
        try:
            async with httpx.AsyncClient(timeout=TIMEOUT) as client:
                metrics = await client.get(f"{self.base_url}/metrics")
                metrics.raise_for_status()
                raw = _parse(metrics.text)
                slots = await self._slots(client)
        except (httpx.HTTPError, ValueError):
            # The engine is off, or starting: not an error, just nothing to show yet.
            return {"running": False}

        previous, self._previous = self._previous, raw
        busy = raw.get("processing", 0) > 0
        generation, generation_live = self._rate(raw, previous, "predicted_tokens",
                                                 "predicted_seconds", "predicted_gauge")
        prefill, prefill_live = self._rate(raw, previous, "prompt_tokens",
                                           "prompt_seconds", "prompt_gauge")
        return {
            "running": True,
            "busy": busy,
            "generation_tps": generation,
            "prefill_tps": prefill,
            # Whether those rates were measured between two readings just now, or are the
            # speed of the last finished request. The UI marks the second kind with a ~.
            "rates_live": generation_live or prefill_live,
            "tokens_generated": int(raw.get("predicted_tokens", 0)),
            "tokens_prefilled": int(raw.get("prompt_tokens", 0)),
            "context_used": slots.get("used"),
            "context_size": slots.get("size"),
            "context_peak": int(raw.get("context_peak", 0)) or None,
            "queued": int(raw.get("deferred", 0)),
        }

    async def _slots(self, client: httpx.AsyncClient) -> dict:
        """Context actually held right now. Separate endpoint, and optional: some builds
        run with the slots endpoint disabled, and the rest of the panel still works."""
        try:
            r = await client.get(f"{self.base_url}/slots")
            r.raise_for_status()
            slot = (r.json() or [{}])[0]
            return {"used": slot.get("n_prompt_tokens"), "size": slot.get("n_ctx")}
        except (httpx.HTTPError, ValueError, IndexError, KeyError):
            return {}

    @staticmethod
    def _rate(now: dict, before: dict | None, tokens_key: str, seconds_key: str,
              gauge_key: str) -> tuple[float | None, bool]:
        """(tokens per second, is it a fresh measurement).

        The counters are the truthful source, but llama-server only updates them when a
        request FINISHES: measured here, tokens_predicted_total sat unchanged for twelve
        seconds while the engine was visibly generating. So during a turn — exactly when
        someone is watching the panel — the delta is always zero.

        This first returned nothing in that case, on the principle that no number beats a
        stale one. That was wrong: it showed a dash for the entire length of the work,
        which is the one moment the panel exists for. The gauge holds the speed of the
        last completed request, and on a given machine and model that barely moves, so it
        is a fair estimate of what is happening now. We show it, and say it is an
        estimate rather than passing it off as live.
        """
        if before:
            d_tokens = now.get(tokens_key, 0) - before.get(tokens_key, 0)
            d_seconds = now.get(seconds_key, 0) - before.get(seconds_key, 0)
            if d_tokens > 0 and d_seconds > 0:
                return round(d_tokens / d_seconds, 1), True
        gauge = now.get(gauge_key)
        return (round(gauge, 1) if gauge else None), False
