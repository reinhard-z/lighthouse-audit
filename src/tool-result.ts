/**
 * The tool's result envelope and its serialized size (SPEC.md §4, §7).
 * The byte cap applies to the whole serialized `CallToolResult`, whose text
 * block repeats the structured result as an escaped JSON string.
 */
import type { AuditError, AuditReport, AuditResult } from "./schemas";

/** The `CallToolResult` shape this tool returns. */
export interface AuditToolResult {
  [key: string]: unknown;
  content: [{ type: "text"; text: string }];
  structuredContent: AuditResult;
  isError: boolean;
}

export function successResult(requestId: string, report: AuditReport): AuditResult {
  return { schemaVersion: "1.0", ok: true, requestId, report, error: null };
}

export function failureResult(requestId: string, error: AuditError): AuditResult {
  return { schemaVersion: "1.0", ok: false, requestId, report: null, error };
}

/**
 * Wraps a result as structured content plus an equivalent text block.
 * Failures set `isError` and still carry schema-valid structured content.
 */
export function toCallToolResult(result: AuditResult): AuditToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(result) }],
    structuredContent: result,
    isError: !result.ok,
  };
}

const encoder = new TextEncoder();

/** UTF-8 byte length of the serialized `CallToolResult` for this result. */
export function serializedToolResultBytes(result: AuditResult): number {
  return encoder.encode(JSON.stringify(toCallToolResult(result))).byteLength;
}
