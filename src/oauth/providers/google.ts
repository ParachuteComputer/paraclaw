/**
 * Google OAuth provider — covers Gmail, Calendar, Drive, Docs, Sheets,
 * etc. all under one client. Operator registers a single Google Cloud
 * Console OAuth 2.0 client and grants whatever scopes the agent needs;
 * paraclaw stores the resulting tokens once.
 *
 * Userinfo response shape (from `https://openidconnect.googleapis.com/v1/userinfo`):
 *   { "sub": "123…", "email": "alice@example.com", "name": "Alice", … }
 *
 * `sub` is Google's stable account ID and is what we key on. `email`
 * goes into both `account_email` and the auto-generated `label`.
 */
import type { ProviderSpec, UserinfoExtract } from './index.js';

interface GoogleUserinfo {
  sub?: string;
  email?: string;
  name?: string;
  picture?: string;
}

export const GoogleProvider: ProviderSpec = {
  slug: 'google',
  displayName: 'Google',
  authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
  tokenUrl: 'https://oauth2.googleapis.com/token',
  userinfoUrl: 'https://openidconnect.googleapis.com/v1/userinfo',
  revokeUrl: 'https://oauth2.googleapis.com/revoke',
  defaultScopes: 'openid email profile',
  // access_type=offline + prompt=consent ensures Google issues a
  // refresh_token even on subsequent authorizations of the same account.
  extraAuthParams: {
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
  },
  extractAccount(userinfo: unknown): UserinfoExtract {
    const u = (userinfo ?? {}) as GoogleUserinfo;
    if (!u.sub) {
      throw new Error('google userinfo response missing `sub` (account id)');
    }
    const email = u.email ?? null;
    const label = email ?? u.name ?? `google:${u.sub}`;
    return { accountId: u.sub, accountEmail: email, label };
  },
};
