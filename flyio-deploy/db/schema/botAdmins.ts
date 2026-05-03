import { pgTable, integer, text, timestamp } from "drizzle-orm/pg-core";

export const botAdminsTable = pgTable("bot_admins", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  userId: integer("user_id").notNull().unique(),
  username: text("username"),
  addedAt: timestamp("added_at").defaultNow().notNull(),
});

export type BotAdmin = typeof botAdminsTable.$inferSelect;
