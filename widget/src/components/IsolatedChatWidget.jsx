// The component exported from the npm package. It renders ChatWidget inside a shadow root so the
// host page's CSS (element selectors such as `section` or `header`, `*`, `!important` rules)
// cannot change the widget, the same isolation the <script> embed has.
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import ChatWidget from "./ChatWidget.jsx";

/**
 * Same props as ChatWidget. Renders an empty host <div> during server-side rendering and the first
 * client render, then attaches a shadow root and portals the widget (markup and <style>) into it.
 * `--cw-*` custom properties set on an ancestor still inherit through the shadow boundary.
 */
export default function IsolatedChatWidget(props) {
    const [host, setHost] = useState(null);
    const [shadowRoot, setShadowRoot] = useState(null);

    useEffect(() => {
        if (!host) return;
        // attachShadow throws if the element already has one (StrictMode runs effects twice).
        setShadowRoot(host.shadowRoot || host.attachShadow({ mode: "open" }));
    }, [host]);

    return (
        <div ref={setHost} data-support-widget={props.tenantId}>
            {shadowRoot ? createPortal(<ChatWidget {...props} />, shadowRoot) : null}
        </div>
    );
}
