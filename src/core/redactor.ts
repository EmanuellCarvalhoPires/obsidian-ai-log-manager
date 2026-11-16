// Masks tokens, passwords and private keys before anything is written to a log note or spool file.
// Placeholders ({{secret:X}}, {{basic:X}}, {{bearer:X}}) are not secrets and stay visible.

export const REDACTED_MASK = "[REDACTED]";

const SENTINEL = "\uE000";
const PLACEHOLDER = /\{\{\s*[A-Za-z][\w-]*\s*:[^{}]*\}\}/g;
const SENTINEL_ONLY = /^(?:\uE000\d+\uE000)+$/;

const SENSITIVE_KEY = /password|passwd|secret|token|api[_-]?key|authorization|private[_-]?key|credential/i;
const NOT_SENSITIVE_KEY = /(?:_|-)(?:type|url|endpoint|count|limit)$|^(?:max|total|input|output|prompt|completion)[_-]?tokens?$/i;

function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY.test(key) && !NOT_SENSITIVE_KEY.test(key);
}

const BEARER = /\b(Bearer|Basic)(\s+)([A-Za-z0-9._~+/=-]{8,})/gi;
const PARAM =
  /(^|[^A-Za-z0-9_-])((?:access_token|refresh_token|id_token|token|api_key|apikey|key|secret|password|client_secret|signature|sig))=([^\s&"'<>#;]+)/gi;
const JSON_FIELD = /"([A-Za-z0-9_\-. ]{1,64})"(\s*:\s*)"((?:[^"\\]|\\.)*)"/g;

const TOKEN_SHAPES: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  /\beyJ[A-Za-z0-9_-]{5,}\.eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bxox[abposr]-[A-Za-z0-9-]{10,}/g,
  /\bsk-[A-Za-z0-9_-]{16,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bATATT[A-Za-z0-9_=+/-]{20,}/g,
  /\bevc_[0-9a-fA-F]{8,}/g,
  /\baie_[0-9a-fA-F]{8,}/g,
  /\beco_[0-9a-fA-F]{8,}/g,
];
const TELEGRAM = /(^|\D)(\d{8,10}:[A-Za-z0-9_-]{35})(?![A-Za-z0-9_-])/g;

/** Masks common secret patterns while keeping {{secret:NAME}} placeholders untouched. */
export function redactSecrets(input: string, externalRedact?: (text: string) => string): string {
  if (!input) return input;
  let base = input;
  if (externalRedact) {
    try {
      base = externalRedact(base);
    } catch {
      // Falls back to built-in patterns when external redactor throws.
    }
  }
  const placeholders: string[] = [];
  let s = base.replace(/\uE000/g, "\uFFFD").replace(PLACEHOLDER, (m) => {
    placeholders.push(m);
    return `${SENTINEL}${placeholders.length - 1}${SENTINEL}`;
  });

  s = s.replace(BEARER, (m, scheme: string, space: string, token: string) => {
    if (/^basic$/i.test(scheme) && !/[0-9=]|(?=.*[a-z])(?=.*[A-Z])/.test(token)) return m;
    return `${scheme}${space}${REDACTED_MASK}`;
  });
  s = s.replace(PARAM, (m, pre: string, name: string, val: string) =>
    SENTINEL_ONLY.test(val) || val === REDACTED_MASK ? m : `${pre}${name}=${REDACTED_MASK}`,
  );
  s = s.replace(JSON_FIELD, (m, key: string, sep: string, val: string) =>
    isSensitiveKey(key) && !SENTINEL_ONLY.test(val) && val !== REDACTED_MASK ? `"${key}"${sep}"${REDACTED_MASK}"` : m,
  );
  for (const re of TOKEN_SHAPES) s = s.replace(re, REDACTED_MASK);
  s = s.replace(TELEGRAM, (_m, pre: string) => `${pre}${REDACTED_MASK}`);

  return s.replace(/\uE000(\d+)\uE000/g, (_m, i: string) => placeholders[Number(i)] ?? "");
}
