/**
 * Shared agent-tone options for the signup and profile pages.
 *
 * Why one file: both pages offered the same list and the same default, and two copies can drift
 * (one page would offer a tone the other cannot display). The numeric defaults (temperature 0.2,
 * 4 context chunks, 0.7 similarity) are deliberately NOT here: the gateway owns and validates
 * them, and the dashboard only mirrors what the gateway returns.
 *
 * Used by: src/app/signup/page.jsx and src/app/profile/page.jsx.
 */

export const TONE_PRESETS = [
    "Warm & Professional",
    "Rugged & Direct",
    "Empathetic & Clinical",
    "Technical & Concise",
    "Friendly & Conversational",
];

/** Tone preselected for a new business and used when a stored config has none. */
export const DEFAULT_AGENT_TONE = TONE_PRESETS[0];
