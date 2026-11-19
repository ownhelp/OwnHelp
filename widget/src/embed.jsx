// Entry point of the self-mounting <script> build (dist/widget.js). It reads its own
// data-* attributes, creates a host element with a shadow root and renders ChatWidget in it.
import { createRoot } from "react-dom/client";
import ChatWidget from "./components/ChatWidget.jsx";

/**
 * <script> embed entry point.
 *
 *   <script src="https://support.example.com/widget.js"
 *           data-tenant-id="example_tenant"
 *           data-api-url="https://support.example.com"
 *           data-title="Example Support"
 *           data-greeting="Hi! Ask me anything."
 *           data-position="right"
 *           data-accent-color="#0b6e4f"
 *           defer></script>
 *
 * The widget renders inside a shadow root so host-page CSS cannot affect it.
 */
function mount(script) {
    if (!script) {
        console.error("[support-widget] Could not find the <script> tag with data-tenant-id.");
        return;
    }
    const tenantId = script.dataset.tenantId;
    if (!tenantId) {
        console.error("[support-widget] Missing required data-tenant-id attribute.");
        return;
    }

    let apiUrl = script.dataset.apiUrl;
    if (!apiUrl) {
        // Default to the origin that served the script: correct when the gateway itself serves
        // /widget.js, wrong when the script comes from a CDN (then data-api-url is required).
        try {
            apiUrl = new URL(script.src).origin;
        } catch {
            apiUrl = window.location.origin;
        }
    }

    const host = document.createElement("div");
    host.setAttribute("data-support-widget", tenantId);
    document.body.appendChild(host);
    const shadow = host.attachShadow({ mode: "open" });
    const container = document.createElement("div");
    shadow.appendChild(container);

    createRoot(container).render(
        <ChatWidget
            apiUrl={apiUrl}
            tenantId={tenantId}
            title={script.dataset.title || undefined}
            greeting={script.dataset.greeting || undefined}
            position={script.dataset.position || undefined}
            accentColor={script.dataset.accentColor || undefined}
        />
    );
}

// document.currentScript is only valid synchronously (and is null for module scripts
// such as the Vite dev page), so capture it now and fall back to a selector.
const embedScript = document.currentScript || document.querySelector("script[data-tenant-id]");

if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => mount(embedScript));
} else {
    mount(embedScript);
}
