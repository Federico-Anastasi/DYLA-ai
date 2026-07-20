"""Reading the engine's own numbers.

The parsing is trivial; the rate is not. llama-server's tokens/s gauge does not return to
zero when generation stops — it holds its last value indefinitely, so an idle engine
reports a healthy speed forever. Anyone reading the panel would think work was happening.
The fix is to take the rate from the difference between two counter readings whenever
there is one, and that behaviour is what these tests pin down.

Run: python -m pytest server/tests/test_engine_metrics.py
"""
import pytest

from server.engine_metrics import EngineMetrics, _parse

SAMPLE = """# HELP llamacpp:prompt_tokens_total Number of prompt tokens processed.
# TYPE llamacpp:prompt_tokens_total counter
llamacpp:prompt_tokens_total 152103
llamacpp:prompt_seconds_total 439.028
llamacpp:tokens_predicted_total 21585
llamacpp:tokens_predicted_seconds_total 1135.67
llamacpp:predicted_tokens_seconds 19.0065
llamacpp:prompt_tokens_seconds 346.454
llamacpp:n_tokens_max 55256
llamacpp:requests_processing 0
llamacpp:requests_deferred 0
"""


def test_the_prometheus_lines_we_care_about_come_through():
    parsed = _parse(SAMPLE)
    assert parsed["predicted_tokens"] == 21585
    assert parsed["context_peak"] == 55256
    assert parsed["processing"] == 0


def test_comments_and_unknown_metrics_are_ignored():
    parsed = _parse(SAMPLE + "llamacpp:something_new 5\n# a comment\n")
    assert "something_new" not in parsed


def test_the_rate_comes_from_the_counters_when_they_moved():
    """100 tokens in 2 seconds is 50/s, whatever the gauge happens to say."""
    before = {"predicted_tokens": 1000.0, "predicted_seconds": 10.0}
    now = {"predicted_tokens": 1100.0, "predicted_seconds": 12.0, "predicted_gauge": 999.0}
    value, live = EngineMetrics._rate(now, before, "predicted_tokens",
                                      "predicted_seconds", "predicted_gauge")
    assert (value, live) == (50.0, True)


def test_a_working_engine_still_shows_a_speed():
    """The one the panel exists for, and the one this got wrong at first.

    llama-server only updates its counters when a request FINISHES — measured here, the
    token count sat unchanged for twelve seconds while the engine was visibly generating.
    So during a turn there is never a delta, and returning nothing meant showing a dash
    for the whole length of the work. The gauge holds the last completed request's speed,
    which on the same machine and model is a fair estimate: show it, flagged as not live.
    """
    same = {"predicted_tokens": 39261.0, "predicted_seconds": 2208.1, "predicted_gauge": 17.8}
    value, live = EngineMetrics._rate(same, dict(same), "predicted_tokens",
                                      "predicted_seconds", "predicted_gauge")
    assert value == 17.8, "a number, not a dash"
    assert live is False, "and honestly labelled as an estimate"


def test_the_first_reading_has_nothing_to_compare_with():
    value, live = EngineMetrics._rate({"predicted_gauge": 19.0}, None, "predicted_tokens",
                                      "predicted_seconds", "predicted_gauge")
    assert (value, live) == (19.0, False)


def test_an_engine_that_has_never_run_reports_no_rate():
    """No counters, no gauge: there is genuinely nothing to say, and the UI shows a dash."""
    value, live = EngineMetrics._rate({}, None, "predicted_tokens",
                                      "predicted_seconds", "predicted_gauge")
    assert (value, live) == (None, False)


@pytest.mark.asyncio
async def test_an_engine_that_is_not_there_is_not_an_error():
    """Dyla runs perfectly well on the cloud profile with no engine at all, and the
    panel simply does not appear. A 500 here would surface as a broken app."""
    m = EngineMetrics(base_url="http://127.0.0.1:1")  # nothing listens there
    assert await m.read() == {"running": False}
