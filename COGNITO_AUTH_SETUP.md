# Cognito authentication

The current CRM source is configured for AWS Cognito by default.

Backend:

```env
AUTH_PROVIDER=cognito
COGNITO_REGION=ap-south-1
COGNITO_USER_POOL_ID=...
COGNITO_CLIENT_ID=...
```

Frontend:

```env
VITE_AUTH_PROVIDER=cognito
VITE_COGNITO_REGION=ap-south-1
VITE_COGNITO_USER_POOL_ID=...
VITE_COGNITO_CLIENT_ID=...
VITE_COGNITO_DOMAIN=...
```

CRM organization membership and roles remain in MySQL. Cognito authenticates the user; the CRM database remains the source of truth for tenant membership and authorization.

The backend accepts verified Cognito ID and access tokens. Hosted UI access
tokens with only `openid email profile` scopes cannot call Cognito `GetUser`.
For these tokens, the backend resolves the signed username with `AdminGetUser`
and checks that the returned `sub` matches the verified token. The backend AWS
credentials must have `cognito-idp:AdminGetUser` permission on this user pool.
Verified email is required for email-only legacy memberships and the
`PLATFORM_ADMIN_EMAILS` allowlist. Organization admins and managers use the
workspace dashboard; `/admin` is reserved for platform administrators.
