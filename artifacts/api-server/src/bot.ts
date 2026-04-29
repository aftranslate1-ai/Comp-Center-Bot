import TelegramBot from "node-telegram-bot-api";
import { db } from "@workspace/db";
import { connectedChatsTable, channelMessagesTable, inlineAudioFilesTable } from "@workspace/db/schema";
import { logger } from "./lib/logger";
import { eq, ilike, or, isNotNull, and, desc } from "drizzle-orm";
import crypto from "crypto";

const AUTHORIZED_USERNAME = "BeRichAsFreh";

const SEARCH_CHANNEL_USERNAMES = [
  "tatemcraecomp",
  "BebeRexhaLeaks",
  "AvaMaxLeaks",
  "AddisonRaeComp",
  "ClaudiaValentinaComp",
];

const HELP_TEXT = `oops I didn't quite catch that, is there anything I can help you with hun?

/search - search for an unreleased song

/feedback - send me a complaint/request that will be forwarded to an admin`;

const START_TEXT = `Hi, I am the Comp Center Bot! 🎵
How may I help you today?

/search - search for an unreleased song

/feedback - send me a complaint/request that will be forwarded to an admin`;

interface ButtonData {
  text: string;
  url: string;
}

type UserStep =
  | "search_awaiting_query"
  | "feedback_awaiting_text"
  | "feedback_confirming"
  | "broadcast_awaiting_message"
  | "broadcast_awaiting_button_choice"
  | "broadcast_awaiting_button_text"
  | "broadcast_awaiting_button_url"
  | "broadcast_selecting_chats"
  | "inline_awaiting_audio";

interface ConnectedChatOption {
  chatId: string;
  label: string;
}

interface UserState {
  step: UserStep;
  message?: TelegramBot.Message;
  feedbackText?: string;
  buttons: ButtonData[];
  currentButtonText?: string;
  availableChats?: ConnectedChatOption[];
  selectedChatIds?: Set<string>;
  selectionMessageId?: number;
}

const userStates = new Map<number, UserState>();

function buildChatPickerKeyboard(
  chats: ConnectedChatOption[],
  selectedIds: Set<string>
): TelegramBot.InlineKeyboardButton[][] {
  const rows: TelegramBot.InlineKeyboardButton[][] = chats.map((c) => [
    {
      text: `${selectedIds.has(c.chatId) ? "✅" : "☐"} ${c.label}`,
      callback_data: `toggle_${c.chatId}`,
    },
  ]);

  const selectedCount = selectedIds.size;
  rows.push([
    {
      text: selectedCount > 0 ? `📤 Send to ${selectedCount} selected` : "📤 Select at least one",
      callback_data: "send_selected",
    },
    { text: "❌ Cancel", callback_data: "cancel_broadcast" },
  ]);

  return rows;
}

async function showChatPicker(
  bot: TelegramBot,
  chatId: number,
  state: UserState
): Promise<void> {
  const chats = await db.select().from(connectedChatsTable);

  if (chats.length === 0) {
    await bot.sendMessage(chatId, "No connected groups or channels found.");
    userStates.delete(chatId);
    return;
  }

  const options: ConnectedChatOption[] = chats.map((c) => ({
    chatId: c.chatId.toString(),
    label: c.chatTitle || `Chat ${c.chatId}`,
  }));

  state.availableChats = options;
  state.selectedChatIds = new Set(options.map((o) => o.chatId));
  state.step = "broadcast_selecting_chats";

  const sentMsg = await bot.sendMessage(
    chatId,
    "Which channels/groups do you want to send this to?\nAll are selected by default — tap to deselect any.",
    {
      reply_markup: {
        inline_keyboard: buildChatPickerKeyboard(options, state.selectedChatIds),
      },
    }
  );

  state.selectionMessageId = sentMsg.message_id;
}

