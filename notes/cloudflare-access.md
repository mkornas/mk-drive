# Cloudflare Access — do we still need it?

Assessed 2026-09-11, after SSO phase 1 (passkeys through an OIDC provider, `@mk-kit/auth`).
Verdict: no. The app has its own door (single sign-on on the internet, the
password only from trusted networks with `DRIVE_PASSWORD_LOGIN=lan`), so the
second login in front was only friction and it broke share links for people
without an account. `DRIVE_ACCESS_*` stays as an optional feature for anyone
who wants Access in front.
