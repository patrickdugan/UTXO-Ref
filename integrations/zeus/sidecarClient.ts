// One request helper for the liquidity sidecar. Every POST route needs the sidecar's bearer token, so a client
// built with a token sends it on every POST and none of the GETs.
export type SidecarClientConfig = {
  baseUrl: string;
  token?: string;
};

export async function callSidecar<T>(
  client: SidecarClientConfig,
  label: string,
  path: string,
  init: { method?: 'GET' | 'POST'; body?: unknown } = {}
): Promise<T> {
  const method = init.method ?? 'GET';
  const headers: Record<string, string> = {};
  if (method === 'POST') {
    headers['content-type'] = 'application/json';
    if (client.token) headers.authorization = `Bearer ${client.token}`;
  }
  const response = await fetch(`${client.baseUrl}${path}`, {
    method,
    headers,
    body: method === 'POST' ? JSON.stringify(init.body ?? {}) : undefined
  });
  if (!response.ok) throw new Error(`${label} failed: ${response.status}`);
  return response.json() as Promise<T>;
}

export function normalizeSidecarBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/$/, '');
}
