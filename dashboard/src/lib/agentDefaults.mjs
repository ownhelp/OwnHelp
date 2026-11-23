/**
 * Shared agent-tone options for the signup and profile pages.
 *
 * Why one file: both pages offered the same list and the same default, and two copies can drift
 * (one page would offer a tone the other cannot display). The gateway owns and validates the
 * numeric settings (temperature, context chunks, similarity), and the dashboard otherwise only
 * mirrors what the gateway returns; DEFAULT_AGENT_NUMBERS below is the one exception, kept for the
 * profile page's "Set to defaults" button.
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

/**
 * Numeric agent settings a new business starts with. These mirror what the gateway writes at
 * signup (gateway/src/routes/auth.js) and are used only by the profile page's "Set to defaults";
 * the gateway still validates every value on save.
 */
export const DEFAULT_AGENT_NUMBERS = {
    temperature: 0.2,
    max_context_chunks: 4,
    similarity_threshold: 0.7,
};

/**
 * The generated Business Instructions a new business starts with. Same wording as the gateway's
 * buildDefaultSystemPrompt; shown as a preview on signup and rebuilt from the stored name,
 * industry and contact email when an admin resets to defaults.
 */
export function buildDefaultBusinessInstructions({ businessName, industry, contactEmail }) {
    const cleanName = (businessName || "your business").trim();
    const cleanIndustry = (industry || "").trim();
    const cleanEmail = (contactEmail || "").trim();
    const sectorPhrase = cleanIndustry ? ` (${cleanIndustry})` : "";
    const escalationPhrase = cleanEmail
        ? ` If the answer is not verified by the provided context, state that clearly and offer to escalate the inquiry to ${cleanEmail}.`
        : " If the answer is not verified by the provided context, state that clearly and offer to escalate the inquiry to a human support specialist.";

    return `You are a customer support agent for ${cleanName}${sectorPhrase}. Answer customer questions strictly using the provided context chunks.${escalationPhrase}`;
}
