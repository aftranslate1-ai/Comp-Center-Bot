import { pgTable, bigint, text, boolean, timestamp, integer } from "drizzle-orm/pg-core";

export const usersTable = pgTable("users", {
  userId: bigint("user_id", { mode: "number" }).primaryKey(),
  username: text("username"),
  isPremium: boolean("is_premium").default(false).notNull(),
  premiumExpiry: timestamp("premium_expiry"),
  premiumFree: boolean("premium_free").default(false).notNull(),
  subscriptionCancelled: boolean("subscription_cancelled").default(false).notNull(),
  earlyMusicEnabled: boolean("early_music_enabled").default(false).notNull(),
  dailyTagCount: integer("daily_tag_count").default(0).notNull(),
  dailyTagDate: text("daily_tag_date"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export type User = typeof usersTable.$inferSelect;
