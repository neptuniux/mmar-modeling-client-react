import type { Attribute } from "@gds";
import { logger } from "./logger";

/**
 * The metamodel constraints the client checks BEFORE the server does.
 *
 * Everything the user builds is validated again by the server's rule engine, which
 * answers a violation with a 403. For a scene edit that 403 is expensive: the whole
 * scene is rolled back to the last saved snapshot and re-imported, which pulls every
 * object out of the THREE scene and leaves the selection, the transform controls and
 * the relation lines pointing at meshes that are gone. Catching the violation here
 * keeps the refused value out of the model in the first place, and reports it the way
 * every other metamodel rejection is reported — the error snackbar.
 */

/** Message shown when the metamodel forbids what the user is doing. */
export const NOT_ALLOWED_MESSAGE = "This action is not allowed due to some restrictions in the metamodel!";

/**
 * Report a refused action: an "error" entry, which the log store raises as the
 * snackbar, and a "close" entry for the log window — which carries `detail` when there
 * is one, so the panel says WHICH value was refused while the snackbar stays short.
 */
export function reportMetamodelViolation(detail?: string): void {
  logger.log(NOT_ALLOWED_MESSAGE, "error");
  logger.log(detail ? `${NOT_ALLOWED_MESSAGE} ${detail}` : NOT_ALLOWED_MESSAGE, "close");
}

/**
 * Whether `value` satisfies the regular expression of the attribute type the meta
 * attribute belongs to — letters typed into a Float attribute do not.
 *
 * This mirrors the server's `regexExValidator` rule deliberately closely: the same
 * "gmi" flags, the same `String(value).match(...)` test, the same unwrapping of a
 * regex entered as a JS literal, and the same cases that are accepted without being
 * tested at all — an attribute type that states no regex, and an instance carrying
 * no value (a real null/undefined, or one of the sentinel strings the clients store
 * for an unset attribute). Anything accepted here and refused there comes back as
 * the 403 described above, so the two must not drift apart.
 */
export function attributeValueMatchesRegex(
  value: string | null | undefined,
  metaAttribute: Attribute | null | undefined,
): boolean {
  const regexValue = metaAttribute?.attribute_type?.regex_value;
  if (!regexValue) return true;
  if (value === null || value === undefined) return true;
  const unset = String(value).trim();
  if (unset === "" || unset === "not defined" || unset === "undefined") return true;

  let regex: RegExp;
  try {
    // `regex_value` is declared a RegExp in gds but arrives from the API as a string.
    // The RegExp constructor accepts either, and applies the server's flags to both.
    regex = new RegExp(unwrapRegexLiteral(regexValue as unknown as string), "gmi");
  } catch {
    // A pattern the browser cannot compile is not a constraint this client can
    // enforce — let the edit through and leave the verdict to the server.
    return true;
  }

  return String(value).match(regex) !== null;
}

/**
 * Strip a regex entered as a JavaScript literal back to its bare pattern. The
 * metamodel stores a pattern (`^(TCP|UDP)$`), but the metamodeling client's RegEx
 * field is free text, so values arrive as `/^(TCP|UDP)$/gim` — or a half-mangled
 * `/^(TCP|UDP)$` that kept only its leading slash — and fed straight to `new RegExp`
 * that slash is a literal character no value can contain. Kept byte-for-byte in
 * step with `unwrapRegexLiteral` in the server's Instance_attributes.rules.ts.
 */
export function unwrapRegexLiteral(raw: string): string {
  const pattern = raw.trim();
  const literal = pattern.match(/^\/(.+)\/[dgimsuy]*$/);
  if (literal) return literal[1];
  if (pattern.startsWith("/^")) return pattern.slice(1);
  return pattern;
}

/** The attribute type's name ("Float"), for the log-window detail line. */
export function attributeTypeName(metaAttribute: Attribute | null | undefined): string {
  return metaAttribute?.attribute_type?.name ?? "attribute";
}
