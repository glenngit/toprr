import "dotenv/config";
import { buildFeed, renderFeedText } from "./feed.js";
import { dedupeFeed, renderFeedEntriesText } from "./seerr.js";
import { ConfigStore } from "./config.js";
import { runSync } from "./sync.js";

/**
 * CLI entry point.
 *
 * Usage:
 *   npm run feed            # per-service Top 10 (text)
 *   npm run feed:json       # per-service Top 10 (JSON, for piping)
 *   npm run feed:list       # the deduplicated "final feeding list" (text)
 *   npm run feed:list:json  # the deduplicated final feeding list (JSON)
 *   npm run sync            # DRY RUN: show what would be requested in Seerr
 *   npm run sync:submit     # actually submit requests for new titles
 *
 * Configuration is read from data/config.json (seeded from .env on first run)
 * so the CLI and the web GUI share one source of truth.
 */
async function main(): Promise<void> {
  const asJson = process.argv.includes("--json");
  const asList = process.argv.includes("--list");
  const doSync = process.argv.includes("--sync");
  const doSubmit = process.argv.includes("--submit");

  const config = await new ConfigStore().load();
  if (!config.apiKey) {
    console.error(
      "No Streaming Availability API key configured. Set it in .env or via the web GUI settings.",
    );
    process.exit(1);
  }

  if (doSync || doSubmit) {
    const result = await runSync(config, { submit: doSubmit });
    console.error(
      `Deduped feed: ${result.uniqueCount} unique | ` +
        `already in Seerr/library: ${result.skippedExisting.length} | ` +
        `new: ${result.plan.length}`,
    );
    if (result.dryRun) {
      console.log(
        renderFeedEntriesText(result.plan, "WOULD REQUEST (dry run — new titles only)"),
      );
      console.error("Dry run only. Re-run with --submit to actually request.");
    } else {
      for (const e of result.requested) {
        console.error(`  requested: ${e.title} (${e.mediaType}/${e.tmdbId})`);
      }
      for (const f of result.failed) {
        console.error(`  FAILED:    ${f.entry.title} — ${f.error}`);
      }
      console.error(
        `Done. Requested ${result.requested.length}, failed ${result.failed.length}, ` +
          `skipped ${result.skippedExisting.length}.`,
      );
    }
    return;
  }

  const feed = await buildFeed({
    apiKey: config.apiKey,
    country: config.country,
    limit: config.limit,
    services: config.services,
  });

  if (asList) {
    const entries = dedupeFeed(feed);
    console.log(asJson ? JSON.stringify(entries, null, 2) : renderFeedEntriesText(entries));
    return;
  }

  console.log(asJson ? JSON.stringify(feed, null, 2) : renderFeedText(feed));
}

main().catch((err) => {
  console.error("Error:", err instanceof Error ? err.message : err);
  process.exit(1);
});
