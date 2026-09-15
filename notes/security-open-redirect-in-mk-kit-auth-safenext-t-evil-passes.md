# *Security: open redirect in @mk-kit/auth safeNext** /\t/evil passes: reject control characters, parse against the origin (fix in mk-kit, then bump)

- 2026-09-15 16:08 — drive side: safeReturnPath() guards next in server/src/sso.ts (672b312). mk-kit fix ready as a patch for main; publishing @mk-kit/auth 0.2.1 waits for approval
