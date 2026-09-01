// Unit tests for the client-side copy of the server's attribute-value rule.
//
// The point of these is drift: `attributeValueMatchesRegex` exists to answer the same
// way the server's `regexExValidator` answers, so the cases below use the REAL regexes
// the database ships for the pre-defined attribute types (mmar-database/init.sql).
// A value this accepts and the server refuses comes back as a 403 that rolls the whole
// scene back — the failure this check was added to prevent.
import { describe, it, expect, vi, beforeEach } from "vitest";

const logCalls: Array<[string, string]> = [];
vi.mock("./logger", () => ({
  logger: { log: (value: string, status: string) => logCalls.push([value, status]) },
}));

import {
  NOT_ALLOWED_MESSAGE,
  attributeTypeName,
  attributeValueMatchesRegex,
  reportMetamodelViolation,
  unwrapRegexLiteral,
} from "./metamodel-constraints";

const FLOAT_REGEX = "^[-+]?[0-9]*\\.?[0-9]+([eE][-+]?[0-9]+)?$";
const INTEGER_REGEX = "^([0-9])*$";

/** A meta attribute of the given attribute type, shaped as the API sends it. */
function metaAttribute(regex_value: string | null, name = "Float") {
  return { attribute_type: { uuid: "at-1", name, regex_value } } as never;
}

beforeEach(() => {
  logCalls.length = 0;
});

describe("attributeValueMatchesRegex", () => {
  it("accepts a value that matches its attribute type's regex", () => {
    expect(attributeValueMatchesRegex("1.5", metaAttribute(FLOAT_REGEX))).toBe(true);
    expect(attributeValueMatchesRegex("-2", metaAttribute(FLOAT_REGEX))).toBe(true);
    expect(attributeValueMatchesRegex("1e-3", metaAttribute(FLOAT_REGEX))).toBe(true);
    expect(attributeValueMatchesRegex("42", metaAttribute(INTEGER_REGEX, "Integer"))).toBe(true);
  });

  it("refuses letters typed into a Float attribute — the reported case", () => {
    expect(attributeValueMatchesRegex("abc", metaAttribute(FLOAT_REGEX))).toBe(false);
    // Anchored: a value that only STARTS as a number is refused too.
    expect(attributeValueMatchesRegex("12abc", metaAttribute(FLOAT_REGEX))).toBe(false);
    expect(attributeValueMatchesRegex("1.5", metaAttribute(INTEGER_REGEX, "Integer"))).toBe(false);
  });

  it("accepts an unset value, because the server does", () => {
    // The server skips the test for a real null/undefined and for the sentinel
    // strings the clients store for an attribute that was never filled in.
    for (const unset of ["", "   ", "not defined", "undefined"]) {
      expect(attributeValueMatchesRegex(unset, metaAttribute(FLOAT_REGEX))).toBe(true);
    }
  });

  it("accepts without testing when there is nothing to test with", () => {
    // No regex on the attribute type, and no value on the instance: the server's two
    // accept-without-testing cases.
    expect(attributeValueMatchesRegex("anything", metaAttribute(null))).toBe(true);
    expect(attributeValueMatchesRegex(null, metaAttribute(FLOAT_REGEX))).toBe(true);
    expect(attributeValueMatchesRegex(undefined, metaAttribute(FLOAT_REGEX))).toBe(true);
    expect(attributeValueMatchesRegex("anything", undefined)).toBe(true);
  });

  it("unwraps a regex entered as a JS literal, as the server does", () => {
    // The reported case: a user-defined type whose regex_value kept its slashes.
    expect(attributeValueMatchesRegex("255.255.255.0", metaAttribute("/^(\\d{1,3}\\.){3}\\d{1,3}$/gim", "Mask"))).toBe(true);
    expect(attributeValueMatchesRegex("HTTP", metaAttribute("/^(tcp|udp|https?)$", "Protocol"))).toBe(true);
    expect(attributeValueMatchesRegex("carrier pigeon", metaAttribute("/^(tcp|udp|https?)$", "Protocol"))).toBe(false);
  });

  it("accepts when the pattern will not compile, leaving the verdict to the server", () => {
    expect(attributeValueMatchesRegex("anything", metaAttribute("([unclosed"))).toBe(true);
  });

  it("is not confused by the lastIndex of the shared /g regex on repeated calls", () => {
    const meta = metaAttribute(FLOAT_REGEX);
    expect(attributeValueMatchesRegex("1", meta)).toBe(true);
    expect(attributeValueMatchesRegex("2", meta)).toBe(true);
    expect(attributeValueMatchesRegex("3", meta)).toBe(true);
  });
});

describe("unwrapRegexLiteral", () => {
  it("strips a /pattern/flags literal and a stray leading slash, leaving a bare pattern alone", () => {
    expect(unwrapRegexLiteral("/^(tcp|udp)$/gim")).toBe("^(tcp|udp)$");
    expect(unwrapRegexLiteral("  /^(tcp|udp)$/  ")).toBe("^(tcp|udp)$");
    expect(unwrapRegexLiteral("/^(tcp|udp)$")).toBe("^(tcp|udp)$");
    expect(unwrapRegexLiteral("^[0-9]+$")).toBe("^[0-9]+$");
    // A pattern that legitimately contains slashes is untouched.
    expect(unwrapRegexLiteral("^https?:\\/\\/.+$")).toBe("^https?:\\/\\/.+$");
  });
});

describe("reportMetamodelViolation", () => {
  it("raises the snackbar and writes the detail to the log window", () => {
    reportMetamodelViolation('"abc" is not a valid Float value for Speed.');

    // "error" is what logStore turns into the snackbar; "close" is log-window only.
    expect(logCalls[0]).toEqual([NOT_ALLOWED_MESSAGE, "error"]);
    expect(logCalls[1][1]).toBe("close");
    expect(logCalls[1][0]).toContain('"abc" is not a valid Float value for Speed.');
  });

  it("logs the bare message when there is no detail", () => {
    reportMetamodelViolation();

    expect(logCalls).toEqual([
      [NOT_ALLOWED_MESSAGE, "error"],
      [NOT_ALLOWED_MESSAGE, "close"],
    ]);
  });
});

describe("attributeTypeName", () => {
  it("names the attribute type, falling back for an unresolved meta attribute", () => {
    expect(attributeTypeName(metaAttribute(FLOAT_REGEX))).toBe("Float");
    expect(attributeTypeName(undefined)).toBe("attribute");
  });
});
