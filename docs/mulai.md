# Menjalankan dan mengonfigurasi Polymarket Agent

Aplikasi dimulai dengan paper trading. Modal awal 1.000 pUSD adalah saldo virtual. Hasil implementasi, hasil simulasi, izin live dan keuntungan uang nyata merupakan status yang berbeda.

## Menjalankan di Windows

Gunakan terminal pada folder proyek setelah Node 24, pnpm, PostgreSQL dan Redis tersedia sesuai [runbook deployment](deployment.md).

```powershell
pnpm install --frozen-lockfile
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/start-local.ps1
```

Perintah kedua menjalankan database dan Redis lokal, menerapkan migrasi, membuat build, lalu menjalankan API, worker dan dashboard. Pemeriksaan kesehatan harus berhasil sebelum pesan siap muncul. Buka [dashboard lokal](http://127.0.0.1:5173). Jika akun belum dibuat, jalankan `pnpm owner:create` dan masukkan password pemilik. Akun yang sudah ada tidak ditimpa.

Jalankan kembali perintah yang sama untuk memeriksa atau memulihkan proses lokal yang berhenti. Proses yang masih berjalan digunakan kembali dengan build yang sedang dimuat. Untuk menerapkan perubahan source, hentikan proses proyek secara eksplisit terlebih dahulu lalu jalankan kembali; helper tidak menghentikan proses lain atau merebut port. Log berada di `.runtime/api.out.log`, `.runtime/worker.out.log`, dan file `.err.log` yang bersesuaian. Pemeriksaan worker terpisah:

```powershell
pnpm exec tsx --env-file=.env scripts/worker-health.ts
```

Menutup browser tidak menghentikan worker. Menutup komputer atau proses Node menghentikan runtime lokal; operasi sepanjang waktu memerlukan VPS. Helper lokal menolak konfigurasi production/live, tidak mengaktifkan live, dan tidak mengubah kontrol pause/emergency yang telah disimpan.

## Mengisi Settings

1. **Risiko.** Atur modal virtual, exposure per event, exposure total, batas rugi harian, drawdown, slippage dan alokasi strategi. Nilai rasio `0,01` berarti 1%; `0,10` berarti 10%; 100 bps berarti 1%. Di kolom numerik, gunakan pemisah desimal yang diterima browser. Perubahan modal paper dicatat sebagai deposit/penarikan virtual, sehingga tidak dianggap laba. Budget riset dan biaya infrastruktur memakai estimasi USD; tentukan konversinya ke pUSD untuk pelaporan biaya.
2. **Provider AI.** Pilih koneksi resmi atau custom, isi model, API key, harga input/output token dan budget. Endpoint resmi boleh kosong dan akan memakai server penyedia. Custom Chat/Anthropic menggunakan base URL; Custom Responses membutuhkan URL endpoint lengkap yang biasanya berakhir `/responses`. Tekan **Probe** dan periksa text, tools, structured output, serta usage. Probe dapat memakai token berbayar sesuai budget.
3. **Model assignment.** Tetapkan provider yang lulus probe untuk `research`, `evidence` dan `forecast`. `summary` opsional. Fallback harus Anda aktifkan dan pilih; provider alternatif tidak dipakai secara diam-diam. Probe/assignment yang berhasil belum membuktikan model menguntungkan.
4. **Layanan.** Aktifkan feed RSS/Atom publik yang relevan. BBC World dan Federal Reserve sudah tersedia pada konfigurasi awal. Agar agent dapat mencari dan mengambil sumber secara dinamis, isi key Tavily, aktifkan layanan, isi budget riset harian/bulanan pada Risiko, lalu jalankan probe. Pencarian dibatasi biaya dan waktu; cuplikan berita tetap harus diperiksa terhadap aturan market.
5. **Wallet.** Alamat publik boleh diisi di Settings. Signer, private key, kredensial CLOB, RPC dan relayer dikonfigurasi di server sesuai [panduan wallet](polymarket.md), dengan wallet trading khusus. Pemeriksaan readiness memverifikasi akses, saldo dan allowance; alamat saja belum cukup.

Nilai rahasia tidak ditampilkan kembali oleh API. Simpan dan probe konfigurasi melalui Settings; jangan menaruh key di source, log atau percakapan. Pengubahan konfigurasi sensitif memakai password pemilik.

## Membaca operasi agent

- **Saldo dan equity:** paper/live dipisahkan. Valuasi yang belum tersedia ditampilkan sebagai belum diketahui, bukan laba nol yang seolah pasti.
- **Agent runtime:** status berasal dari worker. `waiting` berarti menunggu data, model, atau peluang yang memenuhi aturan; agent tidak harus terus membuka transaksi.
- **Readiness:** tiap komponen menjelaskan mengapa belum dikonfigurasi, terganggu, atau diblokir. Heartbeat segar dan antrean sehat diperlukan; indikator API saja tidak membuktikan worker berfungsi.
- **Aktivitas, tools, keputusan:** buka detail untuk menelusuri sumber, alasan, versi profil dan hasil. Gunakan pencarian/filter, pagination dan ekspor yang tersedia.
- **Grafik:** pilih rentang, geser, zoom dan gunakan crosshair. Penanda BUY/SELL adalah order tersimpan; konfirmasi fill ada pada catatan eksekusi.
- **Replay:** replay depth memakai snapshot order book yang benar-benar telah dikumpulkan. Hasil paired dan satu sisi dibedakan. Replay kandidat tidak mengubah saldo, policy atau izin live.

Model dapat meminta pencarian riset tambahan melalui tool yang divalidasi. Order, pembatasan risiko, signer dan settlement tetap dikendalikan service server. Agent tidak dapat menaikkan batas kerugian sendiri, menarik uang, membaca key, atau menjalankan shell bebas.

## Pemeriksaan manual singkat

1. Login, pastikan mode **paper**, lihat modal virtual dan label P&L.
2. Pastikan worker dan antrean siap; tunggu scan pasar dan feed berita masuk. Buka satu agent dan lihat tool terakhir.
3. Di Settings, simpan risiko yang valid. Coba nilai exposure per event lebih besar daripada exposure total dan pastikan ditolak.
4. Konfigurasikan/probe provider, lalu tetapkan peran. Budget nol harus menghasilkan alasan penolakan dan tidak memanggil model.
5. Jalankan replay setelah snapshot tersedia; periksa alasan tidak bertransaksi atau risiko satu sisi. Saldo paper tidak berubah karena replay.
6. Gunakan Jeda/Lanjutkan dengan verifikasi password. Emergency stop menghentikan entry dan meminta pembatalan order; status pembatalan live menunggu bukti exchange.

## Persiapan live dan VPS

Live memerlukan modal/batas risiko eksplisit, wallet yang siap, `ENABLE_LIVE_EXECUTION=true` pada server, dan kelulusan evaluasi per profil strategi. Minimal 30 hari paper, 100 transaksi selesai, hasil bersih positif setelah biaya, drawdown sesuai batas dan rekonsiliasi bersih. Prediksi juga memerlukan minimal 50 event selesai dan evaluasi probabilitas. Mengubah model, skill atau profil tidak mewarisi kelulusan lama.

Docker Compose, Caddy HTTPS, backup terenkripsi dan prosedur restore tersedia di [deployment.md](deployment.md). Domain, host VPS, konfigurasi layanan serta verifikasi produksi harus diselesaikan pada lingkungan tujuan. Lihat [laporan verifikasi](verification.md) untuk hasil lokal yang telah dijalankan. Kelulusan evaluasi tidak menjamin keuntungan berikutnya atau nol kerugian.
