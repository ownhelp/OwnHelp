/**
 * Validation for the public support email and phone on the profile page. Pure functions (no React)
 * so they can be tested with `node --test`. Phones are stored in E.164 with an optional " xNNN"
 * extension suffix.
 */
import isEmail from "validator/lib/isEmail.js";
import { parsePhoneNumberFromString } from "libphonenumber-js/max";

/** Splits a stored value such as "+44 20 7946 0018 #123" into { number, extension }. */
export function splitContactPhone(value = "") {
    const match = /^(.*?)(?:\s*[xX#]\s*(\d+))?$/.exec(value.trim());
    return { number: match?.[1]?.trim() || "", extension: match?.[2] || "" };
}

/**
 * Returns "" for an empty phone, the E.164 string (plus " xEXT") when valid, or null when invalid.
 * The character whitelist runs first so text like "Call +1..." or "javascript:..." is rejected
 * before libphonenumber can extract a number from it (extract: false).
 */
export function normalizeContactPhone(number, extension = "") {
    if (!number.trim() && !extension) return "";
    if (number.length > 50 || !/^\+?[0-9 ().-]+$/.test(number.trim()) ||
        (extension && !/^\d{1,10}$/.test(extension))) return null;
    const phone = parsePhoneNumberFromString(number, { extract: false });
    if (!phone?.isValid()) return null;
    return phone.number + (extension ? ` x${extension}` : "");
}

/** Returns a map of field name to error message; an empty object means the form is valid. */
export function validateContactFields(form) {
    const errors = {};
    const email = form.contact_email.trim();
    if (email.length > 254 || !isEmail(email, { allow_utf8_local_part: false })) {
        errors.contact_email = "Enter a valid email address, such as support@example.com.";
    }
    if (normalizeContactPhone(form.contact_phone, form.contact_phone_extension || "") === null) {
        errors.contact_phone = "Select a country and enter a valid phone number, or leave it empty.";
    }
    if (form.contact_phone_extension && !/^\d{1,10}$/.test(form.contact_phone_extension)) {
        errors.contact_phone_extension = "Use 1–10 digits for the extension.";
    }
    return errors;
}
