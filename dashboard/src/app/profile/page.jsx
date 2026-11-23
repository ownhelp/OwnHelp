"use client";

/**
 * Profile route ("/profile"): edits business identity, validated public contact details, allowed
 * widget origins, the opt-in conversation-recording switch and the agent runtime config (Business
 * Instructions, tone, temperature, context chunks, similarity threshold). The form loads from
 * GET /api/tenants/:id/config for the active tenant and saves with PUT to the same URL; the page
 * keeps a savedSnapshot to detect unsaved edits and to power "Discard Changes". The core assistant
 * policy shows the default until the admin
 * confirms a warning and edits it (reset to default removes the override); save payloads are
 * built by src/lib/profile.mjs so server-owned fields are never written back.
 */

import BusinessPhoneInput from "@/components/BusinessPhoneInput";
import { splitContactPhone, validateContactFields } from "@/lib/contactValidation.mjs";
import React, { useState, useEffect, useCallback } from "react";
import { useTenant } from "@/context/TenantContext";
import { fetchTenantConfig, updateTenantConfig } from "@/lib/api";
import ConfigSlider from "@/components/ConfigSlider";
import { Switch } from "@/components/ui/switch";
import { DEFAULT_AGENT_TONE, TONE_PRESETS } from "@/lib/agentDefaults.mjs";
import { originsToText } from "@/lib/origins.mjs";
import { defaultAgentConfig, profilePayload, readAssistantPolicy } from "@/lib/profile.mjs";

const INITIAL_FORM = {
    tenant_id: "",
    name: "",
    industry: "",
    contact_email: "",
    contact_phone: "",
    contact_phone_extension: "",
    assistant_policy: null,
    team_name: "",
    // One origin per line, as typed (widget_config.allowed_origins).
    allowed_origins: "",
    // Opt-in research log of chat turns; off unless an admin turns it on.
    record_conversations: false,
    agent_config: {
        system_prompt: "",
        // "" means the shipped default core policy applies.
        core_policy: "",
        agent_tone: DEFAULT_AGENT_TONE,
        temperature: 0.2,
        max_context_chunks: 4,
        similarity_threshold: 0.7,
    },
    updated_at: null,
};

// Maps the gateway's business document to form state. The fallbacks match the gateway's defaults,
// so an older document missing a field still renders; the phone is split into number and extension.
function normalizeDocToForm(doc) {
    const phone = splitContactPhone(doc?.contact_phone || "");
    return {
        tenant_id: doc?.tenant_id || "",
        name: doc?.name || "",
        industry: doc?.industry || "",
        contact_email: doc?.contact_email || "",
        contact_phone: phone.number,
        contact_phone_extension: phone.extension,
        assistant_policy: readAssistantPolicy(doc),
        team_name: doc?.team_name || "",
        allowed_origins: originsToText(doc?.widget_config?.allowed_origins),
        record_conversations: doc?.record_conversations === true,
        agent_config: {
            system_prompt: doc?.agent_config?.system_prompt || "",
            core_policy: doc?.agent_config?.core_policy || "",
            agent_tone: doc?.agent_config?.agent_tone || DEFAULT_AGENT_TONE,
            temperature:
                typeof doc?.agent_config?.temperature === "number"
                    ? doc.agent_config.temperature
                    : 0.2,
            max_context_chunks:
                typeof doc?.agent_config?.max_context_chunks === "number"
                    ? doc.agent_config.max_context_chunks
                    : 4,
            similarity_threshold:
                typeof doc?.agent_config?.similarity_threshold === "number"
                    ? doc.agent_config.similarity_threshold
                    : 0.7,
        },
        updated_at: doc?.updated_at || null,
    };
}

