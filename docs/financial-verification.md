# Financial and recovery verification — 2026-10-04

This records a real local manual drill, not production release, wallet trading, paid AI activity or an automated test suite. All financial writes were limited to the newly created isolated database `polymarket_financial_drill_20261004_1791104760671`. The application/source database was read for backup and received no money mutation from this drill.

## Recovery drill

PostgreSQL 18 clients used `PG_BIN=C:/laragon/bin/postgresql/getfile/bin`; source PostgreSQL runs at local port 5433. Connection URLs and encryption key were loaded from `.env` without logging them.

Executed:

```powershell
$env:PG_BIN='C:/laragon/bin/postgresql/getfile/bin'
pnpm exec tsx --env-file=.env scripts/backup.ts .runtime/financial-snapshot-20261004.pmbk
pnpm exec tsx --env-file=.env .runtime/financial-drill.ts
```

The second command is an ephemeral manual scenario driver under ignored `.runtime`. It created the new database, supplied `RESTORE_DATABASE_URL` privately, then invoked `scripts/restore.ts .runtime/financial-snapshot-20261004.pmbk --confirm-isolated-target` through Node/tsx. Restore returned success after authenticated AES-256-GCM decryption, public-table count comparison, and balanced-journal validation. `.runtime/verification-snapshot.pmbk` was preserved. The new target was retained for inspection; no existing database was dropped.

Backup reads the manifest and `pg_dump` from the same exported PostgreSQL snapshot. The implementation was inspected and this new archive was successfully restored. Concurrent-write stress testing, corrupted-archive/wrong-key drills, remote storage recovery, Redis recovery and production recovery are not established by this run.

## Manual financial outcomes

| Scenario | Observed result |
| --- | --- |
| First prediction BUY with 6 collateral reserved | Approved |
| Second BUY with existing reservation and allocation cap 10 | Rejected: strategy allocation exceeded |
| BUY maxCost 1 versus limit fill cost 6 | Rejected: reservation does not cover limit fill and fees |
| Same confirmed fill submitted twice | Cash remained 995, reservation remained zero; one settlement applied |
| Same confirmed fill identity with changed shares | Rejected |
| Pending fill leaves equity unknown | Entry rejected: incomplete valuation or settlement |
| Strategy disabled with pending fill, held-position SELL exit | Approved; reservation then released by cancellation |
| Replacement-style BUY against disabled strategy | Rejected by central disabled-strategy gate |
| Intent with different condition identity | Rejected before reservations |
| Intent with NaN share quantity | Rejected before reservations |
| Unbalanced journal | Rejected before journal insertion |
| Sum of every journal after scenarios | Zero invalid balances |

The scenario market was synthetic, with fresh books and zero fee; fills were local ledger calls, without any exchange gateway. The cash amount comes from the restored paper seed capital. The manual fixture set allocation, market and control settings only in the isolated database. Machine-readable evidence is `.runtime/financial-verification.json`.

The three follow-up guards were exercised with `pnpm exec tsx --env-file=.env .runtime/financial-followup.ts`, again against the same isolated target and with no exchange calls.

## Implemented guards and further verification

Central risk authorization now checks valid mode/strategy/side/order type, nonempty operation/profile identifiers, common group mode/strategy/profile, exact market/event/condition identity, distinct operation IDs, complementary arbitrage group tokens, finite positive quantities/prices/BUY budgets, exit attribution and zero exit budget, valid nonfuture timestamps and finite horizon. BUY reservations cover shares at the limit plus the verified fee. Existing strategy reservations, disabled strategy/universe checks and unknown-equity entry block remain enforced. Exits retain their exemption from entry strategy and valuation gates.

Fill settlement checks finite values, immutable confirmed fill identity, fill ownership, authorized price limits and remaining BUY collateral. Duplicate identical confirmed fills return without another journal/position/cash mutation. Unbalanced journals retain their existing rejection.

`pnpm typecheck` was executed after these edits. At the time of this drill it failed on two unrelated API service Mode typing errors in `apps/api/src/services.ts` lines 16 and 20; no error was reported in risk or ledger. Full-project final checks are tracked by the implementation owner. Real exchange partial-fill fee precision, physical UAT, live execution and external recovery remain unverified.
