import { Database, Keyboard, type LucideIcon, RefreshCw, Settings2, Zap } from 'lucide-react';
import { type ReactNode, useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';
import { ScrollArea } from '@/components/ui/scroll-area';
import { cn } from '@/lib/utils';
import { DataSection } from './data';
import { PlaybackSettings } from './playback';
import { ShortcutsSection } from './shortcuts';
import { StreamingSources } from './streaming';
import { UpdatesSection } from './updates';

type SectionId = 'streaming' | 'playback' | 'shortcuts' | 'updates' | 'data';

interface NavItem {
  id: SectionId;
  label: string;
  icon: LucideIcon;
  description: string;
}

const DEFAULT_SECTION: SectionId = 'streaming';
const SETTINGS_SECTION_QUERY_PARAM = 'section';

const NAV_ITEMS: NavItem[] = [
  { id: 'streaming', label: 'Streaming', icon: Zap, description: 'Stream sources & addons' },
  { id: 'playback', label: 'Playback', icon: Settings2, description: 'Audio, subtitles & display' },
  { id: 'shortcuts', label: 'Shortcuts', icon: Keyboard, description: 'Keyboard bindings' },
  { id: 'updates', label: 'Updates', icon: RefreshCw, description: 'App version & releases' },
  { id: 'data', label: 'Data', icon: Database, description: 'Backup, restore & storage' },
];

const SECTION_MAP: Record<SectionId, () => ReactNode> = {
  streaming: () => <StreamingSources />,
  playback: () => <PlaybackSettings />,
  shortcuts: () => <ShortcutsSection />,
  updates: () => <UpdatesSection />,
  data: () => <DataSection />,
};

const NAV_ITEMS_BY_ID: Record<SectionId, NavItem> = NAV_ITEMS.reduce(
  (itemsById, item) => {
    itemsById[item.id] = item;
    return itemsById;
  },
  {} as Record<SectionId, NavItem>,
);

function resolveSectionId(value: string | null): SectionId {
  if (!value) {
    return DEFAULT_SECTION;
  }

  return value in NAV_ITEMS_BY_ID ? (value as SectionId) : DEFAULT_SECTION;
}

export function Settings() {
  const [searchParams, setSearchParams] = useSearchParams();
  const active = resolveSectionId(searchParams.get(SETTINGS_SECTION_QUERY_PARAM));

  const handleSectionChange = useCallback(
    (sectionId: SectionId) => {
      setSearchParams(
        (currentParams) => {
          const nextParams = new URLSearchParams(currentParams);

          if (sectionId === DEFAULT_SECTION) {
            nextParams.delete(SETTINGS_SECTION_QUERY_PARAM);
          } else {
            nextParams.set(SETTINGS_SECTION_QUERY_PARAM, sectionId);
          }

          return nextParams;
        },
        { replace: true },
      );
    },
    [setSearchParams],
  );

  return (
    <div className='flex h-[calc(100dvh-4rem)] md:pl-[60px]'>
      {/* Sidebar */}
      <aside className='w-52 shrink-0 border-r border-white/[0.06] flex flex-col overflow-y-auto'>
        <div className='px-5 pt-6 pb-4'>
          <h1 className='text-[15px] font-semibold text-white tracking-tight'>Settings</h1>
          <p className='text-[11px] text-zinc-500 mt-0.5'>Preferences & configuration</p>
        </div>

        <nav className='flex-1 px-2.5 space-y-0.5'>
          {NAV_ITEMS.map((item) => {
            const isActive = active === item.id;
            return (
              <button
                key={item.id}
                type='button'
                onClick={() => handleSectionChange(item.id)}
                className={cn(
                  'w-full flex items-center gap-2.5 px-3 py-2 text-left rounded transition-colors duration-100',
                  isActive
                    ? 'bg-white/[0.08] text-white'
                    : 'text-zinc-400 hover:text-zinc-200 hover:bg-white/[0.04]',
                )}
              >
                <item.icon
                  className={cn(
                    'w-[15px] h-[15px] shrink-0',
                    isActive ? 'text-white' : 'text-zinc-500',
                  )}
                />
                <span className='text-[13px] font-medium truncate'>{item.label}</span>
              </button>
            );
          })}
        </nav>
      </aside>

      {/* Content — centered within the remaining space */}
      <ScrollArea className='flex-1 min-h-0'>
        <div className='flex justify-center px-8 py-6'>
          <div className='w-full max-w-2xl'>
            <SectionHeader item={NAV_ITEMS_BY_ID[active]} />
            <div className='mt-5'>{SECTION_MAP[active]()}</div>
          </div>
        </div>
      </ScrollArea>
    </div>
  );
}

function SectionHeader({ item }: { item: NavItem }) {
  return (
    <div className='flex items-center gap-3'>
      <div className='w-8 h-8 rounded bg-white/[0.06] flex items-center justify-center'>
        <item.icon className='w-4 h-4 text-zinc-400' />
      </div>
      <div>
        <h2 className='text-[15px] font-semibold text-white'>{item.label}</h2>
        <p className='text-[11px] text-zinc-500'>{item.description}</p>
      </div>
    </div>
  );
}
