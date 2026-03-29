import { useQuery, useQueries } from "@tanstack/react-query";
import { api, type MediaItem, type WatchStatus } from "@/lib/api";
import { format, parseISO, isSameDay, startOfMonth, endOfMonth, eachDayOfInterval, isSameMonth, addMonths, subMonths, startOfWeek, endOfWeek, addDays, startOfDay, endOfDay, isWithinInterval, isValid } from "date-fns";
import { Link, useLocation } from "react-router-dom";
import { cn } from "@/lib/utils";
import { useEffect, useEffectEvent, useState, useMemo } from "react";
import { Button } from "@/components/ui/button";
import { ChevronLeft, ChevronRight, Loader2 } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

const DETAILS_BATCH_SIZE = 12;

interface CalendarEvent {
  id: string; // episode id or movie id
  mediaId: string;
  title: string;
  seriesTitle: string;
  season?: number;
  episode?: number;
  date: Date;
  poster?: string;
  thumbnail?: string;
  type: 'movie' | 'episode';
}

function parseMovieReleaseDate(value?: string): Date | null {
  if (!value) return null;
  const normalized = value.trim();

  const explicitDateMatch = normalized.match(/\b\d{4}-\d{2}-\d{2}\b/);
  if (explicitDateMatch) {
    const parsed = parseISO(explicitDateMatch[0]);
    return isValid(parsed) ? parsed : null;
  }

  const yearMatch = normalized.match(/\b(19|20)\d{2}\b/);
  if (!yearMatch) return null;
  const yearNum = Number(yearMatch[0]);
  if (!Number.isFinite(yearNum)) return null;
  return new Date(yearNum, 0, 1);
}

