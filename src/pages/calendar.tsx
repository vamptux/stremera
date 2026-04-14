import { useQuery } from '@tanstack/react-query';
import {
  addDays,
  addMonths,
  eachDayOfInterval,
  endOfDay,
  endOfMonth,
  endOfWeek,
  format,
  isSameDay,
  isSameMonth,
  isValid,
  isWithinInterval,
  parseISO,
  startOfDay,
  startOfMonth,
  startOfWeek,
  subMonths,
} from 'date-fns';
import { ChevronLeft, ChevronRight, Loader2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { useLibraryItems, useWatchHistory, useWatchStatuses } from '@/hooks/use-media-library';
import { api, type MediaItem, type MediaSchedule, type WatchStatus } from '@/lib/api';
import { cn } from '@/lib/utils';

interface CalendarEvent {
  id: string; // episode id or movie id
  mediaId: string;
  mediaType: MediaSchedule['type'];
  title: string;
  seriesTitle: string;
  season?: number;
  episode?: number;
  date: Date;
  poster?: string;
  thumbnail?: string;
  type: 'movie' | 'episode';
}

function parseScheduleDate(value?: string): Date | null {
  if (!value) return null;

  const parsed = parseISO(value);
  return isValid(parsed) ? parsed : null;
}

function toCalendarDetailsRouteType(mediaType: CalendarEvent['mediaType']) {
  return mediaType === 'anime' ? 'anime' : mediaType === 'movie' ? 'movie' : 'series';
}

export function Calendar() {
  const location = useLocation();
  const [currentMonth, setCurrentMonth] = useState(new Date());
  const from = `${location.pathname}${location.search}`;

  // 1. Get Library
  const { data: library, isLoading: libraryLoading } = useLibraryItems();

  const { data: allWatchStatuses } = useWatchStatuses({
    staleTime: 1000 * 60 * 5,
  });

  const { data: watchHistory } = useWatchHistory({
    staleTime: 1000 * 60 * 3,
  });

  // 2. Get Schedules
  const libraryItems = useMemo(() => library ?? [], [library]);
  const watchHistoryById = useMemo(() => {
    const map = new Map<
      string,
      { id: string; type_: string; title: string; poster?: string; last_watched: number }
    >();
    (watchHistory ?? []).forEach((entry) => {
      if (!entry?.id) return;
      const existing = map.get(entry.id);
      if (!existing || entry.last_watched > existing.last_watched) {
        map.set(entry.id, {
          id: entry.id,
          type_: entry.type_,
          title: entry.title,
          poster: entry.poster,
          last_watched: entry.last_watched,
        });
      }
    });
    return map;
  }, [watchHistory]);

  const schedulableItems = useMemo(() => {
    const byKey = new Map<string, MediaItem>();

    libraryItems
      .filter((item) => item.type === 'movie' || item.type === 'series')
      .forEach((item) => {
        byKey.set(`${item.type}:${item.id}`, item);
      });

    Object.entries(allWatchStatuses ?? {}).forEach(([itemId, status]) => {
      if ((status as WatchStatus) !== 'watching') return;

      const fromHistory = watchHistoryById.get(itemId);
      if (!fromHistory) return;

      if (fromHistory.type_ !== 'movie' && fromHistory.type_ !== 'series') return;

      const historyItem: MediaItem = {
        id: fromHistory.id,
        title: fromHistory.title,
        poster: fromHistory.poster,
        type: fromHistory.type_,
      };

      byKey.set(`${historyItem.type}:${historyItem.id}`, historyItem);
    });

    return Array.from(byKey.values());
  }, [libraryItems, allWatchStatuses, watchHistoryById]);

  const scheduleLookupItems = useMemo(
    () => schedulableItems.map((item) => ({ mediaType: item.type, id: item.id })),
    [schedulableItems],
  );
  const scheduleLookupKey = useMemo(
    () => scheduleLookupItems.map((item) => `${item.mediaType}:${item.id}`).join('|'),
    [scheduleLookupItems],
  );
  const {
    data: schedules = [],
    isLoading: isLoadingSchedules,
    isFetching: isFetchingSchedules,
  } = useQuery({
    queryKey: ['media-schedules', scheduleLookupKey],
    queryFn: () => api.getMediaSchedules(scheduleLookupItems),
    enabled: scheduleLookupItems.length > 0,
    staleTime: 1000 * 60 * 60,
  });
  const isScheduleLoading =
    scheduleLookupItems.length > 0 && (isLoadingSchedules || isFetchingSchedules);

  // 3. Flatten into events
  const events = useMemo(() => {
    const allEvents: CalendarEvent[] = [];
    const currentYear = new Date().getFullYear();

    for (const schedule of schedules) {
      if (!schedule) {
        continue;
      }

      if (schedule.type === 'movie') {
        const releaseDate = parseScheduleDate(schedule.releaseDate);
        if (releaseDate && releaseDate.getFullYear() >= currentYear) {
          allEvents.push({
            id: schedule.id,
            mediaId: schedule.id,
            mediaType: schedule.type,
            title: schedule.title,
            seriesTitle: schedule.title,
            date: releaseDate,
            poster: schedule.poster,
            type: 'movie',
          });
        }
      }

      if (schedule.type !== 'movie') {
        schedule.episodes.forEach((episode) => {
          const date = parseScheduleDate(episode.releaseDate);
          if (date) {
            allEvents.push({
              id: episode.id,
              mediaId: schedule.id,
              mediaType: schedule.type,
              title: episode.title || `Episode ${episode.episode}`,
              seriesTitle: schedule.title,
              season: episode.season,
              episode: episode.episode,
              date,
              poster: schedule.poster,
              thumbnail: episode.thumbnail,
              type: 'episode',
            });
          }
        });
      }
    }

    return allEvents;
  }, [schedules]);

  const upcomingEvents = useMemo(() => {
    const today = startOfDay(new Date());
    const windowEnd = endOfDay(addDays(today, 14));
    return events
      .filter((event) => isWithinInterval(event.date, { start: today, end: windowEnd }))
      .sort((a, b) => a.date.getTime() - b.date.getTime())
      .slice(0, 8);
  }, [events]);

  const eventsByDay = useMemo(() => {
    const grouped = new Map<string, CalendarEvent[]>();
    for (const event of events) {
      const key = format(event.date, 'yyyy-MM-dd');
      const existing = grouped.get(key);
      if (existing) {
        existing.push(event);
      } else {
        grouped.set(key, [event]);
      }
    }

    grouped.forEach((list) => {
      list.sort((a, b) => {
        if (a.type !== b.type) {
          return a.type === 'episode' ? -1 : 1;
        }
        if (a.type === 'episode' && b.type === 'episode') {
          if ((a.season ?? 0) !== (b.season ?? 0)) return (a.season ?? 0) - (b.season ?? 0);
          return (a.episode ?? 0) - (b.episode ?? 0);
        }
        return a.seriesTitle.localeCompare(b.seriesTitle);
      });
    });

    return grouped;
  }, [events]);

  // 4. Calendar Grid Logic
  const days = useMemo(() => {
    const start = startOfWeek(startOfMonth(currentMonth));
    const end = endOfWeek(endOfMonth(currentMonth));
    return eachDayOfInterval({ start, end });
  }, [currentMonth]);

  const handlePrevMonth = () => setCurrentMonth((prev) => subMonths(prev, 1));
  const handleNextMonth = () => setCurrentMonth((prev) => addMonths(prev, 1));
  const handleToday = () => setCurrentMonth(new Date());
  const isCurrentMonthView = isSameMonth(currentMonth, new Date());

  if (libraryLoading) {
    return (
      <div className='min-h-screen pt-24 flex justify-center'>
        <Loader2 className='animate-spin text-white' />
      </div>
    );
  }

  return (
    <div className='min-h-screen pt-20 pb-20 px-4 md:px-8 md:pl-24 lg:pl-28 container mx-auto animate-in fade-in duration-500'>
      <div className='flex flex-col md:flex-row items-start md:items-center justify-between mb-6 gap-3'>
        <div>
          <h1 className='text-2xl font-bold text-white tracking-tight'>Release Schedule</h1>
          <p className='text-zinc-500 text-[13px] mt-0.5'>Track new episodes from your library</p>
        </div>

        <div className='flex items-center gap-1 bg-white/[0.03] p-0.5 rounded-lg border border-white/[0.06]'>
          <Button
            variant='ghost'
            size='icon'
            onClick={handlePrevMonth}
            className='h-7 w-7 hover:bg-white/[0.06] rounded-md'
          >
            <ChevronLeft className='w-3.5 h-3.5' />
          </Button>
          <div className='px-3 font-semibold text-[13px] min-w-[130px] text-center text-zinc-200'>
            {format(currentMonth, 'MMMM yyyy')}
          </div>
          <Button
            variant='ghost'
            size='icon'
            onClick={handleNextMonth}
            className='h-7 w-7 hover:bg-white/[0.06] rounded-md'
          >
            <ChevronRight className='w-3.5 h-3.5' />
          </Button>
          <Button
            variant='ghost'
            size='sm'
            onClick={handleToday}
            disabled={isCurrentMonthView}
            className={cn(
              'ml-0.5 text-[11px] font-semibold rounded-md h-7 px-2.5',
              isCurrentMonthView
                ? 'bg-white/[0.06] text-zinc-400 cursor-default'
                : 'text-zinc-400 hover:text-white hover:bg-white/[0.06]',
            )}
          >
            Today
          </Button>
        </div>
      </div>

      {schedulableItems.length === 0 && (
        <div className='mb-6 rounded-xl border border-white/[0.05] bg-white/[0.02] p-5 text-center'>
          <h2 className='text-[15px] font-semibold text-white'>Your schedule is empty</h2>
          <p className='text-[13px] text-zinc-500 mt-1'>
            Add shows to your library to track upcoming episodes.
          </p>
          <Link to='/profile' className='inline-flex'>
            <Button size='sm' className='mt-3 h-8 text-[12px]'>
              Go to Library
            </Button>
          </Link>
        </div>
      )}

      {schedulableItems.length > 0 && isScheduleLoading && (
        <div className='mb-6 flex items-center gap-2 text-xs text-zinc-400'>
          <Loader2 className='h-3.5 w-3.5 animate-spin' />
          <span>Refreshing release data from your library…</span>
        </div>
      )}

      <div className='mb-6 rounded-xl border border-white/[0.06] bg-white/[0.02] p-4 md:p-5'>
        <div className='flex items-center justify-between mb-3'>
          <div className='flex items-center gap-2.5'>
            <h2 className='text-[15px] font-semibold text-white tracking-tight'>Upcoming</h2>
            <span className='text-[11px] text-zinc-600 font-medium'>Next 14 days</span>
          </div>
        </div>
        {upcomingEvents.length === 0 ? (
          <div className='text-[13px] text-zinc-600 py-3'>
            No upcoming episodes in the next two weeks.
          </div>
        ) : (
          <div className='grid gap-2 sm:grid-cols-2 lg:grid-cols-4'>
            {upcomingEvents.map((event) => (
              <Link
                key={`${event.mediaId}-${event.id}`}
                to={`/details/${toCalendarDetailsRouteType(event.mediaType)}/${event.mediaId}`}
                state={
                  event.type === 'episode'
                    ? { from, season: event.season, episode: event.episode }
                    : { from }
                }
                className='group rounded-lg border border-white/[0.06] bg-white/[0.02] p-2.5 hover:bg-white/[0.05] hover:border-white/[0.1] transition-all duration-200'
              >
                <div className='flex items-center gap-2.5'>
                  <div className='w-8 h-12 rounded-md overflow-hidden bg-black/30 shrink-0'>
                    {event.poster && (
                      <img
                        src={event.poster}
                        alt={`${event.seriesTitle} poster`}
                        className='w-full h-full object-cover'
                      />
                    )}
                  </div>
                  <div className='min-w-0'>
                    <div className='text-[10px] text-zinc-500'>{format(event.date, 'MMM d')}</div>
                    <div className='text-[12px] font-semibold text-white truncate'>
                      {event.seriesTitle}
                    </div>
                    {event.type === 'episode' ? (
                      <div className='text-[10px] text-zinc-400'>
                        S{event.season} E{event.episode}
                      </div>
                    ) : (
                      <div className='text-[10px] text-amber-400/80 font-medium'>Movie</div>
                    )}
                  </div>
                </div>
              </Link>
            ))}
          </div>
        )}
      </div>

      <div className='bg-white/[0.02] rounded-xl border border-white/[0.06] overflow-hidden'>
        {/* Days Header */}
        <div className='grid grid-cols-7 border-b border-white/[0.05] bg-white/[0.02]'>
          {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((day) => (
            <div
              key={day}
              className='py-2.5 text-center text-[10px] font-semibold text-zinc-600 uppercase tracking-widest'
            >
              {day}
            </div>
          ))}
        </div>

        {/* Days Grid */}
        <div className='grid grid-cols-7 auto-rows-fr'>
          {days.map((day, dayIdx) => {
            const dayEvents = eventsByDay.get(format(day, 'yyyy-MM-dd')) || [];
            const isToday = isSameDay(day, new Date());
            const isCurrentMonth = isSameMonth(day, currentMonth);

            return (
              <div
                key={day.toString()}
                className={cn(
                  'min-h-[100px] p-1.5 border-b border-r border-white/[0.04] relative group transition-colors hover:bg-white/[0.02]',
                  !isCurrentMonth && 'bg-black/10 opacity-25',
                  dayIdx % 7 === 6 && 'border-r-0',
                )}
              >
                <div
                  className={cn(
                    'text-[11px] font-medium mb-1.5 w-6 h-6 flex items-center justify-center rounded-md transition-colors',
                    isToday
                      ? 'bg-white text-black font-bold'
                      : 'text-zinc-600 group-hover:text-zinc-400',
                  )}
                >
                  {format(day, 'd')}
                </div>

                <div className='space-y-1'>
                  {dayEvents.map((event) => (
                    <Popover
                      key={`${event.mediaId}-${event.id}-${event.season ?? 0}-${event.episode ?? 0}`}
                    >
                      <PopoverTrigger asChild>
                        <div className='cursor-pointer text-[9px] bg-white/[0.04] hover:bg-white/[0.07] border border-white/[0.06] hover:border-white/[0.1] rounded-md px-1.5 py-0.5 truncate transition-colors duration-150 flex items-center gap-1'>
                          {event.poster && (
                            <div className='w-2.5 h-3.5 bg-zinc-900 rounded-[2px] overflow-hidden shrink-0'>
                              <img
                                src={event.poster}
                                alt=''
                                className='w-full h-full object-cover opacity-70'
                              />
                            </div>
                          )}
                          <span className='truncate text-zinc-500 font-medium'>
                            {event.seriesTitle}
                          </span>
                        </div>
                      </PopoverTrigger>
                      <PopoverContent
                        className='w-72 p-0 bg-zinc-950/95 backdrop-blur-xl border-white/[0.08] text-white shadow-xl rounded-lg'
                        align='start'
                      >
                        <div className='flex gap-2.5 p-2.5'>
                          <div className='w-16 shrink-0 aspect-[2/3] bg-black/30 rounded-md overflow-hidden'>
                            {event.poster && (
                              <img
                                src={event.poster}
                                alt={`${event.seriesTitle} poster`}
                                className='w-full h-full object-cover'
                              />
                            )}
                          </div>
                          <div className='flex-1 min-w-0'>
                            <h4 className='font-semibold text-[13px] leading-tight mb-1'>
                              {event.seriesTitle}
                            </h4>
                            {event.type === 'episode' ? (
                              <>
                                <p className='text-[11px] text-zinc-400 font-medium mb-0.5'>
                                  S{event.season} E{event.episode}
                                </p>
                                <p className='text-[11px] text-zinc-500 line-clamp-2 mb-2'>
                                  {event.title}
                                </p>
                              </>
                            ) : (
                              <p className='text-[11px] text-amber-400/80 font-medium mb-2'>
                                Upcoming Movie
                              </p>
                            )}
                            <Link
                              to={`/details/${toCalendarDetailsRouteType(event.mediaType)}/${event.mediaId}`}
                              state={
                                event.type === 'episode'
                                  ? { from, season: event.season, episode: event.episode }
                                  : { from }
                              }
                            >
                              <Button
                                size='sm'
                                variant='secondary'
                                className='w-full h-6 text-[11px] rounded-md'
                              >
                                View Details
                              </Button>
                            </Link>
                          </div>
                        </div>
                      </PopoverContent>
                    </Popover>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
