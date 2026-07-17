// MCP tool result helpers. Tools return pretty-printed JSON as text content.

export function jsonResult(data) {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

export function errorResult(msg) {
  return { content: [{ type: "text", text: JSON.stringify({ error: msg }, null, 2) }], isError: true };
}