export function Calendar() {
  const location = useLocation();
  const [currentMonth, setCurrentMonth] = useState(new Date());
  const [detailsBatchCount, setDetailsBatchCount] = useState(1);
  const from = `${location.pathname}${location.search}`;

  // 1. Get Library
  const { data: library, isLoading: libraryLoading } = useQuery({
    queryKey: ['library'],
    queryFn: api.getLibrary,
  });

  const { data: allWatchStatuses } = useQuery({
    queryKey: ['watch-statuses'],
    queryFn: api.getAllWatchStatuses,
    staleTime: 1000 * 60 * 5,
  });

  const { data: watchHistory } = useQuery({
    queryKey: ['watch-history'],
    queryFn: api.getWatchHistory,
    staleTime: 1000 * 60 * 3,
  });

  // 2. Get Details
  const libraryItems = useMemo(() => library ?? [], [library]);
  const watchHistoryById = useMemo(() => {
    const map = new Map<string, { id: string; type_: string; title: string; poster?: string; last_watched: number }>();
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

  const schedulableItems = useMemo(
    () => {
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
    },
    [libraryItems, allWatchStatuses, watchHistoryById]
  );

  const resetDetailsBatchCount = useEffectEvent(() => {
    setDetailsBatchCount(1);
  });

  useEffect(() => {
    resetDetailsBatchCount();
  }, [schedulableItems]);

  const detailQueryItems = useMemo(
    () => schedulableItems.slice(0, detailsBatchCount * DETAILS_BATCH_SIZE),
    [detailsBatchCount, schedulableItems],
  );

  const detailsQueries = useQueries({
    queries: detailQueryItems.map(item => ({
      queryKey: ['details', item.type, item.id],
      queryFn: () => api.getMediaDetails(item.type, item.id),
      staleTime: 1000 * 60 * 60, // 1 hour
    }))
  });

  const isCurrentBatchLoading = detailsQueries.some((query) => query.isLoading || query.isFetching);
  const hasPendingDetailBatches = detailQueryItems.length < schedulableItems.length;
  const isDetailsLoading = isCurrentBatchLoading || hasPendingDetailBatches;

  const loadNextDetailsBatch = useEffectEvent(() => {
    setDetailsBatchCount((previous) => previous + 1);
  });

  useEffect(() => {
    if (detailQueryItems.length === 0) return;
    if (isCurrentBatchLoading) return;
    if (detailQueryItems.length >= schedulableItems.length) return;

    loadNextDetailsBatch();
  }, [detailQueryItems.length, isCurrentBatchLoading, schedulableItems.length]);

  // 3. Flatten into events
  const events = useMemo(() => {
    const allEvents: CalendarEvent[] = [];
    const currentYear = new Date().getFullYear();
    
    for (const query of detailsQueries) {
      const item = query.data;
      if (!item) continue;

      if (item.type === 'movie') {
        const releaseDate = parseMovieReleaseDate(item.year);
        if (releaseDate && releaseDate.getFullYear() >= currentYear) {
          allEvents.push({
            id: item.id,
            mediaId: item.id,
            title: item.title,
            seriesTitle: item.title,
            date: releaseDate,
            poster: item.poster,
            type: 'movie'
          });
        }
      }

      if (item.type === 'series' && item.episodes) {
        item.episodes.forEach(ep => {
          if (ep.released) {
            const date = parseISO(ep.released);
            if (isValid(date)) {
              allEvents.push({
                id: ep.id,
                mediaId: item.id,
                title: ep.title || `Episode ${ep.episode}`,
                seriesTitle: item.title,
                season: ep.season,
                episode: ep.episode,
                date: date,
                poster: item.poster,
                thumbnail: ep.thumbnail,
                type: 'episode'
              });
            }
          }
        });
      }
    }

    return allEvents;
  }, [detailsQueries]);

  const upcomingEvents = useMemo(() => {
    const today = startOfDay(new Date());
    const windowEnd = endOfDay(addDays(today, 14));
    return events
      .filter(event => isWithinInterval(event.date, { start: today, end: windowEnd }))
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

  const handlePrevMonth = () => setCurrentMonth(prev => subMonths(prev, 1));
  const handleNextMonth = () => setCurrentMonth(prev => addMonths(prev, 1));
  const handleToday = () => setCurrentMonth(new Date());
  const isCurrentMonthView = isSameMonth(currentMonth, new Date());

  if (libraryLoading) {
    return <div className="min-h-screen pt-24 flex justify-center"><Loader2 className="animate-spin text-white" /></div>;
  }

  return (
    <div className="min-h-screen pt-24 pb-20 px-4 md:px-8 container mx-auto animate-in fade-in duration-500">
      <div className="flex flex-col md:flex-row items-center justify-between mb-8 gap-4">
        <div>
          <h1 className="text-4xl font-black text-white tracking-tighter drop-shadow-lg">Release Schedule</h1>
          <p className="text-zinc-400 text-base mt-1 font-light">Track new episodes from your library</p>
        </div>

        <div className="flex items-center gap-2 bg-white/[0.04] p-1.5 rounded-xl border border-white/[0.08] backdrop-blur-md shadow-lg">
          <Button variant="ghost" size="icon" onClick={handlePrevMonth} className="hover:bg-white/10 rounded-lg">
            <ChevronLeft className="w-4 h-4" />
          </Button>
          <div className="px-4 font-bold text-sm min-w-[140px] text-center">
            {format(currentMonth, 'MMMM yyyy')}
          </div>
          <Button variant="ghost" size="icon" onClick={handleNextMonth} className="hover:bg-white/10 rounded-lg">
            <ChevronRight className="w-4 h-4" />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={handleToday}
            disabled={isCurrentMonthView}
            className={cn(
              "ml-2 text-xs font-bold rounded-lg",
              isCurrentMonthView
                ? "bg-white/10 text-white border border-white/15 cursor-default"
                : "bg-white/5 hover:bg-white/10"
            )}
          >
            Today
          </Button>
        </div>
      </div>

      {schedulableItems.length === 0 && (
        <div className="mb-8 rounded-2xl border border-white/5 bg-zinc-900/40 p-6 text-center">
          <h2 className="text-lg font-semibold text-white">Your schedule is empty</h2>
          <p className="text-sm text-zinc-400 mt-1">Add shows to your library to track upcoming episodes.</p>
          <Link to="/profile" className="inline-flex">
            <Button size="sm" className="mt-4">Go to Library</Button>
          </Link>
        </div>
      )}

      {schedulableItems.length > 0 && isDetailsLoading && (
        <div className="mb-6 flex items-center gap-2 text-xs text-zinc-400">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          <span>Refreshing release data from your library…</span>
        </div>
      )}

      <div className="mb-8 rounded-3xl border border-white/[0.08] bg-white/[0.03] backdrop-blur-sm p-4 md:p-6 shadow-xl">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h2 className="text-xl font-bold text-white tracking-tight">Upcoming</h2>
            <p className="text-xs text-zinc-400 font-medium uppercase tracking-wider mt-0.5">Next 14 days</p>
          </div>
        </div>
        {upcomingEvents.length === 0 ? (
          <div className="text-sm text-zinc-500 py-4">No upcoming episodes in the next two weeks.</div>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {upcomingEvents.map(event => (
              <Link
                key={`${event.mediaId}-${event.id}`}
                to={`/details/${event.type === 'movie' ? 'movie' : 'series'}/${event.mediaId}`}
                state={event.type === 'episode' ? { from, season: event.season, episode: event.episode } : { from }}
                className="group rounded-xl border border-white/[0.08] bg-white/[0.04] p-3 hover:bg-white/[0.08] hover:border-white/[0.14] transition-all duration-300 hover:scale-[1.02] shadow-sm hover:shadow-lg"
              >
                <div className="flex items-center gap-3">
                  <div className="w-10 h-14 rounded-md overflow-hidden bg-black/40 shrink-0">
                    {event.poster && <img src={event.poster} className="w-full h-full object-cover" />}
                  </div>
                  <div className="min-w-0">
                    <div className="text-xs text-zinc-400">{format(event.date, 'MMM d')}</div>
                    <div className="text-sm font-semibold text-white truncate">{event.seriesTitle}</div>
                    {event.type === 'episode' ? (
                      <>
                        <div className="text-xs text-primary">S{event.season} E{event.episode}</div>
                        <div className="text-xs text-zinc-500 truncate">{event.title}</div>
                      </>
                    ) : (
                      <div className="text-xs text-amber-400 font-medium">Movie</div>
                    )}
                  </div>
                </div>
              </Link>
            ))}
          </div>
        )}
      </div>

      {/* Calendar Grid */}
      <div className="bg-white/[0.03] backdrop-blur-md rounded-3xl border border-white/[0.08] overflow-hidden shadow-2xl">
          {/* Days Header */}
          <div className="grid grid-cols-7 border-b border-white/[0.07] bg-white/[0.04]">
              {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map(day => (
                  <div key={day} className="py-4 text-center text-[10px] font-bold text-zinc-500 uppercase tracking-widest">
                      {day}
                  </div>
              ))}
          </div>
          
          {/* Days Grid */}
          <div className="grid grid-cols-7 auto-rows-fr">
              {days.map((day, dayIdx) => {
                  const dayEvents = eventsByDay.get(format(day, 'yyyy-MM-dd')) || [];
                  const isToday = isSameDay(day, new Date());
                  const isCurrentMonth = isSameMonth(day, currentMonth);

                  return (
                      <div 
                          key={day.toString()} 
                          className={cn(
                              "min-h-[120px] p-2 border-b border-r border-white/5 relative group transition-colors hover:bg-white/[0.03]",
                              !isCurrentMonth && "bg-black/20 opacity-30",
                              dayIdx % 7 === 6 && "border-r-0" // Remove right border for last column
                          )}
                      >
                          <div className={cn(
                              "text-xs font-medium mb-2 w-7 h-7 flex items-center justify-center rounded-full transition-all duration-300",
                              isToday ? "bg-primary text-primary-foreground font-bold shadow-[0_0_15px_rgba(var(--primary),0.5)] scale-110" : "text-zinc-500 group-hover:text-zinc-300"
                          )}>
                              {format(day, 'd')}
                          </div>

                          <div className="space-y-1.5">
                                {dayEvents.map(event => (
                                  <Popover key={`${event.mediaId}-${event.id}-${event.season ?? 0}-${event.episode ?? 0}`}>
                                      <PopoverTrigger asChild>
                                          <div className="cursor-pointer text-[10px] bg-white/[0.06] hover:bg-white/[0.1] border border-white/[0.08] hover:border-white/[0.15] rounded-md px-1.5 py-1 truncate transition-all duration-200 flex items-center gap-1.5 hover:shadow-md">
                                              {event.poster && (
                                                  <div className="w-3 h-4 bg-zinc-900 rounded-[2px] overflow-hidden shrink-0">
                                                      <img src={event.poster} className="w-full h-full object-cover opacity-80" />
                                                  </div>
                                              )}
                                              <span className="truncate text-zinc-400 group-hover:text-zinc-200 font-medium">{event.seriesTitle}</span>
                                          </div>
                                      </PopoverTrigger>
                                      <PopoverContent className="w-80 p-0 bg-zinc-950/90 backdrop-blur-xl border-white/10 text-white shadow-2xl" align="start">
                                          <div className="flex gap-3 p-3">
                                              <div className="w-20 shrink-0 aspect-[2/3] bg-black/50 rounded-md overflow-hidden shadow-inner">
                                                  {event.poster && <img src={event.poster} className="w-full h-full object-cover" />}
                                              </div>
                                              <div className="flex-1 min-w-0">
                                                  <h4 className="font-bold text-sm leading-tight mb-1">{event.seriesTitle}</h4>
                                                  {event.type === 'episode' ? (
                                                    <>
                                                      <p className="text-xs text-primary font-medium mb-1">S{event.season} E{event.episode}</p>
                                                      <p className="text-xs text-zinc-400 line-clamp-2 mb-2">{event.title}</p>
                                                    </>
                                                  ) : (
                                                    <p className="text-xs text-amber-400 font-medium mb-2">Upcoming Movie</p>
                                                  )}
                                                  <Link 
                                                      to={`/details/${event.type === 'movie' ? 'movie' : 'series'}/${event.mediaId}`} 
                                                      state={event.type === 'episode' ? { from, season: event.season, episode: event.episode } : { from }}
                                                  >
                                                      <Button size="sm" variant="secondary" className="w-full h-7 text-xs">View Details</Button>
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
