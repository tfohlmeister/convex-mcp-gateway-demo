// OIDC providers Convex validates inbound Bearer tokens against.
// The demo ships with an empty providers list so it runs out of the
// box without an IdP: `ctx.auth.getUserIdentity()` simply returns
// null for every request, and the auth-gated tools return 401.
//
// To enable real auth, add an entry below pointing at your IdP. Any
// OIDC issuer works (Auth0, Authentik, Keycloak, Pocket-ID, custom).
// Example:
//   providers: [
//     {
//       domain: "https://your-tenant.eu.auth0.com",
//       applicationID: "<your client_id>",
//     },
//   ]
export default {
  providers: [],
};
