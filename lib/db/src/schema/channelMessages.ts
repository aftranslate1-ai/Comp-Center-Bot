import { pgTable, text, timestamp, integer } from "drizzle-orm/pg-core";

export const channelMessagesTable = pgTable("channel_messages", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  channelUsername: text("channel_username").notNull(),
  messageId: integer("message_id").notNull(),
  messageText: text("message_text").notNull(),
  audioTitle: text("audio_title"),
  savedAt: timestamp("saved_at").defaultNow().notNull(),
});

export type ChannelMessage = typeof channelMessagesTable.$inferSelect;
