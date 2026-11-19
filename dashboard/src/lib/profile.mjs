/**
 * Pure helpers that translate between the gateway's business document and the profile form:
 * reading the server-owned assistant policy and building the PUT payload on save.
 */
import { widgetConfigPayload } from "./origins.mjs";
import { normalizeContactPhone, validateContactFields } from "./contactValidation.mjs";

/** Returns { version, system_prompt } for display, or null for older gateways that omit the policy. */
export function readAssistantPolicy(doc) {
    const policy = doc?.assistant_policy;
    if (typeof policy?.version !== "string" || typeof policy?.system_prompt !== "string") {
        return null;
    }
    return { version: policy.version, system_prompt: policy.system_prompt };
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
        ...(widgetConfig ? { widget_config: widgetConfig } : {}),
        agent_config: {
            system_prompt: form.agent_config.system_prompt,
            agent_tone: form.agent_config.agent_tone,
            temperature: Number(form.agent_config.temperature),
            max_context_chunks: Number(form.agent_config.max_context_chunks),
            similarity_threshold: Number(form.agent_config.similarity_threshold),
        },
    };
}
