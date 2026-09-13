/** The native Responses client reports this provider stop as a failed turn. */
export function isOutputLimitError(error: { message?: string } | null | undefined): boolean {
  return /Incomplete response returned, reason: max_output_tokens$/.test(error?.message ?? "");
}
