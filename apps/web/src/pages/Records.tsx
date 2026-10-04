import type { TableName } from '../../../../packages/shared/src/index';
import type { SettingsTab } from '../settings-help';
import { useTrading } from '../TradingContext';
import { DataTable } from '../DataTable';
import { Settings } from '../Settings';
import { Trends } from '../Services';

export function Records({ name }: { name: TableName }) {
  const { snapshot, secure } = useTrading();
  return snapshot ? <DataTable key={`${name}-${snapshot.mode}`} name={name} mode={snapshot.mode} secure={secure}/> : null;
}
export function SettingsPage({ section }: { section: SettingsTab }) { const { secure } = useTrading(); return <Settings key={section} tab={section} secure={secure}/>; }
export function News() { return <Trends/>; }
