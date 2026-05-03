import { pgTable, bigint, text, timestamp } from "drizzle-orm/pg-core";

export const connectedChatsTable = pgTable("connected_chats", {
  chatId: bigint("chat_id", { mode: "bigint" }).primaryKey(),
  chatTitle: text("chat_title"),
  chatType: text("chat_type").notNull(),
  addedAt: timestamp("added_at").defaultNow().notNull(),
});

export type ConnectedChat = typeof connectedChatsTable.$inferSelect;
