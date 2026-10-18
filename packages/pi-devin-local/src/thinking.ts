/**
 * Devin streams thinking as a summary (`delta_thinking`) plus an opaque
 * `delta_signature` and a `delta_signature_type`. The signature is what lets the
 * server verify and continue a reasoning trace, so it has to travel back with the
 * thinking text on the next request — the official Devin CLI does exactly that.
 *
 * Pi stores a single opaque string per thinking block (`thinkingSignature`), so
 * the server's signature type rides along with it. Sealed signatures describe
 * themselves (`sealed.v1.…`), and only `sealed` / `non-sealed` exist, so the
 * common case stores the raw value and the type is only prefixed when it would
 * not be derivable again.
 */

const TYPE_SEPARATOR = "\u001f";

export interface ChatThinking {
  /** Thinking text as sent by the server (already summarized upstream). */
  text: string;
  /** Opaque signature for server-side verification/continuation. */
  signature: string;
  /** `signature_type` reported by the server. */
  signatureType?: string;
  /** Server flagged the trace as redacted by safety filters. */
  redacted?: boolean;
}

export function signatureTypeOf(signature: string): string {
  return signature.startsWith("sealed.") ? "sealed" : "non-sealed";
}

/** Store `signature` in pi's `thinkingSignature` without losing the type. */
export function packThinkingSignature(signature: string, signatureType?: string): string {
  if (!signatureType || signatureType === signatureTypeOf(signature)) return signature;
  return `${signatureType}${TYPE_SEPARATOR}${signature}`;
}

export function unpackThinkingSignature(value: string | undefined): {
  signature?: string;
  signatureType?: string;
} {
  if (!value) return {};
  const index = value.indexOf(TYPE_SEPARATOR);
  if (index === -1) return { signature: value, signatureType: signatureTypeOf(value) };
  return { signatureType: value.slice(0, index), signature: value.slice(index + 1) };
}
