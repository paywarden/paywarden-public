# Live-chain validation

Use a separate test installation and independently generated credentials. Begin
on Nile with its USDT contract and funded test wallets. Keep production wallets
and configuration separate.

1. Check public readiness and authenticated administrative health.
2. Create an order and send a small test payment to its receiving address.
3. Verify the confirmed transaction, amount, recipient, contract and block height
   against a solidified chain receipt.
4. Verify the merchant webhook signature and deduplicate its idempotency key.
5. If sweeping is enabled, verify the cold-wallet transfer and retained balances.
6. Check restart recovery and webhook retry behavior; underpaid and overpaid
   financial outcomes must remain unchanged after successful callback delivery.

Before a mainnet deployment, select the mainnet network and USDT contract, use
dedicated mainnet wallet settings and credentials, and verify the intended
callback endpoint. Run a bounded small-value mainnet check and retain the order,
transaction and callback evidence privately. Nile validation does not establish
that a particular mainnet installation has been accepted.

The deployment smoke script checks service health and administrative endpoints;
it does not broadcast payments or replace live-chain validation:

```bash
SMOKE_BASE_URL=https://your-domain.example ADMIN_PASSWORD=your-admin-password pnpm smoke
```
