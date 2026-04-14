import { ChevronLeft, ChevronRight } from 'lucide-react';
import {
  type CSSProperties,
  type Key,
  type ReactNode,
  useCallback,
  useEffect,
  useEffectEvent,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { MediaCardSkeleton } from './media-card';

export const HORIZONTAL_MEDIA_RAIL_CONTENT_INSETS =
  'px-6 pl-[72px] md:px-12 md:pl-24 lg:px-14 lg:pl-28';

const SCROLL_BUTTON_CLASS_NAME =
  'h-7 w-7 rounded-lg bg-white/[0.06] border border-white/[0.1] text-zinc-400 hover:bg-white/[0.12] hover:text-white transition-all duration-200 backdrop-blur-sm';
const DEFAULT_ITEM_CLASS_NAME = 'flex-none w-[140px] md:w-[170px] snap-start';
const DEFAULT_SCROLLER_CLASS_NAME =
  'flex overflow-x-auto gap-3 pb-8 scrollbar-hide snap-x snap-mandatory';
const SCROLL_BOUNDARY_EPSILON = 4;

interface RailScrollState {
  canScrollLeft: boolean;
  canScrollRight: boolean;
  hasOverflow: boolean;
}

const INITIAL_RAIL_SCROLL_STATE: RailScrollState = {
  canScrollLeft: false,
  canScrollRight: false,
  hasOverflow: false,
};

interface HorizontalMediaRailProps<T> {
  contentInsetsClassName?: string;
  emptyState?: ReactNode;
  getItemKey: (item: T, index: number) => Key;
  headerContent?: ReactNode;
  isLoading: boolean;
  items: readonly T[];
  itemClassName?: string;
  renderItem: (item: T, index: number) => ReactNode;
  renderSkeleton?: (index: number) => ReactNode;
  scrollerClassName?: string;
  sectionClassName?: string;
  skeletonCount?: number;
  style?: CSSProperties;
  title: ReactNode;
  viewportClassName?: string;
}

export function HorizontalMediaRail<T>({
  contentInsetsClassName = HORIZONTAL_MEDIA_RAIL_CONTENT_INSETS,
  emptyState,
  getItemKey,
  headerContent,
  isLoading,
  items,
  itemClassName = DEFAULT_ITEM_CLASS_NAME,
  renderItem,
  renderSkeleton,
  scrollerClassName,
  sectionClassName,
  skeletonCount = 8,
  style,
  title,
  viewportClassName,
}: HorizontalMediaRailProps<T>) {
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const [scrollState, setScrollState] = useState(INITIAL_RAIL_SCROLL_STATE);
  const skeletonKeys = useMemo(
    () => Array.from({ length: skeletonCount }, (_, index) => `rail-skeleton-${index + 1}`),
    [skeletonCount],
  );

  const syncScrollState = useCallback(() => {
    const scrollContainer = scrollContainerRef.current;

    if (!scrollContainer) {
      setScrollState((previousState) =>
        previousState.hasOverflow || previousState.canScrollLeft || previousState.canScrollRight
          ? INITIAL_RAIL_SCROLL_STATE
          : previousState,
      );
      return;
    }

    const maxScrollLeft = Math.max(0, scrollContainer.scrollWidth - scrollContainer.clientWidth);
    const hasOverflow = maxScrollLeft > SCROLL_BOUNDARY_EPSILON;
    const nextState: RailScrollState = {
      hasOverflow,
      canScrollLeft: hasOverflow && scrollContainer.scrollLeft > SCROLL_BOUNDARY_EPSILON,
      canScrollRight:
        hasOverflow && scrollContainer.scrollLeft < maxScrollLeft - SCROLL_BOUNDARY_EPSILON,
    };

    setScrollState((previousState) =>
      previousState.hasOverflow === nextState.hasOverflow &&
      previousState.canScrollLeft === nextState.canScrollLeft &&
      previousState.canScrollRight === nextState.canScrollRight
        ? previousState
        : nextState,
    );
  }, []);

  useEffect(() => {
    const scrollContainer = scrollContainerRef.current;
    if (!scrollContainer) {
      return;
    }

    const initialSyncFrame = window.requestAnimationFrame(() => {
      syncScrollState();
    });

    const handleScroll = () => {
      syncScrollState();
    };

    const resizeObserver =
      typeof ResizeObserver === 'undefined'
        ? null
        : new ResizeObserver(() => {
            syncScrollState();
          });

    scrollContainer.addEventListener('scroll', handleScroll, { passive: true });
    window.addEventListener('resize', syncScrollState);
    resizeObserver?.observe(scrollContainer);

    return () => {
      window.cancelAnimationFrame(initialSyncFrame);
      scrollContainer.removeEventListener('scroll', handleScroll);
      window.removeEventListener('resize', syncScrollState);
      resizeObserver?.disconnect();
    };
  }, [syncScrollState]);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      syncScrollState();
    });

    return () => {
      window.cancelAnimationFrame(frame);
    };
  }, [syncScrollState]);

  const syncScrollStateAfterContentChange = useEffectEvent(
    (_isLoading: boolean, _itemCount: number) => {
      syncScrollState();
    },
  );

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      syncScrollStateAfterContentChange(isLoading, items.length);
    });

    return () => {
      window.cancelAnimationFrame(frame);
    };
  }, [isLoading, items.length]);

  const scroll = (direction: 'left' | 'right') => {
    if (!scrollContainerRef.current) {
      return;
    }

    const { current } = scrollContainerRef;
    const delta = direction === 'left' ? -current.offsetWidth * 0.8 : current.offsetWidth * 0.8;
    current.scrollBy({ left: delta, behavior: 'smooth' });
  };

  if (!isLoading && items.length === 0 && emptyState) {
    return <>{emptyState}</>;
  }

  return (
    <section className={cn('py-4 relative group/section', sectionClassName)} style={style}>
      <div className={cn(contentInsetsClassName, 'mb-2')}>
        <div className='flex items-center justify-between mb-2'>
          <h2 className='text-base font-semibold text-white tracking-tight'>{title}</h2>

          {scrollState.hasOverflow && (
            <div className='flex items-center gap-1.5 opacity-0 group-hover/section:opacity-100 transition-opacity duration-300'>
              <Button
                aria-label='Scroll rail left'
                size='icon'
                variant='ghost'
                className={SCROLL_BUTTON_CLASS_NAME}
                disabled={!scrollState.canScrollLeft}
                onClick={() => scroll('left')}
              >
                <ChevronLeft className='h-4 w-4' />
              </Button>
              <Button
                aria-label='Scroll rail right'
                size='icon'
                variant='ghost'
                className={SCROLL_BUTTON_CLASS_NAME}
                disabled={!scrollState.canScrollRight}
                onClick={() => scroll('right')}
              >
                <ChevronRight className='h-4 w-4' />
              </Button>
            </div>
          )}
        </div>

        {headerContent}
      </div>

      <div className={cn(contentInsetsClassName, 'overflow-hidden', viewportClassName)}>
        <div
          ref={scrollContainerRef}
          className={cn(DEFAULT_SCROLLER_CLASS_NAME, scrollerClassName)}
          style={{ scrollbarWidth: 'none', msOverflowStyle: 'none' }}
        >
          {isLoading
            ? skeletonKeys.map((skeletonKey, index) => (
                <div key={skeletonKey} className={itemClassName}>
                  {renderSkeleton?.(index) ?? <MediaCardSkeleton />}
                </div>
              ))
            : items.map((item, index) => (
                <div key={getItemKey(item, index)} className={itemClassName}>
                  {renderItem(item, index)}
                </div>
              ))}
        </div>
      </div>
    </section>
  );
}
