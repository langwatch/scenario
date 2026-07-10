"""Pyright-narrowing helpers for span assertions.

``ReadableSpan.attributes`` is ``Optional[Mapping[str, AttributeValue]]`` and
``.parent``/``.context`` are ``Optional[SpanContext]``, so direct subscript /
attribute access trips pyright (standard mode, run in CI). These helpers narrow
once with an ``assert`` so the span tests stay type-clean.
"""

from typing import Any, Mapping


def attrs(span: Any) -> Mapping[str, Any]:
    """The span's attributes, asserted non-None."""
    assert span.attributes is not None
    return span.attributes


def int_attr(span: Any, key: str) -> int:
    """An int-valued attribute (AttributeValue is a union; narrow for `>=`)."""
    value = attrs(span)[key]
    assert isinstance(value, int)
    return value


def parent_id(span: Any) -> int:
    """The span's parent span_id, asserted present."""
    assert span.parent is not None
    return span.parent.span_id


def ctx_id(span: Any) -> int:
    """The span's own span_id."""
    ctx = span.context
    assert ctx is not None
    return ctx.span_id
