"""Incrementally extract one top-level string field from a streamed JSON object.

The model is decoded under a JSON schema, so its raw output looks like
``{"answer": "...", "cited_sources": [...], "confidence": 0.9, "action": "answer"}``.
To stream only the human-readable answer to a visitor, ``AnswerStreamer.feed`` takes each
text chunk as it arrives and returns the newly decoded characters of the ``answer`` value.
Chunks may split the text anywhere, including inside an escape sequence or a surrogate pair.

What is stripped: every other field (``cited_sources``, ``confidence``, ``action``) is parsed past
and discarded, so only answer text could ever reach a visitor. Those fields are internal
(escalation review) and must not leak.

Inputs: raw JSON text fragments from the model. Output: decoded answer characters.

TODO(streaming): this class is not yet used in production. Target: ``ChatOrchestrator.stream`` feeds
model chunks through ``AnswerStreamer`` and emits many ``token`` events (the gateway's chat route and
the widget's ``chatClient.js`` already handle repeated token events). The open problem is safety: the
model returns structured JSON, so the answer must be extracted incrementally while the full reply is
still validated against ``SupportResponse``, and the handoff safeguard / escalation decision must not
leak into text already shown to the visitor, because streamed text cannot be retracted.

Status: the current ``ChatOrchestrator.stream`` deliberately does NOT use this class. It buffers the
whole JSON, validates it against ``SupportResponse`` and runs the handoff safeguard, then emits one
``token`` event, because already-streamed unsafe text cannot be retracted. Only
``tests/test_chat_service.py`` exercises it; it is kept for token-level streaming should the
validation step ever move before display. The SSE framing seen by the widget is done by the Node
gateway (``gateway/src/routes/chat.js``) from the orchestrator's NDJSON events, not here.
"""

_WHITESPACE = " \t\r\n"
_SIMPLE_ESCAPES = {'"': '"', "\\": "\\", "/": "/", "b": "\b", "f": "\f", "n": "\n", "r": "\r", "t": "\t"}


class AnswerStreamer:
    """Small incremental JSON state machine that yields only the decoded value of one string field."""

    def __init__(self, field: str = "answer"):
        self.field = field
        self._state = "start"
        self._key = []
        self._current_key = ""
        # String decoding sub-state (shared by keys, the answer value and skipped values).
        self._str_target = None  # "key" | "answer" | "skip"
        self._str_escape = None  # None | "esc" | "uni"
        self._uni = ""
        self._high_surrogate = None
        # Skipping nested arrays / objects.
        self._depth = 0
        self._nested_in_string = False
        self._nested_escape = False
        self.answer_started = False
        self.answer_finished = False

    def feed(self, text: str) -> str:
        """Consumes the next fragment and returns any newly decoded answer characters (maybe empty)."""
        out = []
        for char in text:
            self._step(char, out)
        return "".join(out)

    # -- string decoding -------------------------------------------------

    def _emit(self, char: str, out: list) -> None:
        if self._str_target == "key":
            self._key.append(char)
        elif self._str_target == "answer":
            out.append(char)

    def _flush_high_surrogate(self, out: list) -> None:
        # A lone high surrogate (no following low half) becomes U+FFFD instead of invalid text.
        if self._high_surrogate is not None:
            self._high_surrogate = None
            self._emit("�", out)

    def _finish_string(self) -> None:
        target = self._str_target
        self._str_target = None
        if target == "key":
            self._current_key = "".join(self._key)
            self._key = []
            self._state = "colon"
        else:
            if target == "answer":
                self.answer_finished = True
            self._state = "key_or_end"

    def _string_char(self, char: str, out: list) -> None:
        if self._str_escape == "uni":
            self._uni += char
            if len(self._uni) < 4:
                return
            try:
                code = int(self._uni, 16)
            except ValueError:
                code = 0xFFFD
            self._uni = ""
            self._str_escape = None
            if 0xD800 <= code <= 0xDBFF:
                self._flush_high_surrogate(out)
                self._high_surrogate = code
            elif 0xDC00 <= code <= 0xDFFF and self._high_surrogate is not None:
                combined = 0x10000 + ((self._high_surrogate - 0xD800) << 10) + (code - 0xDC00)
                self._high_surrogate = None
                self._emit(chr(combined), out)
            else:
                self._flush_high_surrogate(out)
                self._emit(chr(code) if not 0xDC00 <= code <= 0xDFFF else "�", out)
            return
        if self._str_escape == "esc":
            self._str_escape = None
            if char == "u":
                self._str_escape = "uni"
                self._uni = ""
                return
            self._flush_high_surrogate(out)
            self._emit(_SIMPLE_ESCAPES.get(char, char), out)
            return
        if char == "\\":
            self._str_escape = "esc"
            return
        self._flush_high_surrogate(out)
        if char == '"':
            self._finish_string()
            return
        self._emit(char, out)

    def _begin_string(self, target: str) -> None:
        self._str_target = target
        self._str_escape = None
        self._uni = ""
        self._high_surrogate = None
        self._state = "string"
        if target == "answer":
            self.answer_started = True

    # -- structure -------------------------------------------------------

    def _step(self, char: str, out: list) -> None:
        state = self._state
        if state == "string":
            self._string_char(char, out)
        elif state == "start":
            if char == "{":
                self._state = "key_or_end"
        elif state == "key_or_end":
            if char == '"':
                self._begin_string("key")
            elif char == "}":
                self._state = "done"
        elif state == "colon":
            if char == ":":
                self._state = "value_start"
        elif state == "value_start":
            if char in _WHITESPACE:
                return
            if char == '"':
                self._begin_string("answer" if self._current_key == self.field else "skip")
            elif char in "[{":
                self._state = "nested"
                self._depth = 1
                self._nested_in_string = False
                self._nested_escape = False
            else:
                self._state = "literal"
        elif state == "literal":
            if char == ",":
                self._state = "key_or_end"
            elif char == "}":
                self._state = "done"
        elif state == "nested":
            if self._nested_in_string:
                if self._nested_escape:
                    self._nested_escape = False
                elif char == "\\":
                    self._nested_escape = True
                elif char == '"':
                    self._nested_in_string = False
            elif char == '"':
                self._nested_in_string = True
            elif char in "[{":
                self._depth += 1
            elif char in "]}":
                self._depth -= 1
                if self._depth == 0:
                    self._state = "key_or_end"
        # "done": ignore trailing text
