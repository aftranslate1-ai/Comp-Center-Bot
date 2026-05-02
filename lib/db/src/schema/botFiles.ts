import { pgTable, text, timestamp, integer } from "drizzle-orm/pg-core";

export const botFilesTable = pgTable("bot_files", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  fileUniqueId: text("file_unique_id").notNull().unique(),
  fileId: text("file_id").notNull(),
  title: text("title"),
  performer: text("performer"),
  fileName: text("file_name"),
  ogFileUniqueId: text("og_file_unique_id"),
  ogFileId: text("og_file_id"),
  addedAt: timestamp("added_at").defaultNow().notNull(),
});

export type BotFile = typeof botFilesTable.$inferSelect;
