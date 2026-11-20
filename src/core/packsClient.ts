import { selectDeterministicDailyCards } from "./mastery.ts";
import type { ContentShardItem, DailyManifest, PackCatalog } from "./types.ts";

let catalogCache: PackCatalog | null = null;
const shardCache = new Map<string, ContentShardItem[]>();

export async function loadPackCatalog(): Promise<PackCatalog> {
  if (catalogCache) return catalogCache;
  let res: Response;
  try {
    res = await fetch("/packs/catalog.json");
  } catch {
    throw new Error("Offline or unreadable pack data");
  }
  if (!res.ok) {
    throw new Error(`Could not load content catalog (${res.status})`);
  }
  let parsed: unknown;
  try {
    parsed = await res.json();
  } catch {
    throw new Error("Offline or unreadable pack data");
  }
  const catalog = parsed as Partial<PackCatalog> | null;
  if (!catalog || !Array.isArray(catalog.tracks) || !Array.isArray(catalog.shards)) {
    throw new Error("Offline or unreadable pack data");
  }
  catalogCache = catalog as PackCatalog;
  return catalogCache;
}

export async function loadShardItems(shardUrl: string): Promise<ContentShardItem[]> {
  const cached = shardCache.get(shardUrl);
  if (cached) return cached;
  let res: Response;
  try {
    res = await fetch(shardUrl);
  } catch {
    throw new Error("Offline or unreadable pack data");
  }
  if (!res.ok) {
    throw new Error(`Could not load pack shard ${shardUrl} (${res.status})`);
  }
  let parsed: unknown;
  try {
    parsed = await res.json();
  } catch {
    throw new Error("Offline or unreadable pack data");
  }
  const data = parsed as { items?: unknown } | null;
  if (!data || !Array.isArray(data.items)) {
    throw new Error("Offline or unreadable pack data");
  }
  const items = data.items as ContentShardItem[];
  shardCache.set(shardUrl, items);
  return items;
}

export async function loadSubtrackItems(subtrackId: string): Promise<ContentShardItem[]> {
  const catalog = await loadPackCatalog();
  const track = catalog.tracks.find((t) => t.subtrack_id === subtrackId);
  if (!track) {
    throw new Error(`Track ${subtrackId} not found in catalog`);
  }
  const lists = await Promise.all(track.shards.map((url) => loadShardItems(url)));
  return lists.flat();
}

/**
 * Loads the 5-card Solo Daily ritual purely from Cloudflare Pages static JSON
 * (0 Worker / DO / D1 requests per DEC-006), with deterministic fallback if
 * offline or past the pre-generated static manifest window.
 */
export async function loadDailyRound(
  subtrackId: string,
  utcDateIso: string,
  hiddenIds: Set<string>
): Promise<ContentShardItem[]> {
  try {
    const manifestRes = await fetch(`/data/daily/${encodeURIComponent(subtrackId)}/${utcDateIso}.json`);
    if (manifestRes.ok) {
      const manifest = (await manifestRes.json()) as DailyManifest;
      const shardLists = await Promise.all(manifest.shard_urls.map((u) => loadShardItems(u)));
      const byId = new Map<string, ContentShardItem>();
      for (const item of shardLists.flat()) byId.set(item.item_id, item);
      const picks = manifest.item_ids
        .map((id) => byId.get(id))
        .filter((it): it is ContentShardItem => Boolean(it && !hiddenIds.has(it.item_id)));
      if (picks.length === 5) return picks;
    }
  } catch {
    // Offline or static manifest missing for far-future date -> fall back deterministically
  }

  const all = await loadSubtrackItems(subtrackId);
  return selectDeterministicDailyCards(all, utcDateIso, subtrackId, hiddenIds);
}
