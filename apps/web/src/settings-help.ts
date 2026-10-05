import { settingLabel } from './settings-labels';

export const settingsTabs = ['Risiko', 'Provider AI', 'Layanan', 'Wallet'] as const;
export type SettingsTab = typeof settingsTabs[number];
export interface HelpField { name: string; description: string; example?: string }
export interface HelpSection { title: string; fields: HelpField[] }
interface SettingsGuide {
  intro: string;
  steps: string[];
  sections: HelpSection[];
  links?: { label: string; url: string }[];
}
const field = (key: string, description: string, example?: string): HelpField => ({ name: settingLabel(key), description, example });

export const settingsGuides: Record<SettingsTab, SettingsGuide> = {
  Risiko: {
    intro: 'Atur batas operasi terlebih dahulu. Contoh di sini hanya menjelaskan format dan preset simulasi; membuka panduan tidak mengubah nilai pengaturan.',
    steps: [
      'Mulai dari profil PAPER. pUSD adalah satuan modal dan transaksi; biaya AI, riset, dan infrastruktur diisi dalam USD.',
      'Isi rasio sebagai desimal: 0.01 berarti 1%, 0.10 berarti 10%. Gunakan titik untuk angka desimal, tanpa pemisah ribuan.',
      'Simpan konfigurasi dan selesaikan verifikasi password. Pengaturan baru berlaku setelah penyimpanan berhasil.',
    ],
    sections: [
      { title: 'Modal dan batas risiko', fields: [
        field('capital', 'Modal acuan untuk batas risiko. Perubahan modal paper mencatat selisih deposit atau withdrawal tanpa menghapus riwayat laba. Modal live harus sesuai dana yang tersedia.', '1000 = 1.000 pUSD virtual pada preset paper'),
        field('eventExposure', 'Porsi modal maksimum untuk satu event, termasuk pasar terkait dalam event tersebut. Maksimal 0.25 dan tidak boleh melebihi exposure total.', '0.01 = 1% modal; pada modal 1000, batasnya 10 pUSD'),
        field('totalExposure', 'Porsi modal maksimum untuk seluruh exposure. Rentang 0–1; nilai 0 menghalangi entry baru.', '0.10 = 10% modal'),
        field('dailyLoss', 'Ambang rugi harian yang menghentikan pembukaan posisi. Rentang 0.001–0.25. Ambang ini bukan jaminan kerugian berhenti tepat pada nominal tersebut.', '0.01 = 1%'),
        field('maxDrawdown', 'Batas penurunan equity dari puncaknya. Rentang 0.001–0.50. Penghentian akibat risiko tidak otomatis menghapus batas ini.', '0.05 = 5%'),
        { name: 'Konfigurasi profil live', description: 'Menyimpan profil live belum mengaktifkan transaksi uang nyata. Wallet, evaluasi strategi, persetujuan risiko dan konfigurasi server tetap diperiksa.' },
      ] },
      { title: 'Strategi dan eksekusi', fields: [
        field('minimumEdge', 'Selisih probabilitas minimum untuk peluang prediktif setelah pemeriksaan biaya dan ketidakpastian. Rentang 0.01–1.', '0.05 = 5 poin persentase'),
        field('slippageBps', 'Batas pergeseran harga dalam basis points. 100 bps = 1%; rentang 0–500, bilangan bulat.', '30 = 0,30%'),
        field('maxRecoveryLoss', 'Batas biaya pemulihan arbitrase yang hanya terisi satu sisi, dalam pUSD. Kondisi pasar dapat membuat pemulihan tertunda.', '1 = 1 pUSD'),
        field('maxHoldingHours', 'Lama posisi maksimum sebelum proses exit dipicu. Rentang 1–720 jam; exit masih tunduk pada likuiditas dan batas harga.', '168 = 7 hari'),
        field('minimumLiquidity', 'Ambang likuiditas pasar dalam pUSD untuk shortlist. Kedalaman order book tetap diperiksa sebelum eksekusi.', '1000'),
        field('minimumVolume', 'Ambang volume pasar dalam pUSD untuk shortlist.', '100'),
        field('mergeCost', 'Estimasi biaya menggabungkan pasangan YES/NO. Masukkan biaya yang relevan dengan operasi wallet yang digunakan.', '0.01 = 0,01 pUSD'),
        field('arbitrageAllocation', 'Porsi modal yang dialokasikan untuk arbitrase. Jumlah alokasi arbitrase dan prediksi tidak boleh melebihi 1.', '0.50 = 50%'),
        field('predictionAllocation', 'Porsi modal untuk prediksi AI. Batas exposure tetap berlaku di dalam alokasi ini.', '0.50 = 50%'),
        { name: 'Strategi arbitrase / prediksi aktif', description: 'Centang strategi yang diizinkan mencari entry. Prediksi juga membutuhkan provider, assignment, bukti dan budget yang siap. Tidak ada peluang layak berarti agent menunggu.' },
      ] },
      { title: 'Worker dan biaya layanan', fields: [
        field('scanIntervalSeconds', 'Jeda pemindaian pasar, 15–3600 detik. Interval lebih cepat meningkatkan pemakaian API.', '60 = sekali per menit'),
        field('maxMarkets', 'Jumlah maksimum pasar dalam pemindaian, 2–200.', '40'),
        field('paperLatencyMs', 'Keterlambatan eksekusi simulasi, 100–10000 ms.', '750 = 0,75 detik'),
        field('paperFailureRate', 'Porsi kegagalan buatan dalam simulasi, 0–0.25, untuk menilai pemulihan.', '0.01 = 1%'),
        field('researchDailyBudgetUsd', 'Batas biaya layanan pencarian per hari. Nilai 0 memblokir permintaan yang membutuhkan reservasi biaya. Budget provider AI diatur terpisah.', '2 = maksimal 2 USD per hari; contoh saja'),
        field('researchMonthlyBudgetUsd', 'Batas biaya pencarian per bulan. Permintaan harus lolos batas harian dan bulanan sekaligus.', '30 = maksimal 30 USD per bulan; contoh saja'),
        field('infrastructureDailyCostUsd', 'Biaya VPS/data tetap per hari untuk pembukuan biaya operasional. Masukkan proporsi biaya yang dibebankan ke sistem ini.', 'Tagihan 6 USD per 30 hari → 0.20'),
        field('serviceCostConversion', 'Nilai pUSD per USD untuk menilai biaya layanan di ledger. Ini asumsi yang Anda tetapkan, bukan kurs otomatis.', '1 = 1 pUSD per USD'),
      ] },
      { title: 'Jika penyimpanan ditolak', fields: [
        { name: 'Rasio atau alokasi tidak valid', description: 'Periksa satuan desimal, exposure per event ≤ total, dan jumlah alokasi ≤ 1. Nominal uang menerima maksimal 8 angka desimal.' },
        { name: 'Versi pengaturan berubah', description: 'Muat ulang Settings untuk memperoleh versi terbaru, lalu periksa nilai sebelum menyimpan kembali. Perubahan di tab lain dapat mengganti versi konfigurasi.' },
      ] },
    ],
  },
  'Provider AI': {
    intro: 'Koneksi resmi memakai API penyedia secara langsung. Koneksi custom harus cocok dengan protokol server. API key disimpan terenkripsi dan tidak ditampilkan kembali.',
    steps: [
      'Pilih protokol, isi nama dan ID model. Untuk provider resmi, kosongkan Endpoint API. Untuk custom, ikuti format endpoint di bawah.',
      'Isi API key, harga token sesuai model, batas biaya dan batas panggilan. Centang Aktifkan provider, lalu Simpan provider.',
      'Jalankan Probe pada kartu provider yang tersimpan. Periksa text, tools, structured dan usage; pengujian dapat memakai kredit API.',
      'Pilih role dan provider utama di Model assignment, lalu simpan. Aktifkan fallback hanya jika memang ingin mengizinkan provider cadangan.',
    ],
    sections: [
      { title: 'Identitas, protokol dan endpoint', fields: [
        { name: 'Nama', description: 'Nama koneksi untuk membedakan akun, gateway atau model. Tidak memengaruhi ID model yang dikirim ke API.', example: 'Riset utama' },
        { name: 'Protokol resmi', description: 'OpenAI: pilih Responses atau Chat Completions sesuai dukungan model. Anthropic menggunakan Messages; Google menggunakan Gemini. Endpoint resmi tidak dapat diganti ke gateway lain.' },
        { name: 'Custom · OpenAI Chat Completions', description: 'Isi base URL tanpa akhiran /chat/completions. Server harus mendukung Chat Completions.', example: 'https://gateway.example/v1' },
        { name: 'Custom · Responses', description: 'Isi URL lengkap endpoint POST Responses, termasuk /responses. Server Chat Completions saja tidak cukup.', example: 'https://gateway.example/v1/responses' },
        { name: 'Custom · Anthropic Messages', description: 'Isi base URL tanpa akhiran /messages. Server harus mendukung format Messages API.', example: 'https://gateway.example/v1' },
        { name: 'Model / Temukan model', description: 'Salin ID model persis dari penyedia, bukan nama tampilan. Temukan model mencoba daftar model dari konfigurasi tersimpan; jika gateway tidak mendukungnya, isi ID secara manual. Custom discovery dapat menahan estimasi biaya ketika penggunaan tidak diketahui.' },
        { name: 'Endpoint lokal', description: 'Alamat internal dan metadata server diblokir. Administrator dapat mengizinkan origin model lokal tertentu melalui AI_ENDPOINT_ALLOWLIST di server; pengaturan ini tidak tersedia untuk agent.' },
      ] },
      { title: 'Kunci dan header autentikasi', fields: [
        { name: 'API key', description: 'Ambil key dari konsol API penyedia. Isi key mentah tanpa awalan Bearer. Saat edit, biarkan semua kolom secret kosong untuk mempertahankan secret lama. Jika memperbarui sebagian secret, isi ulang seluruh konfigurasi secret yang diperlukan.' },
        { name: 'Custom auth header', description: 'Kosongkan untuk autentikasi standar. Khusus custom: isi nama header nonstandar yang diminta gateway; nilainya diambil dari API key. Authorization, x-api-key dan header standar lain dikelola adapter.', example: 'x-gateway-token' },
        { name: 'Custom headers (JSON)', description: 'Objek JSON dengan nama dan nilai string. Gunakan hanya header tambahan yang diperlukan. Jangan isi Host, Cookie, Authorization, x-api-key, x-goog-api-key atau header proxy.', example: '{"x-tenant-id":"workspace-saya"}' },
      ] },
      { title: 'Anggaran dan batas pemanggilan', fields: [
        field('inputPricePerMillion', 'Harga USD untuk 1 juta token input menurut tarif model Anda. Wajib diisi untuk reservasi biaya. Isi 0 hanya jika benar-benar tidak ada biaya.'),
        field('outputPricePerMillion', 'Harga USD untuk 1 juta token output. Harga ini mengestimasi biaya; tagihan aktual tetap mengikuti penyedia.'),
        field('dailyBudgetUsd', 'Batas biaya harian untuk koneksi ini. Nilai 0 menghalangi permintaan yang membutuhkan biaya. Sistem mereservasi batas biaya sebelum memanggil model.'),
        field('monthlyBudgetUsd', 'Batas biaya bulanan koneksi ini. Permintaan harus lolos kedua budget; sisa budget kecil dapat gagal memenuhi reservasi maksimum.'),
        field('timeoutMs', 'Batas waktu permintaan, 3000–120000 ms. Timeout tidak membuktikan permintaan belum ditagihkan.', '30000 = 30 detik'),
        field('maxOutputTokens', 'Batas token jawaban, 64–32000. Terlalu rendah dapat memotong output terstruktur.', '2000'),
        field('concurrency', 'Jumlah panggilan bersamaan, 1–8. Mulai dari kapasitas yang didukung akun/provider.', '1'),
        field('callsPerMinute', 'Batas panggilan aplikasi untuk provider ini, 1–120 per menit. Rate limit penyedia tetap berlaku.', '10'),
        field('retries', 'Cadangan biaya retry, 0–2. Versi ini menonaktifkan retry otomatis pada SDK; angka ini memperbesar reservasi, bukan menjamin pengiriman ulang.', '0'),
      ] },
      { title: 'Assignment, fallback dan masalah koneksi', fields: [
        { name: 'Role', description: 'research: riset; evidence: pemeriksaan bukti; forecast: probabilitas; summary: ringkasan. Satu provider yang kompatibel dapat dipakai untuk beberapa role.' },
        { name: 'Provider utama / fallback', description: 'Pilih provider aktif yang lulus kemampuan role tersebut. Urutan fallback mengikuti urutan Anda mencentang provider cadangan. Model baru atau konfigurasi yang diubah perlu diuji ulang; kelulusan live tidak otomatis diwariskan.' },
        { name: 'Probe gagal', description: 'Periksa key, ID model, protokol dan saldo akun penyedia. Text berhasil belum membuktikan tools atau structured berhasil. Detail kemampuan dan pesan aman tampil pada kartu provider.' },
        { name: 'Budget / reservasi ditolak', description: 'Pastikan harga input dan output terisi serta kedua budget memiliki sisa yang cukup untuk batas maksimum satu panggilan. Budget riset pada tab Risiko bukan budget provider AI.' },
      ] },
    ],
    links: [
      { label: 'OpenAI · menyiapkan API key', url: 'https://developers.openai.com/api/docs/quickstart' },
      { label: 'Format endpoint Open Responses', url: 'https://ai-sdk.dev/providers/ai-sdk-providers/open-responses' },
    ],
  },
  Layanan: {
    intro: 'Layanan pencarian memberi sumber baru kepada agent. Feed publik menyediakan konteks berita. Hasil pencarian dan feed tetap perlu diverifikasi terhadap aturan market.',
    steps: [
      'Untuk pencarian, masukkan key Tavily dan harga kredit dari paket Anda, aktifkan layanan lalu simpan.',
      'Isi budget riset harian dan bulanan pada tab Risiko. Jalankan Probe konfigurasi tersimpan untuk memeriksa koneksi.',
      'Aktifkan feed RSS/Atom yang relevan. Worker akan memperbaruinya meskipun dashboard ditutup.',
    ],
    sections: [
      { title: 'Tavily dan pencarian berita', fields: [
        { name: 'API key / Aktifkan Tavily', description: 'Ambil key dari akun Tavily. Key yang tersimpan dienkripsi; kosong saat edit berarti mempertahankan key. Status environment berarti server menyediakan key. Simpan perubahan sebelum Probe.' },
        { name: 'USD / credit', description: 'Harga estimasi per kredit sesuai paket Anda, lebih dari 0 sampai 1 USD. Nilai awal aplikasi bukan jaminan tarif akun Anda; periksa tagihan atau dokumentasi penyedia.' },
        { name: 'Probe konfigurasi tersimpan', description: 'Memeriksa koneksi tersimpan dan dapat memakai kredit. Keberhasilan membutuhkan key, layanan aktif dan budget riset yang cukup.' },
        { name: 'Kata kunci / Cari berita', description: 'Masukkan pertanyaan atau topik yang spesifik, maksimal 1000 karakter. Pencarian manual mengambil maksimal enam sumber bertanggal valid dari 24 jam terakhir dan memakai budget riset.', example: 'Federal Reserve interest rate decision' },
      ] },
      { title: 'Feed berita publik', fields: [
        { name: 'Interval (detik)', description: 'Jeda pengambilan feed, 300–86400 detik. Interval berlaku untuk worker, bukan refresh tampilan browser.', example: '300 = 5 menit' },
        { name: 'Usia maksimum (jam)', description: 'Batas umur publikasi berita, 1–24 jam. Berita tanpa tanggal yang valid tidak dianggap bukti segar.', example: '24' },
        { name: 'ID unik', description: 'Identitas tetap feed: huruf kecil, angka dan tanda hubung, maksimal 60 karakter. Tidak boleh sama dengan feed lain.', example: 'federal-reserve' },
        { name: 'Nama sumber', description: 'Nama yang ditampilkan di dashboard, maksimal 100 karakter.', example: 'Federal Reserve releases' },
        { name: 'URL feed', description: 'Gunakan URL RSS/Atom publik dengan HTTPS, bukan halaman artikel. Maksimal 10 feed; URL tanpa username/password dan hanya port HTTPS standar.', example: 'https://www.federalreserve.gov/feeds/press_all.xml' },
        { name: 'Aktif / Sumber primer', description: 'Aktif mengizinkan worker mengambil feed. Centang Sumber primer hanya untuk penerbit informasi langsung, seperti rilis lembaga; label ini tidak mengubah berita menjadi bukti yang sudah diverifikasi.' },
      ] },
      { title: 'Jika layanan belum siap', fields: [
        { name: 'unconfigured / untested / blocked', description: 'unconfigured: key belum tersedia. untested: konfigurasi belum lolos Probe. blocked: periksa pesan Probe, budget atau koneksi. Menyimpan key saja belum membuktikan layanan bekerja.' },
        { name: 'Feed kosong atau gagal', description: 'Pastikan URL benar-benar RSS/Atom, HTTPS publik, dan memiliki tanggal publikasi yang masih berlaku. Periksa status worker dan pesan sumber di Berita & konteks terbaru.' },
      ] },
    ],
    links: [{ label: 'Tavily · kredit dan harga', url: 'https://docs.tavily.com/documentation/api-credits' }],
  },
  Wallet: {
    intro: 'Wallet trading khusus dibuat di server untuk operasi 24/7. Paper tidak membutuhkan wallet. Koneksi awal memakai Builder API key resmi Polymarket.',
    steps: [
      'Pilih Siapkan koneksi awal. Ambil Builder key, secret, dan passphrase dari Settings → Builders di akun Polymarket, lalu simpan.',
      'Pilih Hubungkan wallet. Worker membuat signer terenkripsi, menyiapkan Deposit Wallet, autentikasi CLOB dan allowance melalui SDK. Alamat muncul setelah akun terkonfirmasi.',
      'Tetap gunakan paper selama evaluasi. Aktivasi live baru tersedia setelah persyaratan strategi, wallet dan konfigurasi server terpenuhi.',
    ],
    sections: [
      { title: 'Alamat dan persetujuan', fields: [
        { name: 'Alamat wallet', description: 'Dihasilkan oleh proses koneksi. Ini alamat akun trading/funder pada Polygon; berbeda dari alamat signer. Gunakan hanya alamat akun yang telah terkonfirmasi untuk pendanaan. Private key tidak diminta atau ditampilkan di dashboard.' },
        { name: 'Persetujuan risiko live', description: 'Centang hanya setelah memahami kemungkinan kehilangan modal. Persetujuan ini tidak mengaktifkan live dengan sendirinya dan tidak menjamin keuntungan.' },
        { name: 'Perbarui status', description: 'Menjalankan pemeriksaan konfigurasi, akses, saldo dan allowance. Checklist diperbarui otomatis. Terhubung tidak langsung mengaktifkan trading live.' },
      ] },
      { title: 'Konfigurasi di server', fields: [
        { name: 'Signer dan wallet', description: 'Signer baru dibuat di server dan disimpan terenkripsi dalam database. MASTER_KEY dan BACKUP_KEY harus dipertahankan terpisah agar wallet dapat dipulihkan. Instalasi lama melalui environment tetap didukung.' },
        { name: 'CLOB dan relayer', description: 'SDK menurunkan kredensial CLOB dan memakai Builder API key untuk relayer. Kredensial resmi diperlukan pada penyiapan awal. POLYGON_RPC_URL opsional untuk RPC khusus yang dipasang administrator di server.' },
        { name: 'Setup belum pasti', description: 'Jika koneksi putus di tengah pembuatan wallet atau allowance, signer dipertahankan dan pengiriman ulang dihentikan. Operator memeriksa transaksi relayer dan alamat akun sebelum memulihkan setup; jangan membuat wallet baru untuk menggantikannya.' },
        { name: 'Gerbang live', description: 'Per strategi: minimal 30 hari paper, 100 transaksi selesai, net positif setelah biaya, drawdown dalam batas dan rekonsiliasi bersih. Prediksi juga membutuhkan minimal 50 event selesai serta evaluasi probabilitas. ENABLE_LIVE_EXECUTION tetap false pada pemasangan awal.' },
        { name: 'Emergency stop', description: 'Menghentikan entry dan memulai pembatalan order terbuka sambil mempertahankan pemantauan posisi. Ini tidak otomatis menutup semua posisi atau menjamin tidak ada kerugian.' },
      ] },
    ],
    links: [{ label: 'Polymarket · wallet dan autentikasi', url: 'https://docs.polymarket.com/trading/wallets-auth' }],
  },
};
