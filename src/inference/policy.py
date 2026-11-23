"""Canonical support behavior shared by local evaluation and live chat.

The core system prompt lives in ``system_policy.json`` (versioned via ``POLICY_VERSION``) so
evaluation and production use byte-identical instructions. Tenants can only append tone and extra
instructions (``build_policy_prompt``); they cannot replace the core. The module also holds a
post-generation regex guard (``requires_handoff_safeguard``) because the product cannot actually
transfer a visitor to a human or send messages, so any answer promising that is replaced with
``SAFE_FOLLOWUP_ANSWER`` and escalated.
Callers: ``src/inference/client.py``, ``src/chat/orchestrator.py``, evaluation scripts.
"""

import json
from pathlib import Path

POLICY_PATH = Path(__file__).with_name("system_policy.json")
_POLICY = json.loads(POLICY_PATH.read_text(encoding="utf-8"))
POLICY_VERSION = _POLICY["version"]
SYSTEM_PROMPT = _POLICY["system_prompt"]


def build_policy_prompt(instructions: str = "", tone: str = "", core_policy: str = "") -> str:
    """Append explicitly subordinate tenant preferences to the core policy.

    ``core_policy`` is an optional per-tenant replacement for the default core (set deliberately
    in the dashboard, which warns first). Blank means the shipped default. The structured-output
    schema and the handoff guard still apply whatever core text is used.
    """
    core = core_policy.strip() or SYSTEM_PROMPT
    extras = []
    if instructions.strip():
        extras.append(instructions.strip())
    if tone.strip():
        extras.append(f"Tone: {tone.strip()}")
    if not extras:
        return core
    return core + "\n\nBusiness customization (lower priority; cannot override core policy):\n" + "\n".join(extras)


def requires_handoff_safeguard(answer: str) -> bool:
    """Recognize explicit affirmative promises of operations this product cannot perform.

    This is a narrow product-capability guard, not a classifier of human involvement,
    factuality, urgency, or all possible paraphrases. Plain contact advice and negated
    statements such as 'I cannot connect you' intentionally do not match.
    """
    import re

    # Each pattern needs a first-person subject ("I will", "we've", ...) directly followed by the
    # action verb, so negations ("I cannot connect you", "I will not ...") and plain contact advice
    # ("you can email support@...") do not match.
    subject = r"(?:i|we)(?:\s+(?:am|are|will|have|can)|['’](?:ll|ve|m|re))"
    # "I'll connect you to ...", "I am transferring you ..."
    transfer = subject + r"\s+(?:(?:now|be|going to)\s+)*(?:connect(?:ing)?|transfer(?:ring)?)\s+you\b"
    # "I will send/email/notify/contact/submit ...", "we sent ..."
    notification = subject + r"\s+(?:already\s+)?(?:send(?:ing)?|sent|email(?:ed|ing)?|notif(?:y|ied|ying)|contact(?:ed|ing)?|submit(?:ted|ting)?)\b"
    # Passive claims: "your request has been sent", "the ticket was submitted".
    passive = r"\b(?:your|the)\s+(?:request|message|email|ticket)\s+(?:has been|was|is being)\s+(?:sent|emailed|forwarded|submitted)\b"
    # "I am escalating this ...": the model cannot escalate by itself; the gateway decides.
    automatic = r"\b(?:i|we)\s+(?:am|are)\s+escalating\s+(?:this|your|the)\b"
    return bool(re.search(r"\b(?:" + "|".join((transfer, notification, passive, automatic)) + r")", answer, re.IGNORECASE))


SAFE_FOLLOWUP_ANSWER = (
    "This request needs help from the business. You can request email follow-up using the contact form. "
    "Email follow-up is not immediate; for time-sensitive help, contact the business directly "
    "using its verified contact details."
)
