# Contributing to PayWarden

Clone https://github.com/paywarden/paywarden-public and create a feature branch.

Install the root, dashboard and checkout dependencies with pnpm. Configure a local
instance using `.env.example`; never commit your credentials or wallet files.

Before opening a pull request, run type checking, lint and tests:

```bash
pnpm typecheck
pnpm lint
pnpm test:unit
```

Full integration validation requires disposable PostgreSQL 16 and Redis 7
services. The tests migrate and truncate their database and clear their Redis
database. See README.md for `INTEGRATION_DATABASE_URL` and
`INTEGRATION_REDIS_URL`. CI runs the complete suite and builds all three projects.

Use TypeScript strict mode, ESM imports with `.js` extensions, string amounts and
Decimal.js for monetary arithmetic. Preserve transaction and callback idempotency.
Include a regression test when fixing payment or recovery behavior.

Report vulnerabilities through the process in [SECURITY.md](SECURITY.md).
Contributions retain the project's existing [BSL 1.1 license](LICENSE).
