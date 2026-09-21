import type { SearchHit, SearchResponse } from '../../../shared/types';

export function hitKey(hit: SearchHit): string {
  return `${hit.message.conversationId}:${hit.message.ts}`;
}

/**
 * Hits across offset pages. A sync finishing between two pages can shift offsets and repeat a
 * hit at a page boundary; the first occurrence wins.
 */
export function collectHits(pages: readonly SearchResponse[] | undefined): SearchHit[] {
  const seen = new Set<string>();
  const out: SearchHit[] = [];
  for (const page of pages ?? []) {
    for (const hit of page.hits) {
      const key = hitKey(hit);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(hit);
    }
  }
  return out;
}

export interface HitGroup {
  conversationId: string;
  hits: SearchHit[];
}

/** Groups by conversation, ordered by each conversation's first (best-ranked) hit. */
export function groupHitsByConversation(hits: readonly SearchHit[]): HitGroup[] {
  const groups = new Map<string, HitGroup>();
  for (const hit of hits) {
    const id = hit.message.conversationId;
    let group = groups.get(id);
    if (!group) {
      group = { conversationId: id, hits: [] };
      groups.set(id, group);
    }
    group.hits.push(hit);
  }
  return [...groups.values()];
}
