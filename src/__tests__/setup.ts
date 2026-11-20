/**
 * Vitest global setup. Pre-fills the env vars that src/config/env.ts requires
 * with dummy values so unit tests can import modules that transitively touch
 * config (constants, services, etc.) without process.exit(1) on load.
 *
 * These are intentionally fake — any test that needs real values must mock
 * the relevant module. Real .env is never read here.
 */
process.env.DATABASE_URL ??= 'postgresql://test:test@localhost:5432/test';
process.env.REDIS_URL ??= 'redis://localhost:6379';
process.env.API_KEY ??= 'pw_test_dummy_key_for_unit_tests_only';
process.env.WEBHOOK_SECRET ??= 'whsec_test_dummy_secret_for_unit_tests';
process.env.VAULT_KEY ??= '0'.repeat(64);
process.env.HMAC_SECRET ??= '0'.repeat(64);
process.env.ADMIN_PASSWORD ??= 'test-admin-password';
process.env.JWT_SECRET ??= '0'.repeat(64);
process.env.TRONGRID_API_KEY ??= 'test-trongrid-key';
process.env.TRON_NETWORK ??= 'nile';
process.env.USDT_CONTRACT ??= 'TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBf';
