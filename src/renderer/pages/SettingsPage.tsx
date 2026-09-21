import { useEffect, useState } from 'react';
import { useLocation } from 'react-router';
import { useSettings, useSyncStatus, useWorkspace } from '../lib/queries';
import { SidebarToggle } from '../components/layout/shell';
import { AboutCard } from '../components/settings/AboutCard';
import { AdvancedCard } from '../components/settings/AdvancedCard';
import { AttachmentsCard } from '../components/settings/AttachmentsCard';
import { ConnectionCard } from '../components/settings/ConnectionCard';
import { StorageCard } from '../components/settings/StorageCard';
import { SyncSettingsCard } from '../components/settings/SyncSettingsCard';
import { WhatToArchiveCard } from '../components/settings/WhatToArchiveCard';
import { ErrorState } from '../components/ui/EmptyState';
import { LoadingState } from '../components/ui/Spinner';

/**
 * `/settings` (PLAN §8.4): deliberately small. Cards that need the saved settings wait for them;
 * storage, about and the advanced options load on their own, so one failure never blanks the page.
 */
export default function SettingsPage() {
  const settings = useSettings();
  const sync = useSyncStatus();
  const workspace = useWorkspace();
  const location = useLocation();
  const [advancedOpen, setAdvancedOpen] = useState(() => location.hash === '#advanced');
  const data = settings.data;

  // `/settings#storage` (and friends) scroll to that card; `#advanced` also unfolds it.
  const ready = data != null || settings.isError;
  useEffect(() => {
    if (!ready || !location.hash) return;
    const id = decodeURIComponent(location.hash.slice(1));
    if (id === 'advanced') setAdvancedOpen(true);
    requestAnimationFrame(() => document.getElementById(id)?.scrollIntoView?.({ block: 'start' }));
  }, [ready, location.hash]);

  let settingsCards;
  if (data) {
    settingsCards = (
      <>
        <ConnectionCard connection={data.connection} />
        <SyncSettingsCard preferences={data.preferences} status={sync.data} statusError={sync.error} />
        <WhatToArchiveCard excludedIds={data.preferences.excludedConversationIds} />
        <AttachmentsCard policy={data.preferences.attachmentPolicy} />
      </>
    );
  } else if (settings.isError) {
    settingsCards = (
      <div className="rounded-2xl border border-line bg-raised">
        <ErrorState
          compact
          error={settings.error}
          title="Couldn’t load your settings"
          onRetry={() => void settings.refetch()}
        />
      </div>
    );
  } else {
    settingsCards = <LoadingState label="Loading settings…" />;
  }

  const teamDomain = data?.connection.teamDomain ?? workspace.data?.teamDomain ?? null;
  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col">
      <header className="flex h-14 shrink-0 items-center gap-2 border-b border-line px-4">
        <SidebarToggle />
        <h1 className="text-[15px] font-semibold text-ink">Settings</h1>
      </header>
      <div className="scroll-thin relative min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex max-w-3xl flex-col gap-6 px-4 py-6 sm:px-6 lg:py-8">
          {settingsCards}
          <StorageCard />
          <AboutCard />
          <AdvancedCard open={advancedOpen} onOpenChange={setAdvancedOpen} status={sync.data} teamDomain={teamDomain} />
        </div>
      </div>
    </section>
  );
}
