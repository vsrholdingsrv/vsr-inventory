import { useState } from 'react';
import Overview from './components/Overview';
import Scan from './components/Scan';
import PosTerminal from './components/PosTerminal';
import CommanderPull from './components/CommanderPull';
import InvoiceScan from './components/InvoiceScan';
import Stores from './components/Stores';
import Receive from './components/Receive';
import Ledger from './components/Ledger';
import CycleCount from './components/CycleCount';

const TABS = [
  'Overview',
  'Scan',
  'POS Terminal',
  'Commander Pull',
  'Invoice Scan',
  'Stores',
  'Receive',
  'Cycle Count',
  'Ledger',
] as const;

type Tab = (typeof TABS)[number];

export default function App() {
  const [tab, setTab] = useState<Tab>('Overview');

  return (
    <div className="app">
      <header className="app-header">
        <h1>VSR Inventory</h1>
        <p>Ledger-based inventory for Verifone Commander convenience stores.</p>
      </header>

      <nav className="tabs" aria-label="Screens">
        {TABS.map((t) => (
          <button
            key={t}
            className={tab === t ? 'active' : ''}
            onClick={() => setTab(t)}
            aria-current={tab === t ? 'page' : undefined}
          >
            {t}
          </button>
        ))}
      </nav>

      <main>
        {tab === 'Overview' && <Overview />}
        {tab === 'Scan' && <Scan />}
        {tab === 'POS Terminal' && <PosTerminal />}
        {tab === 'Commander Pull' && <CommanderPull />}
        {tab === 'Invoice Scan' && <InvoiceScan />}
        {tab === 'Stores' && <Stores />}
        {tab === 'Receive' && <Receive />}
        {tab === 'Cycle Count' && <CycleCount />}
        {tab === 'Ledger' && <Ledger />}
      </main>
    </div>
  );
}
