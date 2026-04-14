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

const DEFAULT_GRID_GAP_PX = 16;
const DEFAULT_FALLBACK_ITEM_WIDTH_PX = 160;
const DEFAULT_OVERSCAN_ROWS = 4;
const DEFAULT_VIRTUALIZATION_THRESHOLD = 24;

function getDefaultWindowGridColumnCount(viewportWidth: number) {
  if (viewportWidth >= 1280) {
    return 6;
  }
  if (viewportWidth >= 1024) {
    return 5;
  }
  if (viewportWidth >= 768) {
    return 4;
  }
  if (viewportWidth >= 640) {
    return 3;
  }

  return 2;
}

interface WindowVirtualizedGridProps<T> {
  items: readonly T[];
  getItemKey: (item: T, index: number) => string;
  renderItem: (item: T, index: number) => ReactNode;
  estimateItemHeight: (itemWidth: number) => number;
  getColumnCount?: (viewportWidth: number) => number;
  overscan?: number;
  gap?: number;
  virtualizationThreshold?: number;
  fallbackItemWidth?: number;
}

export function WindowVirtualizedGrid<T>({
  items,
  getItemKey,
  renderItem,
  estimateItemHeight,
  getColumnCount = getDefaultWindowGridColumnCount,
  overscan = DEFAULT_OVERSCAN_ROWS,
  gap = DEFAULT_GRID_GAP_PX,
  virtualizationThreshold = DEFAULT_VIRTUALIZATION_THRESHOLD,
  fallbackItemWidth = DEFAULT_FALLBACK_ITEM_WIDTH_PX,
}: WindowVirtualizedGridProps<T>) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [scrollMargin, setScrollMargin] = useState(0);
  const [metrics, setMetrics] = useState(() => ({
    columnCount: getColumnCount(typeof window === 'undefined' ? 1280 : window.innerWidth),
    containerWidth: 0,
  }));
  const shouldVirtualize = items.length >= virtualizationThreshold;

  const updateMetrics = useCallback(() => {
    const nextColumnCount = Math.max(1, getColumnCount(window.innerWidth));
    const nextContainerWidth = containerRef.current?.clientWidth ?? 0;

    setMetrics((currentMetrics) =>
      currentMetrics.columnCount === nextColumnCount &&
      currentMetrics.containerWidth === nextContainerWidth
        ? currentMetrics
        : {
            columnCount: nextColumnCount,
            containerWidth: nextContainerWidth,
          },
    );
  }, [getColumnCount]);

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
    updateMetrics();
    updateScrollMargin();
  }, [updateMetrics, updateScrollMargin]);

  useEffect(() => {
    const handleResize = () => {
      updateMetrics();
      updateScrollMargin();
    };

    const container = containerRef.current;
    const resizeObserver =
      typeof ResizeObserver === 'undefined'
        ? null
        : new ResizeObserver(() => {
            handleResize();
          });

    if (container) {
      resizeObserver?.observe(container);
    }

    window.addEventListener('resize', handleResize, { passive: true });

    return () => {
      resizeObserver?.disconnect();
      window.removeEventListener('resize', handleResize);
    };
  }, [updateMetrics, updateScrollMargin]);

  const columnCount = metrics.columnCount;
  const rowCount = Math.ceil(items.length / columnCount);
  const estimatedItemWidth =
    metrics.containerWidth > 0
      ? (metrics.containerWidth - gap * (columnCount - 1)) / columnCount
      : fallbackItemWidth;
  const estimatedRowHeight = estimateItemHeight(estimatedItemWidth) + gap;

  // eslint-disable-next-line react-hooks/incompatible-library
  const rowVirtualizer = useWindowVirtualizer({
    count: rowCount,
    enabled: shouldVirtualize,
    estimateSize: () => estimatedRowHeight,
    overscan,
    scrollMargin,
    getItemKey: (index) => `row-${index}`,
  });

  const gridTemplateColumns = `repeat(${columnCount}, minmax(0, 1fr))`;

  if (!shouldVirtualize) {
    return (
      <div
        ref={containerRef}
        style={{
          display: 'grid',
          gap: `${gap}px`,
          gridTemplateColumns,
        }}
      >
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
        const rowStartIndex = virtualRow.index * columnCount;
        const rowItems = items.slice(rowStartIndex, rowStartIndex + columnCount);

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
              display: 'grid',
              gap: `${gap}px`,
              gridTemplateColumns,
              transform: `translateY(${virtualRow.start - scrollMargin}px)`,
              paddingBottom: `${gap}px`,
            }}
          >
            {rowItems.map((item, itemOffset) => {
              const itemIndex = rowStartIndex + itemOffset;
              return (
                <Fragment key={getItemKey(item, itemIndex)}>{renderItem(item, itemIndex)}</Fragment>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}
