import * as cheerio from "cheerio";
import { db } from "@workspace/db";
import { seenLeakedThreadsTable } from "@workspace/db/schema";
import { eq } from "drizzle-orm";
import { logger } from "./lib/logger";

const FORUM_URL = "https://leaked.cx/forums/othergenreleaks/";

const WATCHED_ARTISTS = [
  "tate mcrae",
  "ava max",
  "olivia rodrigo",
  "claudia valentina",
  "addison rae",
  "dua lipa",
  "bebe rexha",
];

const ALERT_CHAT = "@complaintsrequests";

let botToken: string | undefined;

interface ForumThread {
  id: string;
  title: string;
  url: string;
}

async function fetchThreads(): Promise<ForumThread[]> {
  try {
    const res = await fetch(FORUM_URL, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.5",
      },
    });

    if (!res.ok) {
      logger.warn({ status: res.status }, "Forum fetch returned non-OK status");
      return [];
    }

    const html = await res.text();
    const $ = cheerio.load(html);
    const threads: ForumThread[] = [];

    $("a[data-thread-id], a[id^='thread-'], .structItem-title a, .threads a.title, a.PreviewTooltip").each((_, el) => {
      const href = $(el).attr("href") || "";
      const title = $(el).text().trim();
      if (!title || !href) return;

      const match =
        href.match(/\/threads\/[^/]+-(\d+)\/?/) ||
        href.match(/\/threads\/(\d+)\/?/) ||
        href.match(/\?t=(\d+)/) ||
        href.match(/threads\/.*?\.(\d+)\/?/);

      if (!match) return;
      const id = match[1];
      const url = href.startsWith("http") ? href : `https://leaked.cx${href}`;
      threads.push({ id, title, url });
    });

    if (threads.length === 0) {
      $("a").each((_, el) => {
        const href = $(el).attr("href") || "";
        const title = $(el).text().trim();
        if (!title || !href) return;

        const match =
          href.match(/\/threads\/[^/]+-(\d+)\/?/) ||
          href.match(/threads\/.*?\.(\d+)\/?/);

        if (!match) return;
        if (href.includes("/othergenreleaks/") || href.match(/threads\/[^/]+-\d+\/?/)) {
          const id = match[1];
          const url = href.startsWith("http") ? href : `https://leaked.cx${href}`;
          threads.push({ id, title, url });
        }
      });
    }

    const seen = new Set<string>();
    return threads.filter((t) => {
      if (seen.has(t.id)) return false;
      seen.add(t.id);
      return true;
    });
  } catch (err) {
    logger.error({ err }, "Error fetching forum page");
    return [];
  }
}

function matchesArtist(title: string): string | null {
  const lower = title.toLowerCase();
  for (const artist of WATCHED_ARTISTS) {
    if (lower.includes(artist)) return artist;
  }
  return null;
}

async function isThreadSeen(threadId: string): Promise<boolean> {
  const rows = await db
    .select()
    .from(seenLeakedThreadsTable)
    .where(eq(seenLeakedThreadsTable.threadId, threadId))
    .limit(1);
  return rows.length > 0;
}

async function markThreadSeen(thread: ForumThread): Promise<void> {
  await db
    .insert(seenLeakedThreadsTable)
    .values({ threadId: thread.id, threadTitle: thread.title, threadUrl: thread.url })
    .onConflictDoNothing();
}

async function sendAlert(thread: ForumThread, artist: string): Promise<void> {
  if (!botToken) return;
  const text =
    `🚨 *New leak spotted on leaked.cx!*\n\n` +
    `*Artist:* ${artist.replace(/([_*[\]()~`>#+\-=|{}.!])/g, "\\$1")}\n` +
    `*Thread:* [${thread.title.replace(/([_*[\]()~`>#+\-=|{}.!])/g, "\\$1")}](${thread.url})\n\n` +
    `📌 Someone needs to tag the file and send it into the correct group!`;

  try {
    const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: ALERT_CHAT,
        text,
        parse_mode: "MarkdownV2",
        disable_web_page_preview: false,
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      logger.error({ status: res.status, body }, "Failed to send leak alert");
    } else {
      logger.info({ thread: thread.title, artist }, "Sent leak alert");
    }
  } catch (err) {
    logger.error({ err }, "Error sending leak alert");
  }
}

async function runScrape(): Promise<void> {
  logger.info("Running leaked.cx scrape");
  const threads = await fetchThreads();
  logger.info({ count: threads.length }, "Fetched threads from forum");

  for (const thread of threads) {
    const artist = matchesArtist(thread.title);
    if (!artist) continue;

    const seen = await isThreadSeen(thread.id);
    if (seen) continue;

    await markThreadSeen(thread);
    await sendAlert(thread, artist);
  }
}

export function startScraper(token: string): void {
  botToken = token;

  runScrape().catch((err) => logger.error({ err }, "Initial scrape failed"));

  const INTERVAL_MS = 15 * 60 * 1000;
  setInterval(() => {
    runScrape().catch((err) => logger.error({ err }, "Periodic scrape failed"));
  }, INTERVAL_MS);

  logger.info({ intervalMinutes: 15 }, "Leaked.cx scraper started");
}
