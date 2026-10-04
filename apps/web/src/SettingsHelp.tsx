import { useState, type RefObject } from 'react';
import { ArrowLeft, BookOpen, ChevronDown, ExternalLink, Search } from 'lucide-react';
import { Drawer } from './Drawer';
import { settingsGuides, type SettingsTab } from './settings-help';

export function SettingsHelp({ topic, onClose, returnFocusRef }: {
  topic: SettingsTab;
  onClose: () => void;
  returnFocusRef: RefObject<HTMLButtonElement | null>;
}) {
  const [query, setQuery] = useState('');
  const guide = settingsGuides[topic];
  const term = query.trim().toLocaleLowerCase('id');
  const sections = guide.sections.map(section => ({ ...section, fields: section.fields.filter(field =>
    !term || [section.title, field.name, field.description, field.example ?? ''].join(' ').toLocaleLowerCase('id').includes(term),
  ) })).filter(section => section.fields.length > 0);
  return <Drawer title={`Panduan · ${topic}`} onClose={onClose} returnFocusRef={returnFocusRef} nested>
    <div className="settings-help">
      <button className="text-button help-back" onClick={onClose}><ArrowLeft size={15}/>Kembali ke pengaturan</button>
      <p className="muted">{guide.intro}</p>
      <section className="help-start" aria-label="Langkah pengisian">
        <h3><BookOpen size={17}/>Mulai dari sini</h3>
        <ol>{guide.steps.map(step => <li key={step}>{step}</li>)}</ol>
      </section>
      <label className="help-search">Cari dalam panduan {topic}<span><Search size={16} aria-hidden="true"/><input type="search" value={query} onChange={e => setQuery(e.target.value)} placeholder="Cari nama kolom, satuan, atau masalah…"/></span></label>
      <p className="help-count" role="status">{sections.reduce((total, section) => total + section.fields.length, 0)} penjelasan tersedia</p>
      {sections.map((section, index) => <details className="help-section" key={`${section.title}:${!!term}`} open={term ? true : undefined}>
        <summary><span><small>{String(index + 1).padStart(2, '0')}</small>{section.title}</span><ChevronDown size={16} aria-hidden="true"/></summary>
        <dl>{section.fields.map(field => <div key={field.name}>
          <dt>{field.name}</dt><dd><p>{field.description}</p>{field.example && <div className="help-example"><span>Contoh pengisian</span><code>{field.example}</code></div>}</dd>
        </div>)}</dl>
      </details>)}
      {!sections.length && <div className="empty"><p>Tidak ada penjelasan yang cocok. Coba kata seperti “budget”, “key”, atau nama kolom.</p><button onClick={() => setQuery('')}>Hapus pencarian</button></div>}
      {guide.links && <footer className="help-links"><h3>Dokumentasi rujukan</h3>{guide.links.map(link => <a key={link.url} href={link.url} target="_blank" rel="noopener noreferrer">{link.label}<ExternalLink size={13}/><span className="sr-only"> (tab baru)</span></a>)}</footer>}
    </div>
  </Drawer>;
}
