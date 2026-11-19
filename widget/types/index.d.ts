import type { ComponentType } from "react";

export interface ChatWidgetProps {
    /** Base URL of the gateway, e.g. "https://support.example.com". The widget posts to `{apiUrl}/api/chat`. */
    apiUrl: string;
    /** Tenant the visitor is chatting with. */
    tenantId: string;
    title?: string;
    greeting?: string;
    position?: "left" | "right";
    /** Any CSS colour, e.g. "#0b6e4f". */
    accentColor?: string;
    defaultOpen?: boolean;
    /** Override `fetch` (tests, custom auth proxies). */
    fetchImpl?: typeof fetch;
}

export const ChatWidget: ComponentType<ChatWidgetProps>;

/** Error thrown by `streamChat` and `submitContact`. Show visitors a fixed message, not `message`. */
export class ChatError extends Error {
    /** Gateway code (e.g. "rate_limited") or client code ("network_error", "timeout", "aborted", ...). */
    code: string;
    /** HTTP status, when the error came from a response. */
    status?: number;
    /** Seconds from the `Retry-After` header of a 429, when present. */
    retryAfterSec?: number;
    constructor(code: string, message: string, status?: number, retryAfterSec?: number);
}

export interface StreamChatOptions {
    apiUrl: string;
    tenantId: string;
    message: string;
    sessionId: string;
    signal?: AbortSignal;
    onToken?: (text: string) => void;
    idleTimeoutMs?: number;
    fetchImpl?: typeof fetch;
}

export interface FollowUp {
    available: true;
    token: string;
    contactEmail?: string;
    contactPhone?: string;
}
/** Sends one message and streams the reply; `onToken` receives text deltas. Rejects with `ChatError`. */
export function streamChat(options: StreamChatOptions): Promise<{ answer: string; sessionId: string; followUp?: FollowUp }>;
export interface ContactOptions {
    apiUrl: string;
    tenantId: string;
    sessionId: string;
    followUpToken: string;
    name: string;
    email: string;
    signal?: AbortSignal;
    fetchImpl?: typeof fetch;
}
/** Saves visitor contact details for staff follow-up (persisted, not emailed). */
export function submitContact(options: ContactOptions): Promise<{ status: "saved" }>;

/** Stable per-tenant visitor session id (localStorage, in-memory fallback). */
export function getSessionId(tenantId: string, storage?: Pick<Storage, "getItem" | "setItem"> | null): string;

/** Creates and persists a fresh session id for the tenant (used by "New chat"). */
export function newSessionId(tenantId: string, storage?: Pick<Storage, "getItem" | "setItem"> | null): string;
