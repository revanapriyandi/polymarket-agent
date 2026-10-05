import { createLiveGateway } from '../packages/trading/src/client.js';
import { pool, transaction } from '../packages/db/src/index.js';
import { loadManagedWallet, walletRpc } from '../packages/core/src/wallet.js';
import { audit } from '../packages/core/src/state.js';

// Uses only the account already persisted by setup; never deploys, grants allowance, or replaces the signer.
try {
  if(!process.argv.includes('--confirm-existing-account'))throw new Error('Use --confirm-existing-account after checking the persisted account and relayer transaction in Polymarket.');
  const row=await loadManagedWallet();
  if(!row||row.status!=='ambiguous'||!row.wallet_address||!row.protected.credentials)throw new Error('No persisted authenticated account to reconcile. Preserve the signer and encrypted backup; inspect the original setup externally.');
  const gateway=await createLiveGateway({privateKey:row.protected.privateKey,walletAddress:row.wallet_address,rpcUrl:walletRpc(),builder:row.protected.builder,credentials:row.protected.credentials});
  const readiness=await gateway.walletReadiness(row.wallet_address);
  if(!readiness.ready||!readiness.gaslessConfigured)throw new Error('Account, eligibility or allowance is not ready. No changes applied.');
  await gateway.getBalances();
  await transaction(async client=>{
    await client.query('SELECT pg_advisory_xact_lock(73011)');
    const changed=await client.query("UPDATE managed_wallet SET status='connected',message='Akun dan allowance terkonfirmasi melalui rekonsiliasi',updated_at=now() WHERE id=1 AND status='ambiguous' AND version=$1 RETURNING id",[row.version]);
    if(!changed.rowCount)throw new Error('Wallet state changed; no changes applied.');
    await client.query("UPDATE settings SET payload=jsonb_set(payload,'{walletAddress}',to_jsonb($1::text)),version=version+1,updated_at=now() WHERE id=1",[row.wallet_address]);
  });
  await audit('owner','Wallet dipulihkan melalui rekonsiliasi','Account dan allowance terverifikasi; tidak ada deploy atau transaksi allowance baru');
  console.log('Existing wallet reconciled. The worker reloads the connection; live remains separately gated.');
} catch(error) {
  // SDK errors can contain authentication context, so only our literal operator messages are printed.
  const message=error instanceof Error?error.message:'';
  console.error(/^(Use --|No persisted|Account, eligibility|Wallet state changed)/.test(message)?message:'Wallet reconciliation failed; no new on-chain operation was sent.');
  process.exitCode=1;
} finally {await pool.end();}
