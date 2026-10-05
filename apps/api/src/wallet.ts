import type { FastifyInstance } from 'fastify';
import { BuilderCredentialsSchema, configureManagedWallet, walletView } from '../../../packages/core/src/wallet.js';
import { transaction, pool } from '../../../packages/db/src/index.js';
import { operationsQueue } from '../../../packages/core/src/queue.js';
import { audit } from '../../../packages/core/src/state.js';
import { stepUp, HttpError } from './security.js';

export async function registerWallet(app:FastifyInstance) {
  app.get('/api/wallet/setup',walletView);
  app.put('/api/wallet/setup',async req=>{
    await stepUp(req);const builder=BuilderCredentialsSchema.parse(req.body);
    try{await configureManagedWallet(builder);}catch(error){if(error instanceof Error&&error.message==='WALLET_ENV_MANAGED')throw new HttpError(409,'Wallet dikelola konfigurasi server; gunakan pemeriksaan wallet yang sudah ada');if(error instanceof Error&&error.message==='WALLET_LIVE_ACTIVE')throw new HttpError(409,'Selesaikan exposure live dan pilih mode paper sebelum mengubah koneksi wallet');if(error instanceof Error&&error.message==='WALLET_SETUP_PENDING')throw new HttpError(409,'Setup sebelumnya belum terkonfirmasi. Rekonsiliasi diperlukan sebelum mengubah koneksi.');throw error;}
    await audit('owner','Koneksi wallet tersimpan','Signer dan kredensial disimpan terenkripsi; private key tidak dikembalikan');return {ok:true};
  });
  app.post('/api/wallet/connect',async req=>{
    await stepUp(req);
    const version=await transaction(async client=>{
      await client.query('SELECT pg_advisory_xact_lock(73060)');
      const row=(await client.query('SELECT status,version FROM managed_wallet WHERE id=1 FOR UPDATE')).rows[0];
      if(!row)throw new HttpError(409,'Simpan koneksi Builder Polymarket terlebih dahulu');
      if(['connecting','ambiguous'].includes(row.status))throw new HttpError(409,'Hasil setup belum pasti; periksa akun di Polymarket dan pulihkan dari server sebelum mencoba lagi');
      if(row.status==='connected')return null;
      await client.query("UPDATE managed_wallet SET status='queued',message='Menunggu worker',updated_at=now() WHERE id=1");return row.version;
    });
    if(version===null){await operationsQueue.add('wallet-check',{}, {priority:1});return {queued:true};}
    try {await operationsQueue.add('wallet-connect',{version},{jobId:`wallet-connect-${version}-${Date.now()}`,priority:1,attempts:1});}
    catch(error){await pool.query("UPDATE managed_wallet SET status='configured',message='Antrean belum tersedia',updated_at=now() WHERE id=1 AND status='queued' AND version=$1",[version]);throw error;}
    await audit('owner','Setup wallet diminta','Pembuatan akun, autentikasi dan allowance melalui SDK resmi');return {queued:true};
  });
}
