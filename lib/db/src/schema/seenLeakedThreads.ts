import { pgTable, text, timestamp, integer } from "drizzle-orm/pg-core";

export const seenLeakedThreadsTable = pgTable("seen_leaked_threads", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  threadId: text("thread_id").notNull().unique(),
  threadTitle: text("thread_title").notNull(),
  threadUrl: text("thread_url").notNull(),
  seenAt: timestamp("seen_at").defaultNow().notNull(),
});

export type SeenLeakedThread = typeof seenLeakedThreadsTable.$inferSelect;
