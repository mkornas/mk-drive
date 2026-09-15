# Password login only from trusted networks

- 2026-09-11 09:07 — DRIVE_PASSWORD_LOGIN=on|lan|off shipped (commit 6c53ce9): lan = private addresses only, judged on the real client address (Cloudflare header, trusted-proxy XFF, else peer); /api/login refuses with 403 elsewhere, /api/meta carries passwordLogin and the sign-in page follows. Tests in server/test/password-login.test.ts. Deployed with lan: LAN meta says true, the public name says false. — main @ 6c53ce9 DRIVE_PASSWORD_LOGIN: the password form on, LAN-only or off
- 2026-09-13 — A drive used by the iOS app needs `on`: the app signs in with email + password over the internet to mint its app password, so `/api/login` has to answer there. Public meta then says `passwordLogin: true`; SSO button unchanged. No app change was needed.
