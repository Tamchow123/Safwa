"use client";

import { useWindowVirtualizer } from "@tanstack/react-virtual";
import { useLayoutEffect, useRef, useState } from "react";

import { VocabularyEntryCard } from "@/components/library/vocabulary-entry-card";
import type { LearnerEntry } from "@/modules/content/schema";

/**
 * Window-virtualised result list: only visible/overscanned rows render,
 * heights are measured (cards wrap on narrow screens), and the list flows
 * in the normal page scroll so the mobile shell keeps working.
 */
export function VirtualisedEntryList({ entries }: { entries: LearnerEntry[] }) {
  const listRef = useRef<HTMLDivElement>(null);
  const [scrollMargin, setScrollMargin] = useState(0);

  useLayoutEffect(() => {
    setScrollMargin(listRef.current?.offsetTop ?? 0);
  }, []);

  const virtualizer = useWindowVirtualizer({
    count: entries.length,
    estimateSize: () => 150,
    overscan: 8,
    scrollMargin,
    getItemKey: (index) => entries[index].id,
  });

  return (
    <div
      ref={listRef}
      role="list"
      aria-label="Vocabulary entries"
      data-testid="entry-list"
    >
      <div
        style={{
          height: virtualizer.getTotalSize(),
          position: "relative",
          width: "100%",
        }}
      >
        {virtualizer.getVirtualItems().map((item) => (
          <div
            key={item.key}
            role="listitem"
            data-index={item.index}
            ref={virtualizer.measureElement}
            className="pb-3"
            style={{
              position: "absolute",
              top: 0,
              left: 0,
              width: "100%",
              transform: `translateY(${item.start - scrollMargin}px)`,
            }}
          >
            <VocabularyEntryCard entry={entries[item.index]} />
          </div>
        ))}
      </div>
    </div>
  );
}
