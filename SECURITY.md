# Security Policy

## Reporting Vulnerabilities

If you discover a security vulnerability, please report it responsibly:

1. **Do NOT** open a public GitHub issue
2. Email **security@paywarden.io** with:
   - Description of the vulnerability
   - Steps to reproduce
   - Impact assessment
   - Suggested fix (if any)

We will acknowledge your report within 48 hours and aim to release a patch within 7 days for critical issues.

## Supported Versions

| Version | Supported |
|---------|-----------|
| 1.0.0-rc.2 | Yes |

## Security Architecture

PayWarden is designed with a **non-custodial, zero-key-on-server** architecture:

- **Vault encryption**: Seed phrases are encrypted with AES-256-GCM. The encryption key (`VAULT_KEY`) lives only in environment variables, never in the database or logs.
- **Address derivation**: Payment addresses are derived from the extended public key (xpub). Private keys are never needed for receiving payments.
- **Fund sweeping**: Private keys exist in memory only during sweep operations and are immediately wiped (`Buffer.fill(0)`) after use.
- **API authentication**: Merchant API keys are stored as HMAC-SHA256 hashes with timing-safe comparison.
- **Webhook signing**: All webhook payloads are signed with HMAC-SHA256 using per-merchant secrets.

## Best Practices for Self-Hosting

- Run behind a reverse proxy (Nginx/Caddy) with TLS
- Use a strong, random `VAULT_KEY` (64 hex characters = 256 bits)
- Keep `vault/` directory permissions restricted (`chmod 700`)
- Never commit `.env` or `vault/` to version control
- **Isolate `vault/` per instance**: if you run multiple PayWarden instances (dev + prod on one host, blue/green, drill + live), each instance MUST use its own `vault/` path **and** its own `VAULT_KEY`. Sharing a `vault/` across instances with different `VAULT_KEY` values will cause AES-GCM decryption to fail on boot.
- Rotate `API_KEY` and `WEBHOOK_SECRET` periodically
- Monitor the `/api/v1/health` endpoint
- Keep dependencies updated (`pnpm audit`)
