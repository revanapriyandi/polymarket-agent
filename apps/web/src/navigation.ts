import { ChartNoAxesCombined, Wallet, ScanLine, ChartLine, Newspaper, Bot, Settings2, type LucideIcon } from 'lucide-react';

export interface NavigationPage { path: string; label: string; description: string }
export interface NavigationGroup { label: string; icon: LucideIcon; pages: NavigationPage[] }
export const navigation: NavigationGroup[] = [
  { label: 'Ringkasan', icon: ChartNoAxesCombined, pages: [{ path: '/', label: 'Ringkasan trading', description: 'Nilai portofolio, hasil bersih, dan exposure saat ini.' }] },
  { label: 'Portofolio', icon: Wallet, pages: [
    { path: '/portfolio/positions', label: 'Posisi', description: 'Pantau saham, valuasi, dan status penyelesaian posisi.' },
    { path: '/portfolio/orders', label: 'Order', description: 'Pantau pengisian, batalkan, atau ganti order yang masih memenuhi syarat.' },
    { path: '/portfolio/history', label: 'Riwayat transaksi', description: 'Telusuri transaksi dan pembukuan dana pada mode aktif.' },
  ] },
  { label: 'Pasar', icon: ScanLine, pages: [
    { path: '/markets/opportunities', label: 'Peluang', description: 'Kandidat dari pemindaian pasar; setiap entry tetap melalui pemeriksaan risiko.' },
    { path: '/markets/decisions', label: 'Keputusan trading', description: 'Alasan persetujuan atau penolakan setiap usulan transaksi.' },
  ] },
  { label: 'Analitik', icon: ChartLine, pages: [
    { path: '/analytics/performance', label: 'Performa', description: 'Analisis ekuitas, P&L bersih, drawdown, dan biaya.' },
    { path: '/analytics/evaluation', label: 'Evaluasi strategi', description: 'Nilai bukti paper dan kalibrasi sebelum promosi strategi.' },
    { path: '/analytics/replay', label: 'Replay pasar', description: 'Uji kandidat arbitrase menggunakan snapshot order book tersimpan.' },
  ] },
  { label: 'Riset', icon: Newspaper, pages: [
    { path: '/research/news', label: 'Berita & sumber', description: 'Konteks pasar dari sumber publik dengan tanggal dan status kesegaran.' },
    { path: '/research/forecasts', label: 'Forecast AI', description: 'Probabilitas, bukti, dan masa berlaku analisis model.' },
  ] },
  { label: 'Agent & sistem', icon: Bot, pages: [
    { path: '/system/agents', label: 'Agent', description: 'Pantau tugas, hasil, dan alasan agent menunggu.' },
    { path: '/system/health', label: 'Kesehatan sistem', description: 'Koneksi, antrean, wallet, dan kendala operasional.' },
    { path: '/system/activity', label: 'Log aktivitas', description: 'Aktivitas terbaru dari worker dan perubahan operasi.' },
    { path: '/system/invocations', label: 'Pemakaian AI', description: 'Panggilan model dan pencatatan estimasi biayanya.' },
    { path: '/system/tools', label: 'Riwayat tools', description: 'Hasil tools, versi skill, dan durasi pekerjaan agent.' },
  ] },
  { label: 'Pengaturan', icon: Settings2, pages: [
    { path: '/settings/risk', label: 'Modal & risiko', description: 'Tetapkan modal, batas risiko, dan budget operasional.' },
    { path: '/settings/providers', label: 'Provider AI', description: 'Hubungkan API resmi atau custom, uji kemampuan, lalu tetapkan peran model.' },
    { path: '/settings/services', label: 'Layanan & sumber', description: 'Atur pencarian berita dan feed yang digunakan untuk riset.' },
    { path: '/settings/wallet', label: 'Wallet', description: 'Periksa kesiapan wallet trading dan persyaratan live.' },
  ] },
];
