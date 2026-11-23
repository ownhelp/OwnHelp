/**
 * Date display helpers for the dashboard.
 *
 * The gateway stores and returns timestamps as UTC ISO strings (correct, and unambiguous). Showing
 * them with Date#toISOString() prints UTC, so admins saw times hours off from their own clock.
 * These helpers format the same instant in the viewer's local timezone, keeping the familiar
 * "YYYY-MM-DD HH:mm" layout.
 *
 * Used by: TicketTable, TicketDetailModal and DocumentTable. Only call them from client code that
 * runs after the data loads, since the server's timezone (usually UTC) would differ from the
 * browser's during server rendering.
 */

const pad = (n) => String(n).padStart(2, "0");

/**
 * Formats a timestamp in the viewer's local timezone.
 * Options: seconds (include :ss), zone (append the short timezone name, e.g. "MST").
 * Returns `fallback` for a missing or unparseable value.
 */
export function formatLocalDateTime(value, { seconds = false, zone = false, fallback = "—" } = {}) {
    if (!value) return fallback;
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return fallback;
    let text =
        `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
        `${pad(date.getHours())}:${pad(date.getMinutes())}`;
    if (seconds) text += `:${pad(date.getSeconds())}`;
    if (zone) {
        const name = new Intl.DateTimeFormat(undefined, { timeZoneName: "short" })
            .formatToParts(date)
            .find((part) => part.type === "timeZoneName");
        if (name) text += ` ${name.value}`;
    }
    return text;
}
