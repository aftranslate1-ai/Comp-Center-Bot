import TelegramBot from "node-telegram-bot-api";
import { db } from "@workspace/db";
import { connectedChatsTable } from "@workspace/db/schema";
import { logger } from "./lib/logger";
import { eq } from "drizzle-orm";

const AUTHORIZED_USERNAME = "BeRichAsFreh";

interface ButtonData {
  text: string;
  url: string;
}

interface UserState {
  step:
    | "awaiting_message"
    | "awaiting_button_choice"
    | "awaiting_button_text"
    | "awaiting_button_url";
  message?: TelegramBot.Message;
  buttons: ButtonData[];
  currentButtonText?: string;
}

const userStates = new Map<number, UserState>();

export function startBot() {
  const token = process.env["TELEGRAM_BOT_TOKEN"];
  if (!token) {
    logger.error("TELEGRAM_BOT_TOKEN is not set. Bot will not start.");
    return;
  }

  const bot = new TelegramBot(token, { polling: true });
  logger.info("Telegram bot started");

  bot.on("new_chat_members", async (msg) => {
    const botUser = await bot.getMe();
    const botAdded = msg.new_chat_members?.some((m) => m.id === botUser.id);
    if (botAdded && msg.chat.id) {
      try {
        await db
          .insert(connectedChatsTable)
          .values({
            chatId: BigInt(msg.chat.id),
            chatTitle: msg.chat.title || null,
            chatType: msg.chat.type,
          })
          .onConflictDoNothing();
        logger.info({ chatId: msg.chat.id, title: msg.chat.title }, "Bot added to chat");

        const addedByUserId = msg.from?.id;
        if (addedByUserId) {
          try {
            await bot.sendMessage(addedByUserId, "Your channel will now be updated ✅");
          } catch {
            // user may not have started the bot yet
          }
        }
      } catch (err) {
        logger.error({ err }, "Failed to save connected chat");
      }
    }
  });

  bot.on("my_chat_member", async (update) => {
    const chat = update.chat;
    const newStatus = update.new_chat_member?.status;
    const oldStatus = update.old_chat_member?.status;

    if (
      (newStatus === "administrator" || newStatus === "member") &&
      oldStatus !== "administrator" &&
      oldStatus !== "member"
    ) {
      try {
        await db
          .insert(connectedChatsTable)
          .values({
            chatId: BigInt(chat.id),
            chatTitle: chat.title || null,
            chatType: chat.type,
          })
          .onConflictDoNothing();
        logger.info({ chatId: chat.id, title: chat.title }, "Bot added to chat via my_chat_member");

        const addedByUserId = update.from?.id;
        if (addedByUserId) {
          try {
            await bot.sendMessage(addedByUserId, "Your channel will now be updated ✅");
          } catch {
            // user may not have started the bot yet
          }
        }
      } catch (err) {
        logger.error({ err }, "Failed to save connected chat");
      }
    }

    if (newStatus === "left" || newStatus === "kicked") {
      try {
        await db
          .delete(connectedChatsTable)
          .where(eq(connectedChatsTable.chatId, BigInt(chat.id)));
        logger.info({ chatId: chat.id }, "Bot removed from chat");
      } catch (err) {
        logger.error({ err }, "Failed to remove connected chat");
      }
    }
  });

  bot.onText(/\/start/, async (msg) => {
    if (msg.chat.type !== "private") return;

    const botInfo = await bot.getMe();
    await bot.sendMessage(
      msg.chat.id,
      "Add me to a group or channel so I can update it with new posts from all Ava Max's social medias for you 🎤",
      {
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: "➕ Add to Group",
                url: `https://t.me/${botInfo.username}?startgroup=true`,
              },
              {
                text: "➕ Add to Channel",
                url: `https://t.me/${botInfo.username}?startchannel=true`,
              },
            ],
          ],
        },
      }
    );
  });

  bot.onText(/\/publicforward/, async (msg) => {
    if (msg.chat.type !== "private") return;

    const username = msg.from?.username;
    if (username !== AUTHORIZED_USERNAME) {
      await bot.sendMessage(msg.chat.id, "This is not an available command.");
      return;
    }

    userStates.set(msg.from!.id, {
      step: "awaiting_message",
      buttons: [],
    });

    await bot.sendMessage(
      msg.chat.id,
      "Send me what you would like to send to all channels that this bot is connected to."
    );
  });

  bot.on("callback_query", async (query) => {
    if (!query.message || !query.from) return;
    await bot.answerCallbackQuery(query.id);

    const userId = query.from.id;
    const state = userStates.get(userId);
    if (!state) return;

    if (query.data === "skip_buttons" || query.data === "done_buttons") {
      await sendToAllChats(bot, token, state, query.message.chat.id);
      userStates.delete(userId);
    } else if (query.data === "add_button") {
      state.step = "awaiting_button_text";
      await bot.sendMessage(
        query.message.chat.id,
        "Send text for your button (or send /back to go back):"
      );
    }
  });

  bot.on("message", async (msg) => {
    if (msg.chat.type !== "private" || !msg.from) return;
    if (msg.text?.startsWith("/start") || msg.text?.startsWith("/publicforward")) return;

    const userId = msg.from.id;
    const state = userStates.get(userId);
    if (!state) return;

    if (state.step === "awaiting_message") {
      state.message = msg;
      state.step = "awaiting_button_choice";
      await bot.sendMessage(msg.chat.id, "Would you like to add buttons to this message?", {
        reply_markup: {
          inline_keyboard: [
            [
              { text: "➕ Add Button", callback_data: "add_button" },
              { text: "Skip", callback_data: "skip_buttons" },
            ],
          ],
        },
      });
    } else if (state.step === "awaiting_button_text") {
      if (msg.text === "/back") {
        state.step = "awaiting_button_choice";
        await bot.sendMessage(msg.chat.id, "Would you like to add buttons to this message?", {
          reply_markup: {
            inline_keyboard: [
              [
                { text: "➕ Add Button", callback_data: "add_button" },
                { text: "Skip", callback_data: "skip_buttons" },
              ],
            ],
          },
        });
        return;
      }

      state.currentButtonText = msg.text || "Button";
      state.step = "awaiting_button_url";
      await bot.sendMessage(msg.chat.id, "Send a link for your button:");
    } else if (state.step === "awaiting_button_url") {
      const url = msg.text || "";
      state.buttons.push({
        text: state.currentButtonText || "Button",
        url: url,
      });
      state.currentButtonText = undefined;
      state.step = "awaiting_button_choice";

      const currentButtons = state.buttons
        .map((b, i) => `${i + 1}. ${b.text} → ${b.url}`)
        .join("\n");

      await bot.sendMessage(
        msg.chat.id,
        `Button added! Current buttons:\n${currentButtons}\n\nWould you like to add another button?`,
        {
          reply_markup: {
            inline_keyboard: [
              [
                { text: "➕ Add Button", callback_data: "add_button" },
                { text: "Done ✅", callback_data: "done_buttons" },
              ],
            ],
          },
        }
      );
    }
  });

  return bot;
}

