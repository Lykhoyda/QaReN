/**
 * Parse the MCP tool result envelope from a ToolResult.
 * All tool handlers return { content: [{ type: 'text', text: JSON }], isError? }.
 *
 * @param {import('../../dist/utils.js').ToolResult} result
 * @returns {{ ok: boolean, data?: unknown, error?: string, truncated?: boolean, meta?: Record<string, unknown> }}
 */
export function parseEnvelope(result) {
  const text = result.content?.[0]?.text;
  if (!text) throw new Error('ToolResult has no content');
  return JSON.parse(text);
}

/**
 * Assert the envelope is a success (ok: true) and return the data.
 * @param {import('../../dist/utils.js').ToolResult} result
 */
export function expectOk(result) {
  const env = parseEnvelope(result);
  if (!env.ok) throw new Error(`Expected ok:true but got error: ${env.error}`);
  if (result.isError) throw new Error('ToolResult has isError flag set on an ok response');
  return env.data;
}

/**
 * Assert the envelope is a failure (ok: false) and return the error string.
 * @param {import('../../dist/utils.js').ToolResult} result
 */
export function expectFail(result) {
  const env = parseEnvelope(result);
  if (env.ok) throw new Error(`Expected ok:false but got ok:true`);
  if (!result.isError) throw new Error('ToolResult missing isError flag on a fail response');
  return env.error;
}

/**
 * Assert the envelope is a warning (ok: true with meta.warning).
 * @param {import('../../dist/utils.js').ToolResult} result
 */
export function expectWarn(result) {
  const env = parseEnvelope(result);
  if (!env.ok) throw new Error(`Expected ok:true (warn) but got error: ${env.error}`);
  if (!env.meta?.warning) throw new Error('Expected meta.warning to be set');
  return { data: env.data, warning: env.meta.warning };
}