async function searchMessages(query: string): Promise<Array<{ channelUsername: string; messageId: number; text: string; audioTitle: string | null }>> {
  const words = query.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];

  const textConditions = words.map((w) => ilike(channelMessagesTable.messageText, `%${w}%`));

  const rows = await db
    .select()
    .from(channelMessagesTable)
    .where(
      and(
        isNotNull(channelMessagesTable.audioTitle),
        or(...textConditions)
      )
    )
    .limit(10);

  return rows.map((r) => ({
    channelUsername: r.channelUsername,
    messageId: r.messageId,
    text: r.messageText,
    audioTitle: r.audioTitle ?? null,
  }));
}

export async function startBot() {
  const token = process.env["TELEGRAM_BOT_TOKEN"];
  if (!token) {
    logger.error("TELEGRAM_BOT_TOKEN is not set. Bot will not start.");
    return;
  }

  const bot = new TelegramBot(token, { polling: true });
  logger.info("Telegram bot started");

  bot.on("polling_error", (err) => {
    logger.error({ err: err.message }, "Telegram polling error — continuing");
  });

  bot.on("error", (err) => {
    logger.error({ err: err.message }, "Telegram bot error — continuing");
  });

  process.on("uncaughtException", (err) => {
    logger.error({ err }, "Uncaught exception — continuing");
  });

  process.on("unhandledRejection", (reason) => {
    logger.error({ reason }, "Unhandled promise rejection — continuing");
  });

  bot.on("channel_post", async (msg) => {
    try {
      if (!msg.chat.username) return;

      const audioTitle =
        msg.audio?.title ||
        msg.audio?.file_name ||
        msg.document?.file_name ||
        msg.video?.file_name ||
        null;

      if (!audioTitle) return;

      const searchableParts: string[] = [];
      if (msg.caption) searchableParts.push(msg.caption);
      if (msg.audio?.title) searchableParts.push(msg.audio.title);
      if (msg.audio?.performer) searchableParts.push(msg.audio.performer);
      if (msg.audio?.file_name) searchableParts.push(msg.audio.file_name);
      if (msg.document?.file_name) searchableParts.push(msg.document.file_name);
      if (msg.video?.file_name) searchableParts.push(msg.video.file_name);

      if (searchableParts.length === 0) return;

      const messageText = searchableParts.join(" ");
      const username = msg.chat.username;

      await db.insert(channelMessagesTable).values({
        channelUsername: username,
        messageId: msg.message_id,
        messageText,
        audioTitle,
      }).onConflictDoNothing();

      logger.info({ username, audioTitle, messageId: msg.message_id }, "Indexed audio from channel");
    } catch (err) {
      logger.error({ err }, "Error indexing channel post");
    }
  });

  bot.on("new_chat_members", async (msg) => {
    try {
      const botUser = await bot.getMe();
      const botAdded = msg.new_chat_members?.some((m) => m.id === botUser.id);
      if (botAdded && msg.chat.id) {
        await db
          .insert(connectedChatsTable)
          .values({
            chatId: BigInt(msg.chat.id),
            chatTitle: msg.chat.title || null,
            chatType: msg.chat.type,
          })
          .onConflictDoNothing();
        logger.info({ chatId: msg.chat.id }, "Bot added to chat");
        const addedByUserId = msg.from?.id;
        if (addedByUserId) {
          try {
            await bot.sendMessage(addedByUserId, "Your channel will now be updated ✅");
          } catch { }
        }
      }
    } catch (err) {
      logger.error({ err }, "Error in new_chat_members");
    }
  });

  bot.on("my_chat_member", async (update) => {
    try {
      const chat = update.chat;
      const newStatus = update.new_chat_member?.status;
      const oldStatus = update.old_chat_member?.status;

      if (
        (newStatus === "administrator" || newStatus === "member") &&
        oldStatus !== "administrator" &&
        oldStatus !== "member"
      ) {
        await db
          .insert(connectedChatsTable)
          .values({
            chatId: BigInt(chat.id),
            chatTitle: chat.title || null,
            chatType: chat.type,
          })
          .onConflictDoNothing();
        logger.info({ chatId: chat.id }, "Bot added to chat");

        const addedByUserId = update.from?.id;
        if (addedByUserId) {
          try {
            await bot.sendMessage(addedByUserId, "Your channel will now be updated ✅");
          } catch { }
        }
      }

      if (newStatus === "left" || newStatus === "kicked") {
        await db
          .delete(connectedChatsTable)
          .where(eq(connectedChatsTable.chatId, BigInt(chat.id)));
        logger.info({ chatId: chat.id }, "Bot removed from chat");
      }
    } catch (err) {
      logger.error({ err }, "Error in my_chat_member");
    }
  });

  bot.on("inline_query", async (query) => {
    try {
      const q = (query.query || "").trim();

      let rows;
      if (q.length === 0) {
        rows = await db
          .select()
          .from(inlineAudioFilesTable)
          .orderBy(desc(inlineAudioFilesTable.addedAt))
          .limit(50);
      } else {
        const words = q.split(/\s+/).filter(Boolean);
        const conditions = words.map((w) =>
          ilike(inlineAudioFilesTable.searchText, `%${w}%`)
        );
        rows = await db
          .select()
          .from(inlineAudioFilesTable)
          .where(and(...conditions))
          .orderBy(desc(inlineAudioFilesTable.addedAt))
          .limit(50);
      }

      const results = rows.map((r) => ({
        type: "audio" as const,
        id: crypto.createHash("md5").update(r.fileUniqueId).digest("hex").slice(0, 32),
        audio_file_id: r.fileId,
      }));

      await bot.answerInlineQuery(query.id, results, {
        cache_time: 0,
        is_personal: false,
      });
    } catch (err) {
      logger.error({ err }, "Error handling inline_query");
      try {
        await bot.answerInlineQuery(query.id, [], { cache_time: 0 });
      } catch { }
    }
  });

  bot.onText(/\/start/, async (msg) => {
    try {
      if (msg.chat.type !== "private") return;
      userStates.delete(msg.from!.id);
      await bot.sendMessage(msg.chat.id, START_TEXT);
    } catch (err) {
      logger.error({ err }, "Error handling /start");
    }
  });

  bot.onText(/\/search/, async (msg) => {
    try {
      if (msg.chat.type !== "private") return;
      userStates.set(msg.from!.id, { step: "search_awaiting_query", buttons: [] });
      await bot.sendMessage(
        msg.chat.id,
        "Sure! Let me know what title you are looking for and I'll see if it's available at Comp Center 🎵\n\n(keep in mind that for the time being we only have Tate McRae, Bebe Rexha, Ava Max, Addison Rae, Claudia Valentina, Olivia Rodrigo, Zara Larsson available)"
      );
    } catch (err) {
      logger.error({ err }, "Error handling /search");
    }
  });

  bot.onText(/\/feedback/, async (msg) => {
    try {
      if (msg.chat.type !== "private") return;
      userStates.set(msg.from!.id, { step: "feedback_awaiting_text", buttons: [] });
      await bot.sendMessage(
        msg.chat.id,
        "Ok! Send me a complaint or request, which will be forwarded to an admin 📩"
      );
    } catch (err) {
      logger.error({ err }, "Error handling /feedback");
    }
  });

  bot.onText(/\/publicfile/, async (msg) => {
    try {
      if (msg.chat.type !== "private") return;
      const username = msg.from?.username;
      if (username !== AUTHORIZED_USERNAME) {
        await bot.sendMessage(msg.chat.id, "This is not an available command.");
        return;
      }
      userStates.set(msg.from!.id, { step: "inline_awaiting_audio", buttons: [] });
      await bot.sendMessage(
        msg.chat.id,
        "Send me the song(s) you would like to add to the inline searching 🎵\n\nYou can send as many audio files as you want, one after the other. Send /done when you're finished."
      );
    } catch (err) {
      logger.error({ err }, "Error handling /publicfile");
    }
  });

  bot.onText(/\/done/, async (msg) => {
    try {
      if (msg.chat.type !== "private") return;
      const state = userStates.get(msg.from!.id);
      if (state?.step === "inline_awaiting_audio") {
        userStates.delete(msg.from!.id);
        await bot.sendMessage(msg.chat.id, "✅ Done! All sent songs are now searchable inline.");
      }
    } catch (err) {
      logger.error({ err }, "Error handling /done");
    }
  });

  bot.onText(/\/publicforward/, async (msg) => {
    try {
      if (msg.chat.type !== "private") return;
      const username = msg.from?.username;
      if (username !== AUTHORIZED_USERNAME) {
        await bot.sendMessage(msg.chat.id, "This is not an available command.");
        return;
      }
      userStates.set(msg.from!.id, { step: "broadcast_awaiting_message", buttons: [] });
      await bot.sendMessage(
        msg.chat.id,
        "Send me what you would like to send to all channels that this bot is connected to."
      );
    } catch (err) {
      logger.error({ err }, "Error handling /publicforward");
    }
  });

  bot.on("callback_query", async (query) => {
    try {
      if (!query.message || !query.from) return;
      await bot.answerCallbackQuery(query.id);

      const userId = query.from.id;
      const state = userStates.get(userId);

      if (query.data === "feedback_send") {
        if (!state?.feedbackText) return;
        const displayName = query.from.username
          ? `@${query.from.username}`
          : query.from.first_name
            ? query.from.first_name
            : `User #${query.from.id}`;
        const feedbackMsg = `📩 *New feedback from ${displayName}:*\n\n${state.feedbackText}`;

        try {
          const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              chat_id: `@complaintsrequests`,
              text: feedbackMsg,
              parse_mode: "Markdown",
            }),
          });

          if (!res.ok) throw new Error(await res.text());
        } catch (sendErr) {
          logger.error({ sendErr }, "Could not send feedback to admin group");
          await bot.sendMessage(
            query.message.chat.id,
            "⚠️ Couldn't reach the admin group right now. Please try again later."
          );
          userStates.delete(userId);
          return;
        }

        await bot.sendMessage(query.message.chat.id, "✅ Your feedback has been sent to an admin. Thank you!");
        userStates.delete(userId);

      } else if (query.data === "feedback_cancel") {
        userStates.delete(userId);
        await bot.sendMessage(
          query.message.chat.id,
          "No problem! If you would like to start again just send /feedback"
        );

      } else if (!state) {
        return;
      } else if (query.data === "skip_buttons" || query.data === "done_buttons") {
        await showChatPicker(bot, query.message.chat.id, state);

      } else if (query.data === "add_button") {
        state.step = "broadcast_awaiting_button_text";
        await bot.sendMessage(
          query.message.chat.id,
          "Send text for your button (or send /back to go back):"
        );

      } else if (query.data === "cancel_broadcast") {
        userStates.delete(userId);
        try {
          await bot.deleteMessage(query.message.chat.id, query.message.message_id);
        } catch { }
        await bot.sendMessage(query.message.chat.id, "Broadcast cancelled.");

      } else if (query.data === "send_selected") {
        if (!state.selectedChatIds || state.selectedChatIds.size === 0) {
          await bot.answerCallbackQuery(query.id, { text: "Please select at least one chat first." });
          return;
        }
        try {
          await bot.deleteMessage(query.message.chat.id, query.message.message_id);
        } catch { }
        await sendToSelectedChats(bot, token, state, query.message.chat.id, state.selectedChatIds);
        userStates.delete(userId);

      } else if (query.data?.startsWith("toggle_")) {
        if (!state.availableChats || !state.selectedChatIds || !state.selectionMessageId) return;
        const toggledId = query.data.slice("toggle_".length);
        if (state.selectedChatIds.has(toggledId)) {
          state.selectedChatIds.delete(toggledId);
        } else {
          state.selectedChatIds.add(toggledId);
        }
        try {
          await bot.editMessageReplyMarkup(
            { inline_keyboard: buildChatPickerKeyboard(state.availableChats, state.selectedChatIds) },
            { chat_id: query.message.chat.id, message_id: state.selectionMessageId }
          );
        } catch { }
      }
    } catch (err) {
      logger.error({ err }, "Error handling callback_query");
    }
  });

  bot.on("message", async (msg) => {
    try {
      if (msg.chat.type !== "private" || !msg.from) return;
      if (
        msg.text?.startsWith("/start") ||
        msg.text?.startsWith("/search") ||
        msg.text?.startsWith("/feedback") ||
        msg.text?.startsWith("/publicforward") ||
        msg.text?.startsWith("/publicfile") ||
        msg.text?.startsWith("/done")
      ) return;

      const userId = msg.from.id;
      const state = userStates.get(userId);

      if (state?.step === "inline_awaiting_audio") {
        if (msg.audio) {
          const audio = msg.audio;
          const searchParts = [
            audio.title,
            audio.performer,
            audio.file_name,
            msg.caption,
          ].filter(Boolean) as string[];
          const searchText = searchParts.join(" ");

          try {
            await db
              .insert(inlineAudioFilesTable)
              .values({
                fileUniqueId: audio.file_unique_id,
                fileId: audio.file_id,
                title: audio.title || null,
                performer: audio.performer || null,
                fileName: audio.file_name || null,
                duration: audio.duration || null,
                searchText,
              })
              .onConflictDoUpdate({
                target: inlineAudioFilesTable.fileUniqueId,
                set: {
                  fileId: audio.file_id,
                  title: audio.title || null,
                  performer: audio.performer || null,
                  fileName: audio.file_name || null,
                  duration: audio.duration || null,
                  searchText,
                },
              });

            const label = audio.title
              ? `${audio.performer ? audio.performer + " — " : ""}${audio.title}`
              : audio.file_name || "song";
            await bot.sendMessage(
              msg.chat.id,
              `✅ Added: ${label}\n\nKeep sending more, or /done when you're finished.`
            );
          } catch (err) {
            logger.error({ err }, "Error saving inline audio");
            await bot.sendMessage(msg.chat.id, "⚠️ Couldn't save that one, please try again.");
          }
          return;
        } else {
          await bot.sendMessage(
            msg.chat.id,
            "Please send an audio file (a song), or /done when you're finished."
          );
          return;
        }
      }

      if (!state) {
        await bot.sendMessage(msg.chat.id, HELP_TEXT);
        return;
      }

      if (state.step === "search_awaiting_query") {
        const query = msg.text?.trim() || "";
        userStates.delete(userId);

        const searchingMsg = await bot.sendMessage(msg.chat.id, `🔍 Searching for "${query}"...`);
        const results = await searchMessages(query);
        try { await bot.deleteMessage(msg.chat.id, searchingMsg.message_id); } catch { }

        if (results.length === 0) {
          await bot.sendMessage(
            msg.chat.id,
            `sorry gurl couldn't find any results for "${query}" 😔`
          );
        } else {
          await bot.sendMessage(msg.chat.id, `🎵 Results for "${query}":`);
          for (const result of results) {
            try {
              await bot.forwardMessage(msg.chat.id, `@${result.channelUsername}`, result.messageId);
            } catch {
              const display = result.audioTitle
                ? `🎵 ${result.audioTitle}`
                : `📄 ${result.text.slice(0, 300)}`;
              await bot.sendMessage(msg.chat.id, display);
            }
          }
        }

      } else if (state.step === "feedback_awaiting_text") {
        state.feedbackText = msg.text || "";
        state.step = "feedback_confirming";
        await bot.sendMessage(
          msg.chat.id,
          `Do you confirm you want to send this?\n\n"${state.feedbackText}"`,
          {
            reply_markup: {
              inline_keyboard: [
                [
                  { text: "✅ Send", callback_data: "feedback_send" },
                  { text: "❌ Cancel", callback_data: "feedback_cancel" },
                ],
              ],
            },
          }
        );

      } else if (state.step === "broadcast_awaiting_message") {
        state.message = msg;
        state.step = "broadcast_awaiting_button_choice";
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

      } else if (state.step === "broadcast_awaiting_button_text") {
        if (msg.text === "/back") {
          state.step = "broadcast_awaiting_button_choice";
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
        state.step = "broadcast_awaiting_button_url";
        await bot.sendMessage(msg.chat.id, "Send a link for your button:");

      } else if (state.step === "broadcast_awaiting_button_url") {
        const url = msg.text || "";
        state.buttons.push({ text: state.currentButtonText || "Button", url });
        state.currentButtonText = undefined;
        state.step = "broadcast_awaiting_button_choice";
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
    } catch (err) {
      logger.error({ err }, "Error handling message");
    }
  });

  return bot;
}

const BANNED_ERROR_PATTERNS = [
  "bot was kicked",
  "bot was blocked by the user",
  "bot is not a member",
  "chat not found",
  "have no rights",
  "not enough rights",
  "user is deactivated",
  "the group chat was deleted",
  "need administrator rights",
  "channel private",
  "forbidden",
];

function isBanError(status: number, body: string): boolean {
  if (status === 403) return true;
  if (status === 400) {
    const lower = body.toLowerCase();
    return BANNED_ERROR_PATTERNS.some((p) => lower.includes(p));
  }
  return false;
}

interface CopyResult {
  ok: boolean;
  banned: boolean;
  error?: string;
}

async function copyMessageViaApi(
  token: string,
  chatId: string,
  fromChatId: number,
  messageId: number,
  replyMarkup?: object
): Promise<CopyResult> {
  const body: Record<string, unknown> = {
    chat_id: chatId,
    from_chat_id: fromChatId,
    message_id: messageId,
  };
  if (replyMarkup) body["reply_markup"] = replyMarkup;

  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/copyMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (res.ok) return { ok: true, banned: false };
    const text = await res.text();
    const banned = isBanError(res.status, text);
    return { ok: false, banned, error: `${res.status} ${text}` };
  } catch (err) {
    return { ok: false, banned: false, error: String(err) };
  }
}

