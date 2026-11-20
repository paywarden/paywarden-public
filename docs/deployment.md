# Deployment from source

This repository publishes source releases. Build both Docker targets from the
same checked-out release before using the production Compose configuration:

```bash
git checkout v1.0.0-rc.2
docker build --target runtime --build-arg GIT_REVISION="$(git rev-parse HEAD)" -t paywarden:v1.0.0-rc.2 .
docker build --target migrate --build-arg GIT_REVISION="$(git rev-parse HEAD)" -t paywarden-migrate:v1.0.0-rc.2 .
cp .env.production.example .env.production
```

Fill in `.env.production` with independently generated production credentials,
the intended network and contract, and your wallet settings. Keep `APP_IMAGE`
and `MIGRATE_IMAGE` set to the local image names above and use the same version
for both targets. Update the hostname in `Caddyfile` to your own domain and point
its DNS records at the server. The example domain is not a deployment prerequisite.

Create `vault/` with permissions that allow container UID 1000 to write to it.
Apply migrations before starting the service:

```bash
docker compose -f docker-compose.prod.yml --env-file .env.production --profile tools run --rm migrate
docker compose -f docker-compose.prod.yml --env-file .env.production up -d
```

For an HD installation, initialize the wallet through the authenticated wallet
API and store its mnemonic offline. Check readiness after initialization and run
the smoke script against the deployed URL. An enabled sweep also requires a
funded hot wallet and a verified cold-wallet destination.

Back up PostgreSQL together with the encrypted vault and the corresponding
configuration key. Keep backups encrypted and separate from the public source
checkout. `scripts/backup-pg.sh` covers PostgreSQL only. Test a restore into a
separate environment before relying on the backup.

For upgrades, stop all old workers, retain backups and the previous image pair,
apply the included migrations, and start the new version. Review quarantined
legacy work before manually retrying it. A database rollback requires restoring
the matching database, vault and configuration, rather than only changing the
application image.

Follow [live validation](live-validation.md) before accepting production traffic.
