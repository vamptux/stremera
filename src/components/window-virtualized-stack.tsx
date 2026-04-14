import { useWindowVirtualizer } from '@tanstack/react-virtual';
import {
  Fragment,
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';

const DEFAULT_STACK_GAP_PX = 6;
const DEFAULT_VIRTUALIZATION_THRESHOLD = 40;

interface WindowVirtualizedStackProps<T> {
  items: readonly T[];
  getItemKey: (item: T, index: number) => string;
  renderItem: (item: T, index: number) => ReactNode;
  estimateSize: (index: number) => number;
  overscan?: number;
  gap?: number;
  virtualizationThreshold?: number;
}

export function WindowVirtualizedStack<T>({
  items,
  getItemKey,
  renderItem,
  estimateSize,
  overscan = 6,
  gap = DEFAULT_STACK_GAP_PX,
  virtualizationThreshold = DEFAULT_VIRTUALIZATION_THRESHOLD,
}: WindowVirtualizedStackProps<T>) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [scrollMargin, setScrollMargin] = useState(0);
  const shouldVirtualize = items.length >= virtualizationThreshold;

  const updateScrollMargin = useCallback(() => {
    if (!shouldVirtualize || !containerRef.current) {
      return;
    }

    const nextScrollMargin = containerRef.current.getBoundingClientRect().top + window.scrollY;
    setScrollMargin((currentScrollMargin) =>
      Math.abs(currentScrollMargin - nextScrollMargin) < 1 ? currentScrollMargin : nextScrollMargin,
    );
  }, [shouldVirtualize]);

  useLayoutEffect(() => {
    updateScrollMargin();
  }, [updateScrollMargin]);

  useEffect(() => {
    if (!shouldVirtualize) {
      return;
    }

    const handleResize = () => {
      updateScrollMargin();
    };

    window.addEventListener('resize', handleResize);

    const resizeObserver =
      typeof ResizeObserver === 'undefined' || !containerRef.current
        ? null
        : new ResizeObserver(() => {
            updateScrollMargin();
          });

    if (resizeObserver && containerRef.current) {
      resizeObserver.observe(containerRef.current);
    }

    return () => {
      window.removeEventListener('resize', handleResize);
      resizeObserver?.disconnect();
    };
  }, [shouldVirtualize, updateScrollMargin]);

  // eslint-disable-next-line react-hooks/incompatible-library
  const rowVirtualizer = useWindowVirtualizer({
    count: items.length,
    enabled: shouldVirtualize,
    estimateSize,
    gap,
    overscan,
    scrollMargin,
    getItemKey: (index) => getItemKey(items[index] as T, index),
  });

  if (!shouldVirtualize) {
    return (
      <div ref={containerRef} style={{ display: 'grid', gap: `${gap}px` }}>
        {items.map((item, index) => (
          <Fragment key={getItemKey(item, index)}>{renderItem(item, index)}</Fragment>
        ))}
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      className='relative w-full'
      style={{ height: `${rowVirtualizer.getTotalSize()}px` }}
    >
      {rowVirtualizer.getVirtualItems().map((virtualRow) => {
        const item = items[virtualRow.index];
        if (!item) {
          return null;
        }

        return (
          <div
            key={virtualRow.key}
            data-index={virtualRow.index}
            ref={rowVirtualizer.measureElement}
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              width: '100%',
              transform: `translateY(${virtualRow.start - scrollMargin}px)`,
            }}
          >
            {renderItem(item, virtualRow.index)}
          </div>
        );
      })}
    </div>
  );
}
