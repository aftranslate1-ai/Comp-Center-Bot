import { pgTable, text, timestamp, integer } from "drizzle-orm/pg-core";

export const inlineAudioFilesTable = pgTable("inline_audio_files", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  fileUniqueId: text("file_unique_id").notNull().unique(),
  fileId: text("file_id").notNull(),
  title: text("title"),
  performer: text("performer"),
  fileName: text("file_name"),
  duration: integer("duration"),
  searchText: text("search_text").notNull(),
  addedAt: timestamp("added_at").defaultNow().notNull(),
});

export type InlineAudioFile = typeof inlineAudioFilesTable.$inferSelect;