async function copyMessageViaApi(
  token: string,
  chatId: string,
  fromChatId: number,
  messageId: number,
  replyMarkup?: object
): Promise<void> {
  const body: Record<string, unknown> = {
    chat_id: chatId,
    from_chat_id: fromChatId,
    message_id: messageId,
  };

  if (replyMarkup) {
    body["reply_markup"] = replyMarkup;
  }

  const res = await fetch(`https://api.telegram.org/bot${token}/copyMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`copyMessage failed: ${res.status} ${text}`);
  }
}

async function sendToAllChats(
  bot: TelegramBot,
  token: string,
  state: UserState,
  adminChatId: number
) {
  const chats = await db.select().from(connectedChatsTable);

  if (chats.length === 0) {
    await bot.sendMessage(adminChatId, "No connected groups or channels found.");
    return;
  }

  const originalMsg = state.message!;

  const replyMarkup =
    state.buttons.length > 0
      ? {
          inline_keyboard: state.buttons.map((b) => [{ text: b.text, url: b.url }]),
        }
      : undefined;

  let successCount = 0;
  let failCount = 0;

  for (const chat of chats) {
    try {
      const chatId = chat.chatId.toString();

      await copyMessageViaApi(
        token,
        chatId,
        originalMsg.chat.id,
        originalMsg.message_id,
        replyMarkup
      );

      successCount++;
    } catch (err) {
      failCount++;
      logger.error({ err, chatId: chat.chatId.toString() }, "Failed to send to chat");
    }
  }

  await bot.sendMessage(
    adminChatId,
    `Message sent to ${successCount} chat(s).${failCount > 0 ? ` Failed: ${failCount}.` : ""}`
  );
}
