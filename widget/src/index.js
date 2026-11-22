/**
 * Public entry point of the `@ownhelp/widget` npm package (React import build).
 * Anything exported here is part of the published API and must stay in sync with
 * widget/types/index.d.ts. The <script> embed uses src/embed.jsx instead.
 */
export { default as ChatWidget } from "./components/IsolatedChatWidget.jsx";
export { streamChat, submitContact, ChatError } from "./lib/chatClient.js";
export { getSessionId, newSessionId } from "./lib/session.js";
