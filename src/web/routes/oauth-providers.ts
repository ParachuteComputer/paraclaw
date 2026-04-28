/**
 * /api/oauth/providers — read-only provider registry.
 *
 * The UI's "add integration" picker is data-driven off this list rather
 * than hard-coding provider slugs in the SPA bundle. New providers
 * registered in `src/oauth/providers/index.ts` automatically surface
 * here. No secrets, no per-account state — just the registry shape.
 */
import http from 'node:http';

import { listProviders } from '../../oauth/providers/index.js';

interface ProviderView {
  slug: string;
  displayName: string;
  defaultScopes: string;
}

const json = (res: http.ServerResponse, status: number, body: unknown): void => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

export interface OauthProvidersRouteContext {
  pathname: string;
  method: string;
  res: http.ServerResponse;
}

export function handleOauthProvidersRoute(ctx: OauthProvidersRouteContext): boolean {
  const { pathname, method, res } = ctx;
  if (pathname === '/api/oauth/providers' && method === 'GET') {
    const providers: ProviderView[] = listProviders().map((p) => ({
      slug: p.slug,
      displayName: p.displayName,
      defaultScopes: p.defaultScopes,
    }));
    json(res, 200, { providers });
    return true;
  }
  return false;
}
