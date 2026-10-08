import { test } from "node:test";
import assert from "node:assert/strict";
import type { Feed, FeedItem } from "./feed.js";
import {
  dedupeFeed,
  entryKey,
  parseTmdbId,
  partitionNewTitles,
  type FeedEntry,
} from "./seerr.js";

function item(partial: Partial<FeedItem>): FeedItem {
  return {
    rank: 1,
    showType: "movie",
    title: "Untitled",
    year: 2025,
    rating: 50,
    genres: [],
    cast: [],
    overview: "",
    imdbId: undefined,
    tmdbId: undefined,
    ...partial,
  };
}

function feedWith(services: Feed["services"]): Feed {
  return { country: "us", generatedAt: "2026-01-01T00:00:00.000Z", services };
}

test("parseTmdbId strips the type prefix and returns a number", () => {
  assert.equal(parseTmdbId("movie/603"), 603);
  assert.equal(parseTmdbId("tv/1396"), 1396);
  assert.equal(parseTmdbId("12345"), 12345);
  assert.equal(parseTmdbId(undefined), undefined);
  assert.equal(parseTmdbId("movie/"), undefined);
  assert.equal(parseTmdbId("movie/abc"), undefined);
});

test("dedupeFeed collapses the same title appearing on multiple services", () => {
  const feed = feedWith([
    {
      service: "netflix",
      label: "Netflix",
      movies: [item({ title: "Dune", tmdbId: "movie/438631", rank: 2 })],
      series: [],
    },
    {
      service: "prime",
      label: "Amazon Prime Video",
      movies: [item({ title: "Dune", tmdbId: "movie/438631", rank: 5 })],
      series: [],
    },
  ]);

  const entries = dedupeFeed(feed);
  assert.equal(entries.length, 1, "duplicate title should collapse to one entry");
  assert.deepEqual(entries[0].services.sort(), ["netflix", "prime"]);
  assert.equal(entries[0].bestRank, 2, "should keep the best (lowest) rank");
  assert.equal(entries[0].tmdbId, 438631);
  assert.equal(entries[0].mediaType, "movie");
});

test("dedupeFeed keeps movie and series with same numeric id separate", () => {
  const feed = feedWith([
    {
      service: "hbo",
      label: "HBO Max (Max)",
      movies: [item({ title: "Thing", showType: "movie", tmdbId: "movie/100" })],
      series: [item({ title: "Thing", showType: "series", tmdbId: "tv/100" })],
    },
  ]);
  const entries = dedupeFeed(feed);
  assert.equal(entries.length, 2);
});

test("dedupeFeed falls back to imdbId then title when tmdbId missing", () => {
  const feed = feedWith([
    {
      service: "apple",
      label: "Apple TV",
      movies: [
        item({ title: "A", imdbId: "tt1", rank: 3 }),
        item({ title: "A", imdbId: "tt1", rank: 1 }),
      ],
      series: [],
    },
  ]);
  const entries = dedupeFeed(feed);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].bestRank, 1);
});

test("partitionNewTitles never puts existing titles into toRequest", async () => {
  const entries: FeedEntry[] = [
    { mediaType: "movie", tmdbId: 1, title: "New", genres: [], services: ["netflix"], bestRank: 1 },
    { mediaType: "movie", tmdbId: 2, title: "Exists", genres: [], services: ["netflix"], bestRank: 2 },
    { mediaType: "tv", tmdbId: 3, title: "AlsoNew", genres: [], services: ["hbo"], bestRank: 3 },
  ];

  const existingIds = new Set([2]);
  const exists = (e: FeedEntry) => e.tmdbId !== undefined && existingIds.has(e.tmdbId);

  const { toRequest, skippedExisting } = await partitionNewTitles(entries, exists);

  assert.deepEqual(toRequest.map((e) => e.tmdbId), [1, 3]);
  assert.deepEqual(skippedExisting.map((e) => e.tmdbId), [2]);
  // Hard guarantee: nothing flagged existing leaks into toRequest.
  assert.ok(toRequest.every((e) => !existingIds.has(e.tmdbId!)));
});