async function sendToSelectedChats(
  bot: TelegramBot,
  token: string,
  state: UserState,
  adminChatId: number,
  selectedIds: Set<string>
) {
  const originalMsg = state.message!;
  const replyMarkup =
    state.buttons.length > 0
      ? { inline_keyboard: state.buttons.map((b) => [{ text: b.text, url: b.url }]) }
      : undefined;

  let successCount = 0;
  let failCount = 0;
  let removedCount = 0;

  for (const chatId of selectedIds) {
    const result = await copyMessageViaApi(token, chatId, originalMsg.chat.id, originalMsg.message_id, replyMarkup);

    if (result.ok) {
      successCount++;
    } else if (result.banned) {
      removedCount++;
      logger.warn({ chatId, error: result.error }, "Bot banned — removing from DB");
      try {
        await db.delete(connectedChatsTable).where(eq(connectedChatsTable.chatId, BigInt(chatId)));
      } catch (dbErr) {
        logger.error({ dbErr }, "Failed to remove banned chat");
      }
    } else {
      failCount++;
      logger.error({ chatId, error: result.error }, "Failed to send to chat");
    }
  }

  const parts: string[] = [`Message sent to ${successCount} chat(s).`];
  if (removedCount > 0) parts.push(`${removedCount} removed (bot was banned).`);
  if (failCount > 0) parts.push(`${failCount} failed.`);
  await bot.sendMessage(adminChatId, parts.join(" "));
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
      ? { inline_keyboard: state.buttons.map((b) => [{ text: b.text, url: b.url }]) }
      : undefined;

  let successCount = 0;
  let failCount = 0;
  let removedCount = 0;

  for (const chat of chats) {
    const chatId = chat.chatId.toString();
    const result = await copyMessageViaApi(
      token,
      chatId,
      originalMsg.chat.id,
      originalMsg.message_id,
      replyMarkup
    );

    if (result.ok) {
      successCount++;
    } else if (result.banned) {
      removedCount++;
      logger.warn({ chatId, error: result.error }, "Bot banned — removing from DB");
      try {
        await db
          .delete(connectedChatsTable)
          .where(eq(connectedChatsTable.chatId, BigInt(chat.chatId)));
      } catch (dbErr) {
        logger.error({ dbErr }, "Failed to remove banned chat");
      }
    } else {
      failCount++;
      logger.error({ chatId, error: result.error }, "Failed to send to chat");
    }
  }

  const parts: string[] = [`Message sent to ${successCount} chat(s).`];
  if (removedCount > 0) parts.push(`${removedCount} removed (bot was banned).`);
  if (failCount > 0) parts.push(`${failCount} failed.`);
  await bot.sendMessage(adminChatId, parts.join(" "));
}
