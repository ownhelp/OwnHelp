/**
 * Pure helpers that translate between the gateway's business document and the profile form:
 * reading the server-owned assistant policy and building the PUT payload on save.
 */
import { widgetConfigPayload } from "./origins.mjs";
import { normalizeContactPhone, validateContactFields } from "./contactValidation.mjs";
import { DEFAULT_AGENT_NUMBERS, DEFAULT_AGENT_TONE, buildDefaultBusinessInstructions } from "./agentDefaults.mjs";

/** Returns { version, system_prompt } for display, or null for older gateways that omit the policy. */
export function readAssistantPolicy(doc) {
    const policy = doc?.assistant_policy;
    if (typeof policy?.version !== "string" || typeof policy?.system_prompt !== "string") {
        return null;
    }
    return { version: policy.version, system_prompt: policy.system_prompt };
}

/**
 * The agent_config a business starts with, rebuilt from its stored name, industry and contact email.
 * core_policy "" means the shipped default policy. Identity, contact details and origins are not
 * part of it, so "Set to defaults" never touches them.
 */
export function defaultAgentConfig(form) {
    return {
        system_prompt: buildDefaultBusinessInstructions({
            businessName: form.name,
            industry: form.industry,
            contactEmail: form.contact_email,
        }),
        core_policy: "",
        agent_tone: DEFAULT_AGENT_TONE,
        ...DEFAULT_AGENT_NUMBERS,
    };
}

/**
 * Core policy override for the save payload. form.agent_config.core_policy is "" when the shipped
 * default applies. Text identical to the default counts as "no override", and the field is only
 * sent when it changed, so ordinary saves never touch it. null tells the gateway to reset.
 */
export function corePolicyPayload(form, savedSnapshot) {
    const normalize = (value) => (typeof value === "string" ? value.trim() : "");
    const defaultText = normalize(form.assistant_policy?.system_prompt);
    const current = normalize(form.agent_config.core_policy);
    const effective = current === defaultText ? "" : current;
    if (effective === normalize(savedSnapshot.agent_config?.core_policy)) return {};
    return { core_policy: effective || null };
}

// Explicitly select editable fields: server-owned policy and identity are never written back.
// Also re-validates contact fields and throws, so a save cannot bypass the form's native validation.
export function profilePayload(form, savedSnapshot) {
    const errors = validateContactFields(form);
    if (Object.keys(errors).length) throw new Error(Object.values(errors)[0]);
    const widgetConfig = widgetConfigPayload(form.allowed_origins, savedSnapshot.allowed_origins);
    return {
        name: form.name,
        industry: form.industry,
        contact_email: form.contact_email.trim(),
        contact_phone: normalizeContactPhone(form.contact_phone, form.contact_phone_extension || ""),
        team_name: form.team_name,
        record_conversations: form.record_conversations === true,
        ...(widgetConfig ? { widget_config: widgetConfig } : {}),
        agent_config: {
            system_prompt: form.agent_config.system_prompt,
            ...corePolicyPayload(form, savedSnapshot),
            agent_tone: form.agent_config.agent_tone,
            temperature: Number(form.agent_config.temperature),
            max_context_chunks: Number(form.agent_config.max_context_chunks),
            similarity_threshold: Number(form.agent_config.similarity_threshold),
        },
    };
}