test("partitionNewTitles supports async exists checks", async () => {
  const entries: FeedEntry[] = [
    { mediaType: "movie", tmdbId: 10, title: "X", genres: [], services: ["prime"], bestRank: 1 },
  ];
  const exists = async (_e: FeedEntry) => {
    await Promise.resolve();
    return true;
  };
  const { toRequest, skippedExisting } = await partitionNewTitles(entries, exists);
  assert.equal(toRequest.length, 0);
  assert.equal(skippedExisting.length, 1);
});

test("partitionNewTitles skips entries without tmdbId by default (cannot verify)", async () => {
  const entries: FeedEntry[] = [
    { mediaType: "movie", tmdbId: undefined, imdbId: "tt9", title: "NoTmdb", genres: [], services: ["netflix"], bestRank: 1 },
  ];
  const exists = () => false; // even though "exists" says new...
  const { toRequest, skippedExisting } = await partitionNewTitles(entries, exists);
  assert.equal(toRequest.length, 0, "no tmdbId -> cannot verify -> must not request");
  assert.equal(skippedExisting.length, 1);
});

test("entryKey builds stable mediaType:tmdbId keys for selection", () => {
  assert.equal(entryKey({ mediaType: "movie", tmdbId: 603 }), "movie:603");
  assert.equal(entryKey({ mediaType: "tv", tmdbId: 1396 }), "tv:1396");
});

test("a selection set filters a plan to the chosen subset (manual request flow)", () => {
  const plan: FeedEntry[] = [
    { mediaType: "movie", tmdbId: 1, title: "Keep", genres: [], services: ["netflix"], bestRank: 1 },
    { mediaType: "tv", tmdbId: 2, title: "Drop", genres: [], services: ["hbo"], bestRank: 2 },
    { mediaType: "movie", tmdbId: 3, title: "Keep2", genres: [], services: ["prime"], bestRank: 3 },
  ];
  // User unticked "Drop"; only these keys remain selected.
  const only = new Set(["movie:1", "movie:3"]);
  const selected = plan.filter((e) => only.has(entryKey(e)));
  assert.deepEqual(selected.map((e) => e.title), ["Keep", "Keep2"]);
});

test("selection semantics: absent means all, empty array means none (safety)", () => {
  const plan: FeedEntry[] = [
    { mediaType: "movie", tmdbId: 1, title: "A", genres: [], services: ["netflix"], bestRank: 1 },
    { mediaType: "tv", tmdbId: 2, title: "B", genres: [], services: ["hbo"], bestRank: 2 },
  ];
  // This mirrors runSync: onlySet = Array.isArray(only) ? Set(only) : undefined.
  const resolve = (only?: string[]) => {
    const onlySet = Array.isArray(only) ? new Set(only) : undefined;
    return onlySet ? plan.filter((e) => onlySet.has(entryKey(e))) : plan;
  };
  assert.equal(resolve(undefined).length, 2, "absent -> request all");
  assert.equal(resolve([]).length, 0, "empty array -> request NONE");
  assert.deepEqual(resolve(["tv:2"]).map((e) => e.title), ["B"]);
});

test("season resolution: TV defaults to [1], honors overrides; movies are 'all'", () => {
  // Mirrors runSync: seasons = tv ? (seasonsByKey[key] ?? [1]) : "all".
  const resolveSeasons = (
    e: Pick<FeedEntry, "mediaType" | "tmdbId">,
    seasonsByKey: Record<string, "all" | number[]> = {},
  ): "all" | number[] =>
    e.mediaType === "tv" ? seasonsByKey[entryKey(e)] ?? [1] : "all";

  const movie = { mediaType: "movie" as const, tmdbId: 5 };
  const tv = { mediaType: "tv" as const, tmdbId: 9 };

  assert.equal(resolveSeasons(movie), "all", "movies request all (ignored by Seerr)");
  assert.deepEqual(resolveSeasons(tv), [1], "TV defaults to season 1 only");
  assert.deepEqual(resolveSeasons(tv, { "tv:9": [2, 3, 4] }), [2, 3, 4], "honors custom seasons");
  assert.equal(resolveSeasons(tv, { "tv:9": "all" }), "all", "honors 'all' override");
});
