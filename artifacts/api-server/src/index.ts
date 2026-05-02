import app from "./app";
import { logger } from "./lib/logger";
import { startBot } from "./bot";
import { startScraper } from "./scraper";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");

  // Self-ping every 5 minutes to keep the bot alive
  setInterval(async () => {
    try {
      await fetch(`http://localhost:${port}/`);
    } catch {
      // ignore — server may not have a root route
    }
  }, 5 * 60 * 1000);
});

startBot().catch((err) => {
  logger.error({ err }, "Bot failed to start");
});

const scraperToken = process.env["TELEGRAM_BOT_TOKEN"];
if (scraperToken) {
  startScraper(scraperToken);
} else {
  logger.warn("TELEGRAM_BOT_TOKEN not set — scraper will not start");
}
