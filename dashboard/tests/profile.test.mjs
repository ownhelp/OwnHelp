// Protects the profile save payload: editable fields only, identity and the shipped default policy excluded.
import test from "node:test";
import assert from "node:assert/strict";
import { defaultAgentConfig, profilePayload, readAssistantPolicy } from "../src/lib/profile.mjs";

const form = {
    name: "Example", industry: "Retail", contact_email: "help@example.com",
    contact_phone: "+1 202 555 0123", team_name: "Support", allowed_origins: "",
    tenant_id: "example", assistant_policy: { version: "1", system_prompt: "Core rules" },
    agent_config: { system_prompt: "Business details", agent_tone: "Warm", temperature: "0.2",
        max_context_chunks: "4", similarity_threshold: "0.7", assistant_policy: "Injected" },
};

test("save keeps business customization and public phone but excludes server-owned policy", () => {
    const payload = profilePayload(form, form);
    assert.equal(payload.contact_phone, "+12025550123");
    assert.equal(payload.agent_config.system_prompt, "Business details");
    assert.equal(payload.agent_config.temperature, 0.2);
    assert.equal("assistant_policy" in payload, false);
    assert.equal("assistant_policy" in payload.agent_config, false);
    assert.equal("tenant_id" in payload, false);
    assert.equal("widget_config" in payload, false);
});

test("core policy is only sent when changed; default text or blank resets with null", () => {
    const withPolicy = (core_policy) => ({ ...form, agent_config: { ...form.agent_config, core_policy } });
    assert.equal("core_policy" in profilePayload(form, form).agent_config, false);
    assert.equal("core_policy" in profilePayload(withPolicy(""), withPolicy("")).agent_config, false);
    assert.equal(profilePayload(withPolicy(" Portfolio rules "), form).agent_config.core_policy, "Portfolio rules");
    assert.equal(profilePayload(withPolicy(""), withPolicy("Portfolio rules")).agent_config.core_policy, null);
    assert.equal(profilePayload(withPolicy("Core rules"), withPolicy("Portfolio rules")).agent_config.core_policy, null);
    assert.equal("core_policy" in profilePayload(withPolicy("Core rules"), form).agent_config, false);
});

test("defaults rebuild the signup agent settings from the stored identity and clear the policy override", () => {
    const defaults = defaultAgentConfig({ name: "Acme", industry: "Retail", contact_email: "help@acme.com" });
    assert.equal(
        defaults.system_prompt,
        "You are a customer support agent for Acme (Retail). Answer customer questions strictly using the provided context chunks. If the answer is not verified by the provided context, state that clearly and offer to escalate the inquiry to help@acme.com."
    );
    assert.equal(defaults.core_policy, "");
    assert.equal(defaults.agent_tone, "Warm & Professional");
    assert.deepEqual([defaults.temperature, defaults.max_context_chunks, defaults.similarity_threshold], [0.2, 4, 0.7]);
    // Resetting after a saved override sends null so the gateway removes it.
    const saved = { ...form, agent_config: { ...form.agent_config, core_policy: "Custom" } };
    const reset = { ...form, agent_config: defaultAgentConfig(form) };
    assert.equal(profilePayload(reset, saved).agent_config.core_policy, null);
});

test("conversation recording is always sent as an explicit boolean, off unless switched on", () => {
    assert.equal(profilePayload(form, form).record_conversations, false);
    assert.equal(profilePayload({ ...form, record_conversations: true }, form).record_conversations, true);
    assert.equal(profilePayload({ ...form, record_conversations: "true" }, form).record_conversations, false);
});

test("phone can be removed without changing untouched origin fallback", () => {
    const payload = profilePayload({ ...form, contact_phone: "" }, form);
    assert.equal(payload.contact_phone, "");
    assert.equal("widget_config" in payload, false);
});

test("policy display uses the actual gateway policy and handles older gateways", () => {
    assert.deepEqual(readAssistantPolicy(form), form.assistant_policy);
    assert.equal(readAssistantPolicy({}), null);
    assert.equal(readAssistantPolicy({ assistant_policy: { version: "1" } }), null);
});