/** Page component, no props; edits the active tenant from TenantContext. */
export default function ProfilePage() {
    const {
        activeTenantId,
        updateTenantInList,
        loading: tenantsLoading,
    } = useTenant();

    const [form, setForm] = useState(INITIAL_FORM);
    const [savedSnapshot, setSavedSnapshot] = useState(INITIAL_FORM);
    const [loadingConfig, setLoadingConfig] = useState(false);
    const [saving, setSaving] = useState(false);
    const [contactTouched, setContactTouched] = useState({});
    const contactErrors = validateContactFields(form);
    const touchContact = (field) => setContactTouched((prev) => ({ ...prev, [field]: true }));
    const [loadError, setLoadError] = useState(null);
    const [toast, setToast] = useState(null);
    // The core policy stays locked until the admin confirms the warning.
    const [policyUnlocked, setPolicyUnlocked] = useState(false);
    const [showPolicyWarning, setShowPolicyWarning] = useState(false);
    const [showDefaultsWarning, setShowDefaultsWarning] = useState(false);

    const showToast = useCallback((type, title, message) => {
        setToast({ type, title, message, id: Date.now() });
    }, []);

    useEffect(() => {
        if (!toast) return;
        const timer = setTimeout(() => {
            setToast(null);
        }, 4500);
        return () => clearTimeout(timer);
    }, [toast]);

    // Manual reload for the error banner's Retry button; the effect below does the automatic load
    // when the active tenant changes (and also re-locks the policy editor).
    const loadActiveTenantConfig = useCallback(async (tenantId) => {
        if (!tenantId) return;
        setLoadingConfig(true);
        setLoadError(null);
        try {
            const doc = await fetchTenantConfig(tenantId);
            const normalized = normalizeDocToForm(doc);
            setForm(normalized);
            setSavedSnapshot(normalized);
        } catch (err) {
            setLoadError(
                err.message || "Failed to load tenant configuration from Gateway."
            );
        } finally {
            setLoadingConfig(false);
        }
    }, []);

    useEffect(() => {
        if (!activeTenantId) return;
        let cancelled = false;

        async function fetchConfigForTenant() {
            // Deferring one microtask keeps the setState calls below out of the effect's synchronous body.
            await Promise.resolve();
            if (cancelled) return;
            setLoadingConfig(true);
            setLoadError(null);
            try {
                const doc = await fetchTenantConfig(activeTenantId);
                if (!cancelled) {
                    const normalized = normalizeDocToForm(doc);
                    setPolicyUnlocked(false);
                    setForm(normalized);
                    setSavedSnapshot(normalized);
                }
            } catch (err) {
                if (!cancelled) {
                    setLoadError(
                        err.message ||
                            "Failed to load tenant configuration from Gateway."
                    );
                }
            } finally {
                if (!cancelled) {
                    setLoadingConfig(false);
                }
            }
        }

        fetchConfigForTenant();
        return () => {
            cancelled = true;
        };
    }, [activeTenantId]);

    const handleIdentityChange = (field, value) => {
        setForm((prev) => ({
            ...prev,
            [field]: value,
        }));
    };

    const handleAgentConfigChange = (field, value) => {
        setForm((prev) => ({
            ...prev,
            agent_config: {
                ...prev.agent_config,
                [field]: value,
            },
        }));
    };

    const defaultPolicyText = form.assistant_policy?.system_prompt || "";
    // Shown text: the tenant's override, or the shipped default when none is set.
    const policyText = form.agent_config.core_policy || defaultPolicyText;
    const policyIsCustom = policyText.trim() !== defaultPolicyText.trim();

    const unlockPolicy = () => {
        // Start the edit from the text currently in effect so nothing is lost.
        handleAgentConfigChange("core_policy", policyText);
        setPolicyUnlocked(true);
        setShowPolicyWarning(false);
    };

    // Takes effect on Save, like every other field; Discard Changes undoes it before then.
    const resetPolicyToDefault = () => {
        handleAgentConfigChange("core_policy", "");
        setPolicyUnlocked(false);
    };

    // Fills the agent settings with a new business's defaults. Like every other edit it is only
    // stored on Save, and Discard Changes undoes it.
    const applyAgentDefaults = () => {
        setForm((prev) => ({ ...prev, agent_config: defaultAgentConfig(prev) }));
        setPolicyUnlocked(false);
        setShowDefaultsWarning(false);
        showToast(
            "info",
            "Defaults Applied",
            "Agent settings are back to their defaults. Save Configuration to keep them, or Discard Changes to undo."
        );
    };

    const handleReset = () => {
        setForm(savedSnapshot);
        setPolicyUnlocked(false);
        setContactTouched({});
        showToast(
            "info",
            "Changes Discarded",
            "Reverted fields to the last saved MongoDB configuration."
        );
    };

    const handleSave = async (e) => {
        if (e) e.preventDefault();
        if (!activeTenantId) return;

        setContactTouched({ contact_email: true, contact_phone: true, contact_phone_extension: true });
        if (Object.keys(contactErrors).length) {
            showToast("error", "Check Contact Details", Object.values(contactErrors)[0]);
            return;
        }
        setSaving(true);
        try {
            const payload = profilePayload(form, savedSnapshot);

            const updatedDoc = await updateTenantConfig(activeTenantId, payload);
            const normalized = normalizeDocToForm(updatedDoc);
            setForm(normalized);
            setSavedSnapshot(normalized);
            setPolicyUnlocked(false);
            updateTenantInList(updatedDoc);

            showToast(
                "success",
                "Configuration Saved to MongoDB Atlas",
                `Updated runtime profile for ${normalized.name} (${normalized.tenant_id}).`
            );
        } catch (err) {
            showToast(
                "error",
                "Failed to Save Configuration",
                err.message || "Could not update tenant configuration."
            );
        } finally {
            setSaving(false);
        }
    };

    // Compares only the editable fields; tenant_id, the read-only assistant_policy and updated_at
    // never change through the form, so they are left out.
    const hasUnsavedChanges =
        JSON.stringify({
            name: form.name,
            industry: form.industry,
            contact_email: form.contact_email,
            contact_phone: form.contact_phone,
            contact_phone_extension: form.contact_phone_extension,
            team_name: form.team_name,
            allowed_origins: form.allowed_origins,
            record_conversations: form.record_conversations,
            agent_config: form.agent_config,
        }) !==
        JSON.stringify({
            name: savedSnapshot.name,
            industry: savedSnapshot.industry,
            contact_email: savedSnapshot.contact_email,
            contact_phone: savedSnapshot.contact_phone,
            contact_phone_extension: savedSnapshot.contact_phone_extension,
            team_name: savedSnapshot.team_name,
            allowed_origins: savedSnapshot.allowed_origins,
            record_conversations: savedSnapshot.record_conversations,
            agent_config: savedSnapshot.agent_config,
        });

    // Ask the browser to confirm before a reload or tab close throws away unsaved edits.
    // (Navigating with the sidebar is a client-side route change, which this cannot intercept.)
    useEffect(() => {
        if (!hasUnsavedChanges) return;
        const warnBeforeLeaving = (event) => {
            event.preventDefault();
            event.returnValue = "";
        };
        window.addEventListener("beforeunload", warnBeforeLeaving);
        return () => window.removeEventListener("beforeunload", warnBeforeLeaving);
    }, [hasUnsavedChanges]);

    return (
        <div className="min-h-full bg-zinc-950 text-zinc-100">
            {/* Status Notification */}
            {toast && (
                <div
                    role="status"
                    aria-live="polite"
                    className="fixed bottom-4 sm:bottom-5 left-4 right-4 sm:left-auto sm:right-5 z-50 sm:max-w-md"
                >
                    <div
                        className={`rounded border p-3.5 text-sm ${
                            toast.type === "error"
                                ? "bg-red-950 border-red-800 text-red-100"
                                : toast.type === "info"
                                ? "bg-zinc-900 border-zinc-700 text-zinc-100"
                                : "bg-zinc-900 border-emerald-700 text-zinc-100"
                        }`}
                    >
                        <p className="font-medium text-xs uppercase tracking-wide">
                            {toast.title}
                        </p>
                        <p className="text-xs text-zinc-300 mt-1">{toast.message}</p>
                    </div>
                </div>
            )}

            {/* Page Header */}
            <header className="bg-zinc-950 border-b border-zinc-800 px-4 sm:px-6 py-4">
                <div className="max-w-5xl mx-auto flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
                    <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
                            <h1 className="text-lg font-semibold text-zinc-100">
                                Tenant Profile & Runtime Configuration
                            </h1>
                            {form.tenant_id && (
                                <span
                                    data-testid="tenant-id-badge"
                                    className="rounded bg-zinc-900 border border-zinc-800 px-2 py-0.5 font-mono text-xs text-zinc-300"
                                >
                                    {form.tenant_id}
                                </span>
                            )}
                        </div>
                        <div className="text-xs text-zinc-400 mt-1 flex flex-wrap items-center gap-3">
                            <span>
                                Storefront identity and RAG / LLM runtime parameters persisted in MongoDB Atlas.
                            </span>
                            {form.updated_at && (
                                <span className="font-mono text-xs text-zinc-500">
                                    updated_at: {new Date(form.updated_at).toISOString()}
                                </span>
                            )}
                        </div>
                    </div>

                </div>
            </header>

            {/* Main Content */}
            <main className="max-w-5xl mx-auto px-4 sm:px-6 py-5 sm:py-6">
                {loadError && (
                    <div className="mb-6 rounded border border-red-900 bg-red-950/50 p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3 sm:gap-4 text-red-200">
                        <div className="text-sm">
                            <p className="font-medium">Failed to load tenant configuration</p>
                            <p className="text-xs text-red-300 mt-0.5">{loadError}</p>
                        </div>
                        <button
                            type="button"
                            onClick={() => loadActiveTenantConfig(activeTenantId)}
                            className="shrink-0 rounded border border-red-800 bg-red-900 px-3 py-2 sm:py-1.5 text-xs font-medium text-white hover:bg-red-800"
                        >
                            Retry
                        </button>
                    </div>
                )}

                {tenantsLoading || loadingConfig ? (
                    <div className="rounded border border-zinc-800 bg-zinc-900/40 p-8 text-center">
                        <p className="text-sm text-zinc-300">
                            Loading tenant configuration from MongoDB Atlas...
                        </p>
                        <p className="font-mono text-xs text-zinc-500 mt-1">
                            GET /api/tenants/{activeTenantId || "..."}/config
                        </p>
                    </div>
                ) : (
                    <form id="tenant-profile-form" onSubmit={handleSave} className="space-y-6">
                        {/* Card 1: Business Identity */}
                        <section className="rounded border border-zinc-800 bg-zinc-950">
                            <div className="border-b border-zinc-800 px-4 sm:px-5 py-3.5 flex flex-wrap items-center justify-between gap-x-4 gap-y-2 bg-zinc-900/40">
                                <div>
                                    <h2 className="text-sm font-semibold text-zinc-100">
                                        Business Identity
                                    </h2>
                                    <p className="text-xs text-zinc-400">
                                        Organization metadata for this tenant namespace.
                                    </p>
                                </div>

                                <div className="flex items-center gap-2">
                                    <span className="text-xs text-zinc-500">tenant_id:</span>
                                    <span className="rounded bg-zinc-900 border border-zinc-800 px-2 py-0.5 font-mono text-xs text-zinc-200">
                                        {form.tenant_id || activeTenantId}
                                    </span>
                                </div>
                            </div>

                            <div className="p-4 sm:p-5 grid grid-cols-1 md:grid-cols-2 gap-4">
                                {/* Business Name */}
                                <div>
                                    <label
                                        htmlFor="business-name"
                                        className="block text-xs font-medium text-zinc-300 mb-1.5"
                                    >
                                        Business Name
                                    </label>
                                    <input
                                        id="business-name"
                                        type="text"
                                        required
                                        value={form.name}
                                        onChange={(e) =>
                                            handleIdentityChange("name", e.target.value)
                                        }
                                        placeholder="Iron & Oak Provision Co."
                                        className="w-full bg-zinc-900 border border-zinc-800 rounded px-3 py-2 text-sm text-zinc-100 focus:border-zinc-600 focus:outline-none"
                                    />
                                </div>

                                {/* Sector / Industry */}
                                <div>
                                    <label
                                        htmlFor="business-industry"
                                        className="block text-xs font-medium text-zinc-300 mb-1.5"
                                    >
                                        Sector / Industry
                                    </label>
                                    <input
                                        id="business-industry"
                                        type="text"
                                        value={form.industry}
                                        onChange={(e) =>
                                            handleIdentityChange("industry", e.target.value)
                                        }
                                        placeholder="Outdoor Apparel & Heritage Gear"
                                        className="w-full bg-zinc-900 border border-zinc-800 rounded px-3 py-2 text-sm text-zinc-100 focus:border-zinc-600 focus:outline-none"
                                    />
                                </div>

                                {/* Support Email */}
                                <div>
                                    <label
                                        htmlFor="contact-email"
                                        className="block text-xs font-medium text-zinc-300 mb-1.5"
                                    >
                                        Support Email
                                    </label>
                                    <input
                                        id="contact-email"
                                        type="email"
                                        maxLength={254}
                                        autoComplete="email"
                                        onBlur={() => touchContact("contact_email")}
                                        aria-invalid={Boolean(contactTouched.contact_email && contactErrors.contact_email)}
                                        aria-describedby="contact-email-error"
                                        required
                                        value={form.contact_email}
                                        onChange={(e) =>
                                            handleIdentityChange(
                                                "contact_email",
                                                e.target.value
                                            )
                                        }
                                        placeholder="support@ironandoak.com"
                                        className="w-full bg-zinc-900 border border-zinc-800 rounded px-3 py-2 text-sm text-zinc-100 focus:border-zinc-600 focus:outline-none"
                                    />
                                    {contactTouched.contact_email && contactErrors.contact_email ? (
                                        <p id="contact-email-error" role="alert" className="text-xs text-red-400 mt-1.5">{contactErrors.contact_email}</p>
                                    ) : null}
                                </div>

                                {/* Team / Admin Name: sits beside Support Email so the short fields pair up */}
                                <div>
                                    <label
                                        htmlFor="team-name"
                                        className="block text-xs font-medium text-zinc-300 mb-1.5"
                                    >
                                        Team / Admin Name
                                    </label>
                                    <input
                                        id="team-name"
                                        type="text"
                                        value={form.team_name}
                                        onChange={(e) =>
                                            handleIdentityChange("team_name", e.target.value)
                                        }
                                        placeholder="Outfitter Support Team"
                                        className="w-full bg-zinc-900 border border-zinc-800 rounded px-3 py-2 text-sm text-zinc-100 focus:border-zinc-600 focus:outline-none"
                                    />
                                </div>

                                {/* Phone + extension: the tallest block, so it gets its own full row */}
                                <div className="md:col-span-2 md:max-w-xl">
                                    <label htmlFor="contact-phone" className="block text-xs font-medium text-zinc-300 mb-1.5">
                                        Public Support Phone (optional)
                                    </label>
                                    <BusinessPhoneInput
                                        id="contact-phone"
                                        value={form.contact_phone || undefined}
                                        onChange={(value) => {
                                            handleIdentityChange("contact_phone", value || "");
                                            if (!value) handleIdentityChange("contact_phone_extension", "");
                                        }}
                                        onBlur={() => touchContact("contact_phone")}
                                        placeholder="Phone number"
                                        autoComplete="tel"
                                        maxLength={50}
                                        aria-invalid={Boolean(contactTouched.contact_phone && contactErrors.contact_phone)}
                                        aria-describedby="contact-phone-help contact-phone-error"
                                    />
                                    {contactTouched.contact_phone && contactErrors.contact_phone ? (
                                        <p id="contact-phone-error" role="alert" className="text-xs text-red-400 mt-1.5">{contactErrors.contact_phone}</p>
                                    ) : null}
                                    <p id="contact-phone-help" className="text-xs text-zinc-500 mt-1.5">
                                        Choose a country, then enter the number. You can also paste a full international number.
                                    </p>
                                    <label htmlFor="contact-phone-extension" className="block text-xs font-medium text-zinc-300 mt-3 mb-1.5">
                                        Extension (optional)
                                    </label>
                                    <input id="contact-phone-extension" type="text" inputMode="numeric" maxLength={10}
                                        pattern="[0-9]{1,10}" value={form.contact_phone_extension}
                                        onChange={(e) => handleIdentityChange("contact_phone_extension", e.target.value)}
                                        onBlur={() => touchContact("contact_phone_extension")}
                                        aria-invalid={Boolean(contactTouched.contact_phone_extension && contactErrors.contact_phone_extension)}
                                        aria-describedby="contact-phone-extension-error"
                                        className="w-full bg-zinc-900 border border-zinc-800 rounded px-3 py-2 text-sm text-zinc-100 focus:border-zinc-600 focus:outline-none" />
                                    {contactTouched.contact_phone_extension && contactErrors.contact_phone_extension ? (
                                        <p id="contact-phone-extension-error" role="alert" className="text-xs text-red-400 mt-1.5">{contactErrors.contact_phone_extension}</p>
                                    ) : null}
                                    <p className="text-xs text-zinc-500 mt-1.5">
                                        Visitors may see this number for direct contact. Email follow-up is not immediate assistance.
                                    </p>
                                </div>
                            </div>
                        </section>

                        {/* Card: Chat widget allowed origins */}
                        <section className="rounded border border-zinc-800 bg-zinc-950">
                            <div className="border-b border-zinc-800 px-4 sm:px-5 py-3.5 bg-zinc-900/40">
                                <h2 className="text-sm font-semibold text-zinc-100">
                                    Chat Widget: Allowed Origins
                                </h2>
                                <p className="text-xs text-zinc-400">
                                    Websites that may embed this tenant&apos;s chat widget.
                                </p>
                            </div>
                            <div className="p-4 sm:p-5">
                                <label
                                    htmlFor="allowed-origins"
                                    className="block text-xs font-medium text-zinc-300 mb-1.5"
                                >
                                    Allowed origins (one per line)
                                </label>
                                <textarea
                                    id="allowed-origins"
                                    rows={4}
                                    value={form.allowed_origins}
                                    onChange={(e) =>
                                        handleIdentityChange("allowed_origins", e.target.value)
                                    }
                                    placeholder="https://shop.example.com"
                                    spellCheck={false}
                                    className="w-full bg-zinc-900 border border-zinc-800 rounded px-3 py-2 font-mono text-xs text-zinc-100 focus:border-zinc-600 focus:outline-none"
                                />
                                <p className="text-xs text-zinc-500 mt-1.5">
                                    Exact origins only: scheme, host and optional port, such as
                                    https://shop.example.com. No wildcards or paths. A site that is
                                    not listed gets &quot;not allowed&quot; when its visitors open
                                    the chat. If this has never been set, the gateway&apos;s default
                                    list applies; saving an empty list allows no site at all.
                                </p>
                            </div>
                        </section>

                        {/* Card 2: AI Agent Configuration */}
                        <section className="rounded border border-zinc-800 bg-zinc-950">
                            <div className="border-b border-zinc-800 px-4 sm:px-5 py-3.5 flex flex-wrap items-center justify-between gap-x-4 gap-y-2 bg-zinc-900/40">
                                <div>
                                    <h2 className="text-sm font-semibold text-zinc-100">
                                        AI Agent Configuration
                                    </h2>
                                    <p className="text-xs text-zinc-400">
                                        Core policy, business instructions, tone, and retrieval settings.
                                    </p>
                                </div>
                                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                                    <button
                                        type="button"
                                        onClick={() => setShowDefaultsWarning(true)}
                                        className="rounded border border-zinc-700 px-2.5 py-1.5 sm:py-1 text-xs text-zinc-200 hover:bg-zinc-800"
                                    >
                                        Set to defaults
                                    </button>
                                    <span className="font-mono text-xs text-zinc-400">
                                        Llama-3.2-3B-Instruct
                                    </span>
                                </div>
                                {showDefaultsWarning && (
                                    <div
                                        role="alertdialog"
                                        aria-modal="true"
                                        aria-labelledby="defaults-warning-title"
                                        className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 px-4"
                                    >
                                        <div className="w-full max-w-md max-h-[90dvh] overflow-y-auto rounded border border-amber-700 bg-zinc-950 p-4 sm:p-5">
                                            <h3 id="defaults-warning-title" className="text-sm font-semibold text-amber-300">
                                                Set all agent settings to defaults?
                                            </h3>
                                            <p className="mt-3 text-xs text-zinc-300">This will replace:</p>
                                            <ul className="mt-1.5 list-disc space-y-1 pl-5 text-xs text-zinc-300">
                                                <li>
                                                    <strong>Business Instructions</strong> with the generated text built from
                                                    your business name, industry and contact email. Your current text will be lost.
                                                </li>
                                                <li>
                                                    <strong>Core Assistant Policy</strong> with the shipped default (any custom
                                                    policy is removed).
                                                </li>
                                                <li>
                                                    <strong>Agent Tone</strong> with &quot;{defaultAgentConfig(form).agent_tone}&quot;.
                                                </li>
                                                <li>
                                                    <strong>Temperature, context chunks and similarity threshold</strong> with
                                                    {" "}{defaultAgentConfig(form).temperature}, {defaultAgentConfig(form).max_context_chunks} and{" "}
                                                    {defaultAgentConfig(form).similarity_threshold}.
                                                </li>
                                            </ul>
                                            <p className="mt-3 text-xs text-zinc-400">
                                                Not changed: business name, industry, contact details, allowed widget origins,
                                                your documents and your account.
                                            </p>
                                            <p className="mt-2 text-xs text-zinc-400">
                                                The new values appear in the form but are not saved until you click Save
                                                Configuration. Discard Changes undoes them.
                                            </p>
                                            <div className="mt-5 flex flex-col-reverse sm:flex-row sm:justify-end gap-2">
                                                <button
                                                    type="button"
                                                    onClick={() => setShowDefaultsWarning(false)}
                                                    className="rounded border border-zinc-700 px-3 py-2.5 sm:py-1.5 text-xs text-zinc-200 hover:bg-zinc-800"
                                                >
                                                    Cancel
                                                </button>
                                                <button
                                                    type="button"
                                                    onClick={applyAgentDefaults}
                                                    className="rounded bg-amber-600 px-3 py-2.5 sm:py-1.5 text-xs font-medium text-black hover:bg-amber-500"
                                                >
                                                    Set to defaults
                                                </button>
                                            </div>
                                        </div>
                                    </div>
                                )}
                            </div>

                            <div className="p-4 sm:p-5 space-y-5">
                                <div>
                                    <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5 mb-1.5">
                                        <label htmlFor="assistant-policy" className="text-xs font-medium text-zinc-300">
                                            Core Assistant Policy{" "}
                                            {policyUnlocked ? "(editing)" : policyIsCustom ? "(customized)" : "(default)"}
                                        </label>
                                        {form.assistant_policy && (
                                            <div className="flex items-center gap-2">
                                                {!policyUnlocked && (
                                                    <button
                                                        type="button"
                                                        onClick={() => setShowPolicyWarning(true)}
                                                        className="rounded border border-zinc-700 px-2.5 py-1 text-xs text-zinc-200 hover:bg-zinc-800"
                                                    >
                                                        Edit policy
                                                    </button>
                                                )}
                                                <button
                                                    type="button"
                                                    onClick={resetPolicyToDefault}
                                                    disabled={!policyIsCustom}
                                                    className="rounded border border-zinc-700 px-2.5 py-1 text-xs text-zinc-200 hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-40"
                                                >
                                                    Reset to default
                                                </button>
                                            </div>
                                        )}
                                    </div>
                                    {form.assistant_policy ? (
                                        <>
                                            <p className="text-xs text-zinc-500 mb-2">
                                                Default version {form.assistant_policy.version}
                                                {policyUnlocked || policyIsCustom
                                                    ? ` · ${policyText.length} chars`
                                                    : ""}
                                            </p>
                                            <textarea
                                                id="assistant-policy"
                                                readOnly={!policyUnlocked}
                                                rows={12}
                                                maxLength={8000}
                                                value={policyText}
                                                onChange={(e) =>
                                                    handleAgentConfigChange("core_policy", e.target.value)
                                                }
                                                className={`w-full rounded px-3 py-2 font-mono text-xs leading-relaxed focus:outline-none ${
                                                    policyUnlocked
                                                        ? "bg-zinc-900 border border-amber-700 text-zinc-100 focus:border-amber-500"
                                                        : "bg-zinc-900 border border-zinc-800 text-zinc-300 focus:border-zinc-600"
                                                }`}
                                            />
                                        </>
                                    ) : (
                                        <p id="assistant-policy" className="text-xs text-amber-300">
                                            The gateway did not provide its core policy. Update the gateway to view or edit the active policy here.
                                        </p>
                                    )}
                                    <p className="mt-1 text-xs text-zinc-500">
                                        The default requires grounded answers, human follow-up when needed, and accurate
                                        contact guidance, and is written for a small business. You can replace it if it does
                                        not fit your site. Changes apply when you save; reset to default restores the original text.
                                    </p>
                                    {showPolicyWarning && (
                                        <div
                                            role="alertdialog"
                                            aria-modal="true"
                                            aria-labelledby="policy-warning-title"
                                            className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 px-4"
                                        >
                                            <div className="w-full max-w-md max-h-[90dvh] overflow-y-auto rounded border border-amber-700 bg-zinc-950 p-4 sm:p-5">
                                                <h3 id="policy-warning-title" className="text-sm font-semibold text-amber-300">
                                                    Edit the core policy?
                                                </h3>
                                                <ul className="mt-3 list-disc space-y-1.5 pl-5 text-xs text-zinc-300">
                                                    <li>
                                                        This is the main instruction the assistant follows. Weak or contradictory
                                                        wording can make answers worse or ungrounded.
                                                    </li>
                                                    <li>
                                                        The default tells the model to answer only from your documents and never
                                                        invent facts. Removing that can cause made-up answers.
                                                    </li>
                                                    <li>
                                                        The model was fine-tuned on the default wording, so a small 3B model may
                                                        follow a heavily rewritten policy less reliably.
                                                    </li>
                                                    <li>
                                                        Replies are still returned in the required JSON format, and promises to
                                                        transfer or email on your behalf are still blocked.
                                                    </li>
                                                    <li>
                                                        You can always use &quot;Reset to default&quot; to restore the original.
                                                    </li>
                                                </ul>
                                                <div className="mt-5 flex flex-col-reverse sm:flex-row sm:justify-end gap-2">
                                                    <button
                                                        type="button"
                                                        onClick={() => setShowPolicyWarning(false)}
                                                        className="rounded border border-zinc-700 px-3 py-2.5 sm:py-1.5 text-xs text-zinc-200 hover:bg-zinc-800"
                                                    >
                                                        Cancel
                                                    </button>
                                                    <button
                                                        type="button"
                                                        onClick={unlockPolicy}
                                                        className="rounded bg-amber-600 px-3 py-2.5 sm:py-1.5 text-xs font-medium text-black hover:bg-amber-500"
                                                    >
                                                        I understand, edit policy
                                                    </button>
                                                </div>
                                            </div>
                                        </div>
                                    )}
                                </div>

                                {/* Business Instructions Editor */}
                                <div>
                                    <div className="flex items-center justify-between mb-1.5">
                                        <label
                                            htmlFor="system-prompt"
                                            className="text-xs font-medium text-zinc-300"
                                        >
                                            Business Instructions
                                        </label>
                                        <span className="font-mono text-xs text-zinc-500">
                                            {form.agent_config.system_prompt.length} chars
                                        </span>
                                    </div>
                                    <textarea
                                        id="system-prompt"
                                        rows={5}
                                        required
                                        value={form.agent_config.system_prompt}
                                        onChange={(e) =>
                                            handleAgentConfigChange(
                                                "system_prompt",
                                                e.target.value
                                            )
                                        }
                                        placeholder="You are a customer support agent for... Answer questions strictly using the provided context chunks."
                                        className="w-full bg-zinc-900 border border-zinc-800 rounded px-3 py-2 font-mono text-xs leading-relaxed text-zinc-100 focus:border-zinc-600 focus:outline-none"
                                    />
                                    <p className="mt-1 text-xs text-zinc-500">
                                        Describe your business and preferred response style. These instructions are subordinate to the core policy above.
                                    </p>
                                </div>

                                {/* Agent Tone Input + Quick-Select Preset Chips */}
                                <div>
                                    <label
                                        htmlFor="agent-tone"
                                        className="block text-xs font-medium text-zinc-300 mb-1.5"
                                    >
                                        Agent Tone
                                    </label>
                                    <input
                                        id="agent-tone"
                                        type="text"
                                        required
                                        value={form.agent_config.agent_tone}
                                        onChange={(e) =>
                                            handleAgentConfigChange("agent_tone", e.target.value)
                                        }
                                        placeholder="Warm & Professional"
                                        className="w-full bg-zinc-900 border border-zinc-800 rounded px-3 py-2 text-sm text-zinc-100 focus:border-zinc-600 focus:outline-none"
                                    />

                                    <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
                                        <span className="font-mono text-xs text-zinc-500 mr-1">
                                            presets:
                                        </span>
                                        {TONE_PRESETS.map((preset) => {
                                            const active =
                                                form.agent_config.agent_tone.toLowerCase() ===
                                                preset.toLowerCase();
                                            return (
                                                <button
                                                    key={preset}
                                                    type="button"
                                                    onClick={() =>
                                                        handleAgentConfigChange(
                                                            "agent_tone",
                                                            preset
                                                        )
                                                    }
                                                    className={`rounded px-2.5 py-1 text-xs cursor-pointer border ${
                                                        active
                                                            ? "bg-zinc-100 text-zinc-900 border-zinc-100 font-medium"
                                                            : "bg-zinc-900 text-zinc-300 border-zinc-800 hover:border-zinc-700"
                                                    }`}
                                                >
                                                    {preset}
                                                </button>
                                            );
                                        })}
                                    </div>
                                </div>

                                {/* Runtime Parameter Sliders */}
                                <div className="pt-1">
                                    <h3 className="text-xs font-medium text-zinc-300 mb-2.5">
                                        Runtime Parameters
                                    </h3>
                                    <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
                                        <ConfigSlider
                                            id="slider-temperature"
                                            label="Temperature"
                                            description="Sampling randomness (0.00–1.00)."
                                            value={form.agent_config.temperature}
                                            min={0.0}
                                            max={1.0}
                                            step={0.05}
                                            formatValue={(v) => v.toFixed(2)}
                                            minLabel="0.00"
                                            maxLabel="1.00"
                                            onChange={(val) =>
                                                handleAgentConfigChange("temperature", val)
                                            }
                                        />

                                        <ConfigSlider
                                            id="slider-max-chunks"
                                            label="Max Context Chunks"
                                            description="Top-K chunks retrieved per query."
                                            value={form.agent_config.max_context_chunks}
                                            min={1}
                                            max={8}
                                            step={1}
                                            formatValue={(v) => `${v}`}
                                            minLabel="1"
                                            maxLabel="8"
                                            onChange={(val) =>
                                                handleAgentConfigChange(
                                                    "max_context_chunks",
                                                    Math.round(val)
                                                )
                                            }
                                        />

                                        <ConfigSlider
                                            id="slider-similarity-threshold"
                                            label="Similarity Threshold"
                                            description="Minimum cosine similarity score."
                                            value={form.agent_config.similarity_threshold}
                                            min={0.5}
                                            max={0.95}
                                            step={0.01}
                                            formatValue={(v) => v.toFixed(2)}
                                            minLabel="0.50"
                                            maxLabel="0.95"
                                            onChange={(val) =>
                                                handleAgentConfigChange(
                                                    "similarity_threshold",
                                                    val
                                                )
                                            }
                                        />
                                    </div>
                                </div>
                            </div>

                        </section>

                        {/* Card: Conversation recording (opt-in research log) */}
                        <section className="rounded border border-zinc-800 bg-zinc-950">
                            <div className="border-b border-zinc-800 px-4 sm:px-5 py-3.5 bg-zinc-900/40">
                                <h2 className="text-sm font-semibold text-zinc-100">
                                    Conversation Recording
                                </h2>
                                <p className="text-xs text-zinc-400">
                                    Optionally keep every chat turn, including ones that are not escalated, for review and research.
                                </p>
                            </div>
                            <div className="p-4 sm:p-5 space-y-3">
                                <div className="flex items-start gap-3">
                                    <Switch
                                        id="record-conversations"
                                        checked={form.record_conversations}
                                        onCheckedChange={(value) =>
                                            handleIdentityChange("record_conversations", value)
                                        }
                                        className="mt-1"
                                    />
                                    <label htmlFor="record-conversations" className="cursor-pointer text-sm text-zinc-200">
                                        Record conversations with the assistant
                                        <span className="block text-xs text-zinc-400 mt-0.5">
                                            Off by default. Takes effect when you save.
                                        </span>
                                    </label>
                                </div>
                                <div className="rounded border border-zinc-800 bg-zinc-900/40 px-3 py-2.5 text-xs text-zinc-300 space-y-1.5">
                                    <p>
                                        <strong>Visitors are told.</strong> While this is on, the chat widget shows
                                        &quot;This conversation is recorded to improve the assistant.&quot; A message is
                                        only recorded if the widget showed that notice, so older cached copies of
                                        the widget are never recorded.
                                    </p>
                                    <p>
                                        <strong>Stored per message:</strong> the question (e-mail addresses and phone-like
                                        numbers replaced), the answer, action, confidence, cited and retrieved document
                                        ids with scores, response time, and the settings in force.
                                    </p>
                                    <p>
                                        <strong>Not stored:</strong> IP address, browser details, the visitor&apos;s session id,
                                        document text, or contact details left in the follow-up form.
                                    </p>
                                    <p className="text-zinc-400">
                                        Records are kept until you delete them. Export them with
                                        scripts/export_conversations.py.
                                    </p>
                                </div>
                            </div>
                        </section>

                        {/* Action bar: stays at the bottom of the screen while the form is on screen, so
                            Save is always reachable (long forms, phones) and unsaved edits are visible. */}
                        <div
                            className={`sticky bottom-0 z-30 rounded border px-4 sm:px-5 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] flex flex-col sm:flex-row sm:items-center justify-between gap-3 shadow-[0_-8px_16px_rgba(0,0,0,0.4)] ${
                                hasUnsavedChanges
                                    ? "border-amber-700 bg-zinc-950"
                                    : "border-zinc-800 bg-zinc-950"
                            }`}
                        >
                            <div className="font-mono text-xs text-zinc-400" role="status">
                                {hasUnsavedChanges ? (
                                    <span className="text-amber-400">
                                        Unsaved changes. Save Configuration to keep them.
                                    </span>
                                ) : (
                                    <span>status: synced (businesses)</span>
                                )}
                            </div>

                            <div className="grid grid-cols-2 sm:flex items-center gap-2">
                                <button
                                    type="button"
                                    onClick={handleReset}
                                    disabled={!hasUnsavedChanges || saving || loadingConfig}
                                    className="rounded border border-zinc-800 bg-zinc-900 px-3 py-2.5 sm:py-1.5 text-xs font-medium text-zinc-200 hover:bg-zinc-800 disabled:opacity-40 disabled:pointer-events-none cursor-pointer"
                                >
                                    Discard Changes
                                </button>
                                <button
                                    type="submit"
                                    disabled={saving || loadingConfig || !activeTenantId}
                                    className="rounded bg-zinc-100 hover:bg-white px-4 py-2.5 sm:py-1.5 text-xs font-medium text-zinc-900 disabled:opacity-50 disabled:pointer-events-none cursor-pointer"
                                >
                                    {saving ? "Saving..." : "Save Configuration"}
                                </button>
                            </div>
                        </div>
                    </form>
                )}
            </main>
        </div>
    );
}
