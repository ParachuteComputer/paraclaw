/**
 * Provider registry. New providers (Slack, GitHub, Notion, …) plug in
 * by exporting a `ProviderSpec` and adding it to `PROVIDERS` below.
 */
import { GoogleProvider } from './google.js';

export interface UserinfoExtract {
  accountId: string;
  accountEmail: string | null;
  label: string;
}

export interface ProviderSpec {
  /** Slug used in URLs: `/api/apps/:provider/...` */
  slug: string;
  /** Human-readable name for the UI. */
  displayName: string;
  /** OAuth 2.0 authorization endpoint. */
  authUrl: string;
  /** OAuth 2.0 token endpoint. */
  tokenUrl: string;
  /** Userinfo endpoint — called post-token-exchange to populate label/email. */
  userinfoUrl: string;
  /** Provider-specific token revocation endpoint, or null if not supported. */
  revokeUrl: string | null;
  /** Default scope string (space-separated) when the operator doesn't override. */
  defaultScopes: string;
  /** Optional extra params on the authorize URL (e.g. Google's access_type=offline). */
  extraAuthParams?: Record<string, string>;
  /** Parse the userinfo JSON into account_id + email + label. */
  extractAccount(userinfo: unknown): UserinfoExtract;
}

const PROVIDERS: Record<string, ProviderSpec> = {
  [GoogleProvider.slug]: GoogleProvider,
};

export function getProvider(slug: string): ProviderSpec | undefined {
  return PROVIDERS[slug];
}

export function listProviderSlugs(): string[] {
  return Object.keys(PROVIDERS).sort();
}

export function listProviders(): ProviderSpec[] {
  return Object.values(PROVIDERS).sort((a, b) => a.slug.localeCompare(b.slug));
}
