import TelegramBot from "node-telegram-bot-api";
import NodeID3 from "node-id3";
import { db } from "@workspace/db";
import {
  connectedChatsTable,
  channelMessagesTable,
  inlineAudioFilesTable,
  usersTable,
  botFilesTable,
} from "@workspace/db/schema";
import { logger } from "./lib/logger";
import { eq, ilike, and, desc } from "drizzle-orm";
import crypto from "crypto";

// node-telegram-bot-api types omit some optional API fields
declare module "node-telegram-bot-api" {
  interface Audio {
    file_name?: string;
  }
  interface Document {
    file_name?: string;
  }
}

// ─── Constants ────────────────────────────────────────────────────────────────

const AUTHORIZED_USERNAME = "BeRichAsFreh";
const DAILY_TAG_LIMIT = 25;
const PREMIUM_YEARLY_STARS = 130;
const BOT_USERNAME = "CompCenterBot";

const PREMIUM_FEATURES_TEXT =
  "• Get OG files\n• Unlimited MP3 tagging\n• Download unlimited files\n• Get access to music early";

const HELP_TEXT = `oops I didn't quite catch that, is there anything I can help you with hun?

/search - search for an unreleased song
/tagmp3 - tag your MP3 files with custom artwork & info ✨
/subscribe - unlock CC Premium ✨
/feedback - send me a complaint/request that will be forwarded to an admin`;

const START_TEXT = `Hi, I am the Comp Center Bot! 🎵
How may I help you today?

/search - search for an unreleased song
/tagmp3 - tag your MP3 files with artwork & info
/subscribe - unlock CC Premium ✨
/feedback - send me a complaint/request`;

// ─── Types ────────────────────────────────────────────────────────────────────

interface ButtonData {
  text: string;
  url: string;
}

interface TagFile {
  fileId: string;
  fileUniqueId: string;
  title?: string;
  performer?: string;
  fileName?: string;
  duration?: number;
}

interface FileForwardPair {
  normal: TagFile;
  caption?: string;
  og?: TagFile;
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
  | "inline_awaiting_audio"
  | "removefile_browsing"
  | "removefile_searching"
  | "tagmp3_awaiting_file_normal"
  | "tagmp3_awaiting_title_normal"
  | "tagmp3_awaiting_artist_normal"
  | "tagmp3_awaiting_coverart_normal"
  | "tagmp3_collecting_fast"
  | "tagmp3_awaiting_coverart_fast"
  | "tagmp3_awaiting_artist_fast"
  | "freepremium_give_awaiting_user"
  | "freepremium_remove_awaiting_user"
  | "freepremium_give_confirm"
  | "earlymusic_collecting"
  | "fileforward_collecting"
  | "fileforward_awaiting_og"
  | "fileforward_selecting_chats";

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
  removeFilePage?: number;
  removeFileMessageId?: number;
  inlineAddedCount?: number;
  // tagmp3
  tagFiles?: TagFile[];
  tagCoverArtFileId?: string;
  tagArtist?: string;
  tagCurrentFile?: TagFile;
  tagTitle?: string;
  // freepremium
  freepremiumTarget?: string;
  freepremiumTargetId?: number;
  freepremiumTargetUsername?: string;
  freepremiumAction?: "give" | "remove";
  // earlymusic
  earlyMusicFiles?: TagFile[];
  earlyMusicAddedCount?: number;
  // fileforward
  fileforwardFiles?: FileForwardPair[];
  fileforwardCurrentOgIndex?: number;
}

const userStates = new Map<number, UserState>();

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function safeSendMessage(
  bot: TelegramBot,
  chatId: number,
  text: string,
  options?: TelegramBot.SendMessageOptions
): Promise<TelegramBot.Message | null> {
  try {
    return await bot.sendMessage(chatId, text, options);
  } catch (err) {
    logger.warn({ err, chatId }, "safeSendMessage failed");
    return null;
  }
}

async function getOrCreateUser(userId: number, username?: string) {
  const existing = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.userId, userId))
    .limit(1);

  if (existing.length > 0) {
    if (username && existing[0]!.username !== username) {
      await db
        .update(usersTable)
        .set({ username })
        .where(eq(usersTable.userId, userId));
    }
    return existing[0]!;
  }

  const inserted = await db
    .insert(usersTable)
    .values({ userId, username: username || null })
    .returning();
  return inserted[0]!;
}

async function isUserPremium(userId: number): Promise<boolean> {
  const rows = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.userId, userId))
    .limit(1);
  if (rows.length === 0) return false;
  const u = rows[0]!;
  if (!u.isPremium) return false;
  if (!u.premiumExpiry) return true;
  return u.premiumExpiry > new Date();
}

function todayStr(): string {
  return new Date().toISOString().slice(0, 10);
}

async function getRemainingTags(userId: number): Promise<number> {
  const rows = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.userId, userId))
    .limit(1);
  if (rows.length === 0) return DAILY_TAG_LIMIT;
  const u = rows[0]!;
  if (u.dailyTagDate !== todayStr()) return DAILY_TAG_LIMIT;
  return Math.max(0, DAILY_TAG_LIMIT - u.dailyTagCount);
}

async function incrementTagCount(userId: number, count = 1) {
  const today = todayStr();
  const rows = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.userId, userId))
    .limit(1);

  if (rows.length === 0) {
    await db.insert(usersTable).values({
      userId,
      dailyTagCount: count,
      dailyTagDate: today,
    });
  } else {
    const u = rows[0]!;
    const newCount = u.dailyTagDate === today ? u.dailyTagCount + count : count;
    await db
      .update(usersTable)
      .set({ dailyTagCount: newCount, dailyTagDate: today })
      .where(eq(usersTable.userId, userId));
  }
}

function cleanTitle(raw: string): string {
  return raw
    .replace(/^[\d]+[\s.\-_)]+/g, "")
    .replace(/\s*[\(\[](feat|ft|featuring)[^)\]]*[\)\]]/gi, "")
    .replace(/\s*[\(\[](prod\.?|produced by)[^)\]]*[\)\]]/gi, "")
    .replace(/\.(mp3|m4a|flac|wav|ogg|aac|opus)$/i, "")
    .trim();
}

async function downloadTelegramFile(token: string, fileId: string): Promise<Buffer> {
  const res = await fetch(`https://api.telegram.org/bot${token}/getFile?file_id=${fileId}`);
  const data = (await res.json()) as { ok: boolean; result?: { file_path: string } };
  if (!data.ok || !data.result?.file_path) throw new Error("getFile failed");
  const fileRes = await fetch(
    `https://api.telegram.org/file/bot${token}/${data.result.file_path}`
  );
  if (!fileRes.ok) throw new Error("File download failed");
  return Buffer.from(await fileRes.arrayBuffer());
}

async function sendPremiumPaywall(
  bot: TelegramBot,
  chatId: number,
  reason?: string
) {
  const text =
    (reason ? reason + "\n\n" : "") +
    `Upgrade to CC Premium for just ${PREMIUM_YEARLY_STARS} Telegram Stars/year and get:\n\n${PREMIUM_FEATURES_TEXT}`;
  await safeSendMessage(bot, chatId, text, {
    reply_markup: {
      inline_keyboard: [
        [
          { text: "Cancel ❌", callback_data: "cancel_subscribe" },
          { text: "Unlock ✨", callback_data: "do_subscribe" },
        ],
      ],
    },
  });
}

// ─── Keyboard builders ────────────────────────────────────────────────────────

const REMOVE_PAGE_SIZE = 10;

function formatSongLabel(row: {
  title: string | null;
  performer: string | null;
  fileName: string | null;
}): string {
  if (row.title) {
    return row.performer ? `${row.performer} — ${row.title}` : row.title;
  }
  return row.fileName || "Untitled";
}

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
      text:
        selectedCount > 0
          ? `📤 Send to ${selectedCount} selected`
          : "📤 Select at least one",
      callback_data: "send_selected",
    },
    { text: "❌ Cancel", callback_data: "cancel_broadcast" },
  ]);
  return rows;
}

async function buildRemoveFileKeyboard(page: number): Promise<{
  keyboard: TelegramBot.InlineKeyboardButton[][];
  total: number;
  pageCount: number;
}> {
  const totalRows = await db.select().from(inlineAudioFilesTable);
  const total = totalRows.length;
  const pageCount = Math.max(1, Math.ceil(total / REMOVE_PAGE_SIZE));
  const safePage = Math.min(Math.max(0, page), pageCount - 1);
  const offset = safePage * REMOVE_PAGE_SIZE;

  const sorted = totalRows
    .slice()
    .sort((a, b) => b.addedAt.getTime() - a.addedAt.getTime())
    .slice(offset, offset + REMOVE_PAGE_SIZE);

  const rows: TelegramBot.InlineKeyboardButton[][] = sorted.map((r) => [
    {
      text: `❌ ${formatSongLabel(r)}`.slice(0, 60),
      callback_data: `rm_${r.id}`,
    },
  ]);

  const navRow: TelegramBot.InlineKeyboardButton[] = [];
  if (safePage > 0) navRow.push({ text: "⬅️ Prev", callback_data: `rm_page_${safePage - 1}` });
  navRow.push({ text: `Page ${safePage + 1}/${pageCount}`, callback_data: "rm_noop" });
  if (safePage < pageCount - 1)
    navRow.push({ text: "Next ➡️", callback_data: `rm_page_${safePage + 1}` });
  rows.push(navRow);
  rows.push([{ text: "Done ✅", callback_data: "rm_done" }]);
  return { keyboard: rows, total, pageCount };
}

async function showChatPicker(
  bot: TelegramBot,
  chatId: number,
  state: UserState,
  step: UserStep = "broadcast_selecting_chats"
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
  state.selectedChatIds = new Set();
  state.step = step;

  const sentMsg = await bot.sendMessage(
    chatId,
    "Select the channels/groups you want to send this to:",
    {
      reply_markup: {
        inline_keyboard: buildChatPickerKeyboard(options, state.selectedChatIds),
      },
    }
  );
  state.selectionMessageId = sentMsg.message_id;
}

// ─── startBot ─────────────────────────────────────────────────────────────────

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

  // ─── Channel post indexing ───────────────────────────────────────────────────

  bot.on("channel_post", async (msg) => {
    try {
      if (!msg.chat.username) return;
      const audioTitle =
        msg.audio?.title || msg.audio?.file_name || msg.document?.file_name || null;
      if (!audioTitle) return;

      const parts: string[] = [];
      if (msg.caption) parts.push(msg.caption);
      if (msg.audio?.title) parts.push(msg.audio.title);
      if (msg.audio?.performer) parts.push(msg.audio.performer);
      if (msg.audio?.file_name) parts.push(msg.audio.file_name);
      if (msg.document?.file_name) parts.push(msg.document.file_name);
      if (parts.length === 0) return;

      await db
        .insert(channelMessagesTable)
        .values({
          channelUsername: msg.chat.username,
          messageId: msg.message_id,
          messageText: parts.join(" "),
          audioTitle,
        })
        .onConflictDoNothing();
    } catch (err) {
      logger.error({ err }, "Error indexing channel post");
    }
  });

  // ─── Chat membership ─────────────────────────────────────────────────────────

  bot.on("new_chat_members", async (msg) => {
    try {
      const botUser = await bot.getMe();
      if (!msg.new_chat_members?.some((m) => m.id === botUser.id)) return;
      await db
        .insert(connectedChatsTable)
        .values({ chatId: BigInt(msg.chat.id), chatTitle: msg.chat.title || null, chatType: msg.chat.type })
        .onConflictDoNothing();
      if (msg.from?.id) {
        try { await bot.sendMessage(msg.from.id, "Your channel will now be updated ✅"); } catch { }
      }
    } catch (err) {
      logger.error({ err }, "Error in new_chat_members");
    }
  });

  bot.on("my_chat_member", async (update) => {
    try {
      const { chat, new_chat_member: newM, old_chat_member: oldM } = update;
      if (
        (newM?.status === "administrator" || newM?.status === "member") &&
        oldM?.status !== "administrator" &&
        oldM?.status !== "member"
      ) {
        await db
          .insert(connectedChatsTable)
          .values({ chatId: BigInt(chat.id), chatTitle: chat.title || null, chatType: chat.type })
          .onConflictDoNothing();
        if (update.from?.id) {
          try { await bot.sendMessage(update.from.id, "Your channel will now be updated ✅"); } catch { }
        }
      }
      if (newM?.status === "left" || newM?.status === "kicked") {
        await db.delete(connectedChatsTable).where(eq(connectedChatsTable.chatId, BigInt(chat.id)));
      }
    } catch (err) {
      logger.error({ err }, "Error in my_chat_member");
    }
  });

  // ─── Inline query ─────────────────────────────────────────────────────────────

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
        const conditions = q
          .split(/\s+/)
          .filter(Boolean)
          .map((w) => ilike(inlineAudioFilesTable.searchText, `%${w}%`));
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

      await bot.answerInlineQuery(query.id, results, { cache_time: 0, is_personal: false });
    } catch (err) {
      logger.error({ err }, "Error handling inline_query");
      try { await bot.answerInlineQuery(query.id, [], { cache_time: 0 }); } catch { }
    }
  });

  // ─── Payments ─────────────────────────────────────────────────────────────────

  bot.on("pre_checkout_query", async (query) => {
    try {
      await bot.answerPreCheckoutQuery(query.id, true);
    } catch (err) {
      logger.error({ err }, "Error answering pre_checkout_query");
    }
  });

  // ─── /start ──────────────────────────────────────────────────────────────────

  bot.onText(/\/start(.*)/, async (msg, match) => {
    try {
      if (msg.chat.type !== "private") return;
      const userId = msg.from!.id;
      userStates.delete(userId);
      await getOrCreateUser(userId, msg.from?.username);

      const payload = (match?.[1] || "").trim();

      if (payload.startsWith("getog_")) {
        // OG file — premium required
        const fileUniqueId = payload.slice(6);
        const premium = await isUserPremium(userId);

        if (!premium) {
          await sendPremiumPaywall(
            bot,
            msg.chat.id,
            "Downloading OG files is a CC Premium feature."
          );
          return;
        }

        const rows = await db
          .select()
          .from(botFilesTable)
          .where(eq(botFilesTable.fileUniqueId, fileUniqueId))
          .limit(1);

        if (rows.length === 0) {
          await bot.sendMessage(msg.chat.id, "Sorry, I couldn't find that file.");
          return;
        }

        await bot.sendAudio(msg.chat.id, rows[0]!.fileId);
        return;
      }

      if (payload.startsWith("get_")) {
        // Normal file — free for everyone
        const fileUniqueId = payload.slice(4);

        const rows = await db
          .select()
          .from(botFilesTable)
          .where(eq(botFilesTable.fileUniqueId, fileUniqueId))
          .limit(1);

        if (rows.length === 0) {
          await bot.sendMessage(msg.chat.id, "Sorry, I couldn't find that file.");
          return;
        }

        const file = rows[0]!;
        await bot.sendAudio(msg.chat.id, file.fileId);

        // If there's an OG version, offer it as a follow-up
        if (file.ogFileUniqueId) {
          const premium = await isUserPremium(userId);
          if (premium) {
            await bot.sendMessage(msg.chat.id, "Want the OG version?", {
              reply_markup: {
                inline_keyboard: [[
                  {
                    text: "Download OG",
                    url: `https://t.me/${BOT_USERNAME}?start=getog_${file.ogFileUniqueId}`,
                  },
                ]],
              },
            });
          } else {
            await bot.sendMessage(
              msg.chat.id,
              "Want the OG version? It's available for CC Premium members.",
              {
                reply_markup: {
                  inline_keyboard: [[
                    { text: "Cancel ❌", callback_data: "cancel_subscribe" },
                    { text: "Unlock ✨", callback_data: "do_subscribe" },
                  ]],
                },
              }
            );
          }
        }
        return;
      }

      const premium = await isUserPremium(userId);
      const user = await getOrCreateUser(userId);
      let text = START_TEXT;

      if (premium) {
        text += `\n\n✨ You have CC Premium!`;
      }

      const opts: TelegramBot.SendMessageOptions = {};
      if (premium) {
        opts.reply_markup = {
          inline_keyboard: [
            [
              { text: "Cancel Subscription ❌", callback_data: "cancel_sub" },
              {
                text: user.earlyMusicEnabled
                  ? "Disable Early Music 🔕"
                  : "Enable Early Music 🎵",
                callback_data: "toggle_early_music",
              },
            ],
          ],
        };
      }

      await bot.sendMessage(msg.chat.id, text, opts);
    } catch (err) {
      logger.error({ err }, "Error handling /start");
    }
  });

  // ─── /search ─────────────────────────────────────────────────────────────────

  bot.onText(/\/search/, async (msg) => {
    try {
      if (msg.chat.type !== "private") return;
      userStates.set(msg.from!.id, { step: "search_awaiting_query", buttons: [] });
      await bot.sendMessage(
        msg.chat.id,
        "Sure! Let me know what title you are looking for and I'll see if it's available at Comp Center 🎵"
      );
    } catch (err) {
      logger.error({ err }, "Error handling /search");
    }
  });

  // ─── /feedback ───────────────────────────────────────────────────────────────

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

  // ─── /subscribe ──────────────────────────────────────────────────────────────

  bot.onText(/\/subscribe/, async (msg) => {
    try {
      if (msg.chat.type !== "private") return;
      const userId = msg.from!.id;
      await getOrCreateUser(userId, msg.from?.username);
      const premium = await isUserPremium(userId);

      if (premium) {
        const user = await getOrCreateUser(userId);
        await bot.sendMessage(
          msg.chat.id,
          `You already have CC Premium! ✨\n\n${PREMIUM_FEATURES_TEXT}`,
          {
            reply_markup: {
              inline_keyboard: [
                [
                  { text: "Cancel Subscription ❌", callback_data: "cancel_sub" },
                  {
                    text: user.earlyMusicEnabled
                      ? "Disable Early Music 🔕"
                      : "Enable Early Music 🎵",
                    callback_data: "toggle_early_music",
                  },
                ],
              ],
            },
          }
        );
        return;
      }

      await sendPremiumPaywall(bot, msg.chat.id);
    } catch (err) {
      logger.error({ err }, "Error handling /subscribe");
    }
  });

  // ─── /tagmp3 ─────────────────────────────────────────────────────────────────

  bot.onText(/\/tagmp3/, async (msg) => {
    try {
      if (msg.chat.type !== "private") return;
      const userId = msg.from!.id;
      await getOrCreateUser(userId, msg.from?.username);
      const premium = await isUserPremium(userId);
      const remaining = premium ? Infinity : await getRemainingTags(userId);

      if (remaining <= 0) {
        await sendPremiumPaywall(
          bot,
          msg.chat.id,
          `You've used all ${DAILY_TAG_LIMIT} free tags for today.`
        );
        return;
      }

      const limitNote = premium
        ? ""
        : `\n\n_(${remaining} tag${remaining === 1 ? "" : "s"} remaining today — unlimited with CC Premium)_`;

      await bot.sendMessage(
        msg.chat.id,
        `Ok, let's get tagging! Would you like to use\n\n• Normal mode - send me as many files as you want one by one, and for each file I'll ask you for the title, artist, and cover art individually. Send /done when finished.\n• Fast mode - send me many files at once, then choose one cover art and artist name that applies to all of them (titles come from the file itself)${limitNote}`,
        {
          parse_mode: "Markdown",
          reply_markup: {
            inline_keyboard: [
              [
                { text: "Normal mode 📋", callback_data: "tag_mode_normal" },
                { text: "Fast mode ⚡️", callback_data: "tag_mode_fast" },
              ],
            ],
          },
        }
      );
    } catch (err) {
      logger.error({ err }, "Error handling /tagmp3");
    }
  });

  // ─── /freepremium (admin) ────────────────────────────────────────────────────

  bot.onText(/\/freepremium/, async (msg) => {
    try {
      if (msg.chat.type !== "private") return;
      if (msg.from?.username !== AUTHORIZED_USERNAME) {
        await bot.sendMessage(msg.chat.id, "This is not an available command.");
        return;
      }
      await bot.sendMessage(
        msg.chat.id,
        "Would you like to give or remove free premium from a user?",
        {
          reply_markup: {
            inline_keyboard: [
              [
                { text: "Give ✅", callback_data: "fp_give" },
                { text: "Remove ❌", callback_data: "fp_remove" },
              ],
            ],
          },
        }
      );
    } catch (err) {
      logger.error({ err }, "Error handling /freepremium");
    }
  });

  // ─── /publicearlymusic (admin) ───────────────────────────────────────────────

  bot.onText(/\/publicearlymusic/, async (msg) => {
    try {
      if (msg.chat.type !== "private") return;
      if (msg.from?.username !== AUTHORIZED_USERNAME) {
        await bot.sendMessage(msg.chat.id, "This is not an available command.");
        return;
      }
      userStates.set(msg.from!.id, {
        step: "earlymusic_collecting",
        buttons: [],
        earlyMusicFiles: [],
        earlyMusicAddedCount: 0,
      });
      await bot.sendMessage(
        msg.chat.id,
        "Send me the audio file(s) for early music access. When done, send /done."
      );
    } catch (err) {
      logger.error({ err }, "Error handling /publicearlymusic");
    }
  });

  // ─── /fileforward (admin) ────────────────────────────────────────────────────

  bot.onText(/\/fileforward/, async (msg) => {
    try {
      if (msg.chat.type !== "private") return;
      if (msg.from?.username !== AUTHORIZED_USERNAME) {
        await bot.sendMessage(msg.chat.id, "This is not an available command.");
        return;
      }
      userStates.set(msg.from!.id, {
        step: "fileforward_collecting",
        buttons: [],
        fileforwardFiles: [],
      });
      await bot.sendMessage(
        msg.chat.id,
        "Send me all the files you want to forward, one after the other. You can include a caption on each file. Send /done when you've sent them all."
      );
    } catch (err) {
      logger.error({ err }, "Error handling /fileforward");
    }
  });

  // ─── /publicfile (admin) ─────────────────────────────────────────────────────

  bot.onText(/\/publicfile/, async (msg) => {
    try {
      if (msg.chat.type !== "private") return;
      if (msg.from?.username !== AUTHORIZED_USERNAME) {
        await bot.sendMessage(msg.chat.id, "This is not an available command.");
        return;
      }
      userStates.set(msg.from!.id, { step: "inline_awaiting_audio", buttons: [], inlineAddedCount: 0 });
      await bot.sendMessage(
        msg.chat.id,
        "Send me the song(s) you would like to add to the inline searching 🎵\n\nYou can send as many audio files as you want. Send /done when you're finished."
      );
    } catch (err) {
      logger.error({ err }, "Error handling /publicfile");
    }
  });

  // ─── /removefile (admin) ─────────────────────────────────────────────────────

  bot.onText(/\/removefile/, async (msg) => {
    try {
      if (msg.chat.type !== "private") return;
      if (msg.from?.username !== AUTHORIZED_USERNAME) {
        await bot.sendMessage(msg.chat.id, "This is not an available command.");
        return;
      }

      const total = (await db.select().from(inlineAudioFilesTable)).length;
      if (total === 0) {
        await bot.sendMessage(msg.chat.id, "There are no songs to remove yet.");
        return;
      }

      const sent = await bot.sendMessage(
        msg.chat.id,
        `🗑️ ${total} song(s) in the library. What would you like to do?`,
        {
          reply_markup: {
            inline_keyboard: [
              [
                { text: "📋 Browse all", callback_data: "rm_browse" },
                { text: "🔍 Search for a file", callback_data: "rm_search" },
              ],
              [{ text: "🗑️ Delete all", callback_data: "rm_deleteall_confirm" }],
            ],
          },
        }
      );

      userStates.set(msg.from!.id, {
        step: "removefile_browsing",
        buttons: [],
        removeFilePage: 0,
        removeFileMessageId: sent.message_id,
      });
    } catch (err) {
      logger.error({ err }, "Error handling /removefile");
    }
  });

  // ─── /done ───────────────────────────────────────────────────────────────────

  bot.onText(/\/done/, async (msg) => {
    try {
      if (msg.chat.type !== "private") return;
      const userId = msg.from!.id;
      const state = userStates.get(userId);
      if (!state) return;

      if (state.step === "tagmp3_awaiting_file_normal") {
        userStates.delete(userId);
        await safeSendMessage(bot, msg.chat.id, "All done! Your files have been tagged.");

      } else if (state.step === "inline_awaiting_audio") {
        const total = state.inlineAddedCount || 0;
        userStates.delete(userId);
        await safeSendMessage(
          bot,
          msg.chat.id,
          `✅ Done! Added ${total} song${total === 1 ? "" : "s"} — all are now searchable inline.`
        );

      } else if (state.step === "tagmp3_collecting_fast") {
        if (!state.tagFiles || state.tagFiles.length === 0) {
          userStates.delete(userId);
          await bot.sendMessage(msg.chat.id, "No files were sent. Cancelled.");
          return;
        }
        state.step = "tagmp3_awaiting_coverart_fast";
        await bot.sendMessage(
          msg.chat.id,
          `Got ${state.tagFiles.length} file${state.tagFiles.length === 1 ? "" : "s"}! Now send me the cover art (send a photo).`
        );

      } else if (state.step === "fileforward_collecting") {
        const files = state.fileforwardFiles || [];
        if (files.length === 0) {
          userStates.delete(userId);
          await bot.sendMessage(msg.chat.id, "No files were sent. Cancelled.");
          return;
        }
        state.fileforwardCurrentOgIndex = 0;
        state.step = "fileforward_awaiting_og";
        const first = files[0]!;
        const label = first.normal.title || first.normal.fileName || `File 1`;
        await bot.sendMessage(
          msg.chat.id,
          `Got ${files.length} file${files.length === 1 ? "" : "s"}! Now send me the OG file for:\n\n"${label}" (1/${files.length})`
        );

      } else if (state.step === "earlymusic_collecting") {
        await broadcastEarlyMusic(bot, token, msg.chat.id, userId, state);
      }
    } catch (err) {
      logger.error({ err }, "Error handling /done");
    }
  });

  // ─── /publicforward (admin) ──────────────────────────────────────────────────

  bot.onText(/\/publicforward/, async (msg) => {
    try {
      if (msg.chat.type !== "private") return;
      if (msg.from?.username !== AUTHORIZED_USERNAME) {
        await bot.sendMessage(msg.chat.id, "This is not an available command.");
        return;
      }
      userStates.set(msg.from!.id, { step: "broadcast_awaiting_message", buttons: [] });
      await bot.sendMessage(
        msg.chat.id,
        "Send me what you would like to send to your channels."
      );
    } catch (err) {
      logger.error({ err }, "Error handling /publicforward");
    }
  });

  // ─── Callback query ──────────────────────────────────────────────────────────

  bot.on("callback_query", async (query) => {
    try {
      if (!query.message || !query.from) return;
      await bot.answerCallbackQuery(query.id);

      const userId = query.from.id;
      const state = userStates.get(userId);
      const chatId = query.message.chat.id;
      const msgId = query.message.message_id;

      // ── Premium / subscribe ──────────────────────────────────────────────────

      if (query.data === "do_subscribe") {
        try {
          await bot.deleteMessage(chatId, msgId);
        } catch { }
        await bot.sendInvoice(
          chatId,
          "CC Premium — 1 Year",
          PREMIUM_FEATURES_TEXT,
          "premium_1yr",
          "",
          "XTR",
          [{ label: "CC Premium (1 year)", amount: PREMIUM_YEARLY_STARS }]
        );
        return;

      } else if (query.data === "cancel_subscribe") {
        try { await bot.deleteMessage(chatId, msgId); } catch { }
        await bot.sendMessage(chatId, "No problem!");
        return;

      } else if (query.data === "cancel_sub") {
        const rows = await db.select().from(usersTable).where(eq(usersTable.userId, userId)).limit(1);
        if (rows.length > 0 && rows[0]!.premiumExpiry) {
          const expiry = rows[0]!.premiumExpiry!.toLocaleDateString("en-GB", {
            day: "numeric", month: "long", year: "numeric",
          });
          await db.update(usersTable).set({ subscriptionCancelled: true }).where(eq(usersTable.userId, userId));
          await bot.sendMessage(chatId, `Your subscription is cancelled. You will still have premium up to ${expiry}.`);
        } else {
          await db.update(usersTable).set({ isPremium: false, premiumFree: false }).where(eq(usersTable.userId, userId));
          await bot.sendMessage(chatId, "Your premium has been removed.");
        }
        return;

      } else if (query.data === "toggle_early_music") {
        const rows = await db.select().from(usersTable).where(eq(usersTable.userId, userId)).limit(1);
        const current = rows[0]?.earlyMusicEnabled ?? false;
        await db.update(usersTable).set({ earlyMusicEnabled: !current }).where(eq(usersTable.userId, userId));
        await bot.sendMessage(
          chatId,
          current
            ? "Early music access disabled. You won't receive early songs."
            : "Early music access enabled! You'll now receive new songs before they're publicly posted 🎵"
        );
        return;
      }

      // ── Tagmp3 mode selection ────────────────────────────────────────────────

      if (query.data === "tag_mode_normal") {
        userStates.set(userId, { step: "tagmp3_awaiting_file_normal", buttons: [], tagFiles: [] });
        try { await bot.deleteMessage(chatId, msgId); } catch { }
        await bot.sendMessage(chatId, "Send me the audio file you want to tag.");
        return;

      } else if (query.data === "tag_mode_fast") {
        userStates.set(userId, {
          step: "tagmp3_collecting_fast",
          buttons: [],
          tagFiles: [],
        });
        try { await bot.deleteMessage(chatId, msgId); } catch { }
        await bot.sendMessage(
          chatId,
          "Send me all the audio files you want to tag, one after the other. Send /done when you're finished."
        );
        return;
      }

      // ── Free premium ─────────────────────────────────────────────────────────

      if (query.data === "fp_give") {
        userStates.set(userId, { step: "freepremium_give_awaiting_user", buttons: [], freepremiumAction: "give" });
        await bot.sendMessage(chatId, "Who would you like to give free premium to? Send their @username or Telegram ID.");
        return;

      } else if (query.data === "fp_remove") {
        userStates.set(userId, { step: "freepremium_remove_awaiting_user", buttons: [], freepremiumAction: "remove" });
        await bot.sendMessage(chatId, "Who would you like to remove free premium from? Send their @username or Telegram ID.");
        return;

      } else if (query.data === "fp_confirm_give") {
        if (!state || !state.freepremiumTargetId) return;
        const expiry = null;
        await db
          .insert(usersTable)
          .values({ userId: state.freepremiumTargetId, isPremium: true, premiumFree: true })
          .onConflictDoUpdate({
            target: usersTable.userId,
            set: { isPremium: true, premiumFree: true, premiumExpiry: expiry },
          });
        const name = state.freepremiumTargetUsername ? `@${state.freepremiumTargetUsername}` : `User ${state.freepremiumTargetId}`;
        await bot.sendMessage(chatId, `✅ Free premium given to ${name}.`);
        try {
          await bot.sendMessage(
            state.freepremiumTargetId,
            `🎉 You've been given free CC Premium!\n\nHere's what you can do:\n${PREMIUM_FEATURES_TEXT}`,
            {
              reply_markup: {
                inline_keyboard: [
                  [{ text: "Enable Early Music 🎵", callback_data: "toggle_early_music" }],
                ],
              },
            }
          );
        } catch {
          await bot.sendMessage(chatId, "(Couldn't notify them — they may not have started the bot yet.)");
        }
        userStates.delete(userId);
        return;

      } else if (query.data === "fp_cancel") {
        userStates.delete(userId);
        await bot.sendMessage(chatId, "Cancelled.");
        return;
      }

      // ── Feedback ─────────────────────────────────────────────────────────────

      if (query.data === "feedback_send") {
        if (!state?.feedbackText) return;
        const displayName = query.from.username
          ? `@${query.from.username}`
          : query.from.first_name || `User #${query.from.id}`;
        try {
          const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              chat_id: "@complaintsrequests",
              text: `📩 *New feedback from ${displayName}:*\n\n${state.feedbackText}`,
              parse_mode: "Markdown",
            }),
          });
          if (!res.ok) throw new Error(await res.text());
        } catch {
          await bot.sendMessage(chatId, "⚠️ Couldn't reach the admin group right now. Please try again later.");
          userStates.delete(userId);
          return;
        }
        await bot.sendMessage(chatId, "✅ Your feedback has been sent to an admin. Thank you!");
        userStates.delete(userId);
        return;

      } else if (query.data === "feedback_cancel") {
        userStates.delete(userId);
        await bot.sendMessage(chatId, "No problem! If you'd like to try again just send /feedback");
        return;
      }

      if (!state) return;

      // ── Broadcast buttons ────────────────────────────────────────────────────

      if (query.data === "skip_buttons" || query.data === "done_buttons") {
        await showChatPicker(bot, chatId, state);

      } else if (query.data === "add_button") {
        state.step = "broadcast_awaiting_button_text";
        await bot.sendMessage(chatId, "Send text for your button (or /back to go back):");

      } else if (query.data === "cancel_broadcast") {
        userStates.delete(userId);
        try { await bot.deleteMessage(chatId, msgId); } catch { }
        await bot.sendMessage(chatId, "Broadcast cancelled.");

      } else if (query.data === "send_selected") {
        if (!state.selectedChatIds || state.selectedChatIds.size === 0) {
          await bot.answerCallbackQuery(query.id, { text: "Please select at least one chat first." });
          return;
        }
        try { await bot.deleteMessage(chatId, msgId); } catch { }
        if (state.step === "fileforward_selecting_chats") {
          await sendFileForwardToChats(bot, token, state, chatId, state.selectedChatIds);
        } else {
          await sendToSelectedChats(bot, token, state, chatId, state.selectedChatIds);
        }
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
            { chat_id: chatId, message_id: state.selectionMessageId }
          );
        } catch { }

      // ── Remove file ──────────────────────────────────────────────────────────

      } else if (query.data === "rm_browse") {
        const { keyboard, total } = await buildRemoveFileKeyboard(0);
        state.step = "removefile_browsing";
        state.removeFilePage = 0;
        try {
          await bot.editMessageText(
            `🗑️ Tap a song to remove it from inline search.\n\n${total} song(s) total.`,
            { chat_id: chatId, message_id: msgId, reply_markup: { inline_keyboard: keyboard } }
          );
        } catch { }

      } else if (query.data === "rm_search") {
        state.step = "removefile_searching";
        try { await bot.deleteMessage(chatId, msgId); } catch { }
        await bot.sendMessage(chatId, "Type the song name to search for:");

      } else if (query.data === "rm_deleteall_confirm") {
        const total = (await db.select().from(inlineAudioFilesTable)).length;
        try {
          await bot.editMessageText(
            `⚠️ Are you sure you want to delete all ${total} songs? This cannot be undone.`,
            {
              chat_id: chatId, message_id: msgId,
              reply_markup: {
                inline_keyboard: [
                  [
                    { text: "Yes, delete all ❌", callback_data: "rm_deleteall_do" },
                    { text: "No, keep them ✅", callback_data: "rm_done" },
                  ],
                ],
              },
            }
          );
        } catch { }

      } else if (query.data === "rm_deleteall_do") {
        await db.delete(inlineAudioFilesTable);
        userStates.delete(userId);
        try {
          await bot.editMessageText("✅ All songs deleted.", { chat_id: chatId, message_id: msgId });
        } catch { }

      } else if (query.data === "rm_noop") {
        return;

      } else if (query.data === "rm_done") {
        userStates.delete(userId);
        try {
          await bot.editMessageText("✅ Done.", { chat_id: chatId, message_id: msgId });
        } catch { }

      } else if (query.data?.startsWith("rm_page_")) {
        const newPage = parseInt(query.data.slice("rm_page_".length), 10);
        if (Number.isNaN(newPage)) return;
        const { keyboard, total } = await buildRemoveFileKeyboard(newPage);
        state.removeFilePage = newPage;
        try {
          await bot.editMessageText(
            `🗑️ Tap a song to remove it from inline search.\n\n${total} song(s) total.`,
            { chat_id: chatId, message_id: msgId, reply_markup: { inline_keyboard: keyboard } }
          );
        } catch { }

      } else if (query.data?.startsWith("rm_")) {
        const id = parseInt(query.data.slice("rm_".length), 10);
        if (Number.isNaN(id)) return;
        const existing = await db
          .select()
          .from(inlineAudioFilesTable)
          .where(eq(inlineAudioFilesTable.id, id))
          .limit(1);

        if (existing.length === 0) {
          await bot.answerCallbackQuery(query.id, { text: "Already removed." });
        } else {
          await db.delete(inlineAudioFilesTable).where(eq(inlineAudioFilesTable.id, id));
          await bot.answerCallbackQuery(query.id, { text: `Removed: ${formatSongLabel(existing[0]!)}` });
        }

        const currentPage = state.removeFilePage ?? 0;
        const { keyboard, total, pageCount } = await buildRemoveFileKeyboard(currentPage);
        if (total === 0) {
          userStates.delete(userId);
          try { await bot.editMessageText("✅ All songs removed.", { chat_id: chatId, message_id: msgId }); } catch { }
          return;
        }
        const safePage = Math.min(currentPage, pageCount - 1);
        state.removeFilePage = safePage;
        try {
          await bot.editMessageText(
            `🗑️ Tap a song to remove it from inline search.\n\n${total} song(s) total.`,
            { chat_id: chatId, message_id: msgId, reply_markup: { inline_keyboard: keyboard } }
          );
        } catch { }
      }
    } catch (err) {
      logger.error({ err }, "Error handling callback_query");
    }
  });

  // ─── Message handler ─────────────────────────────────────────────────────────

  bot.on("message", async (msg) => {
    try {
      if (msg.chat.type !== "private" || !msg.from) return;

      // Successful payment
      if (msg.successful_payment) {
        const userId = msg.from.id;
        if (msg.successful_payment.invoice_payload === "premium_1yr") {
          const expiry = new Date();
          expiry.setFullYear(expiry.getFullYear() + 1);
          await db
            .insert(usersTable)
            .values({ userId, isPremium: true, premiumExpiry: expiry })
            .onConflictDoUpdate({
              target: usersTable.userId,
              set: { isPremium: true, premiumExpiry: expiry, subscriptionCancelled: false },
            });
          await bot.sendMessage(
            msg.chat.id,
            `🎉 Thank you for subscribing to CC Premium!\n\nHere's what you can do:\n${PREMIUM_FEATURES_TEXT}`,
            {
              reply_markup: {
                inline_keyboard: [
                  [
                    { text: "Cancel Subscription ❌", callback_data: "cancel_sub" },
                    { text: "Enable Early Music 🎵", callback_data: "toggle_early_music" },
                  ],
                ],
              },
            }
          );
        }
        return;
      }

      // Skip commands handled by onText
      if (
        msg.text?.startsWith("/start") ||
        msg.text?.startsWith("/search") ||
        msg.text?.startsWith("/feedback") ||
        msg.text?.startsWith("/publicforward") ||
        msg.text?.startsWith("/publicfile") ||
        msg.text?.startsWith("/removefile") ||
        msg.text?.startsWith("/done") ||
        msg.text?.startsWith("/tagmp3") ||
        msg.text?.startsWith("/freepremium") ||
        msg.text?.startsWith("/publicearlymusic") ||
        msg.text?.startsWith("/subscribe") ||
        msg.text?.startsWith("/fileforward")
      ) return;

      const userId = msg.from.id;
      const state = userStates.get(userId);

      // ── File forward collection ──────────────────────────────────────────────

      if (state?.step === "fileforward_collecting") {
        if (!msg.audio) {
          await safeSendMessage(bot, msg.chat.id, "Please send audio files, or /done when finished.");
          return;
        }
        state.fileforwardFiles = state.fileforwardFiles || [];
        state.fileforwardFiles.push({
          normal: {
            fileId: msg.audio.file_id,
            fileUniqueId: msg.audio.file_unique_id,
            title: msg.audio.title,
            performer: msg.audio.performer,
            fileName: msg.audio.file_name,
          },
          caption: msg.caption || undefined,
        });
        return;
      }

      if (state?.step === "fileforward_awaiting_og") {
        if (!msg.audio) {
          await safeSendMessage(bot, msg.chat.id, "Please send an audio file for the OG version.");
          return;
        }
        const files = state.fileforwardFiles!;
        const idx = state.fileforwardCurrentOgIndex!;
        files[idx]!.og = {
          fileId: msg.audio.file_id,
          fileUniqueId: msg.audio.file_unique_id,
          title: msg.audio.title,
          performer: msg.audio.performer,
          fileName: msg.audio.file_name,
        };
        const nextIdx = idx + 1;
        if (nextIdx < files.length) {
          state.fileforwardCurrentOgIndex = nextIdx;
          const next = files[nextIdx]!;
          const label = next.normal.title || next.normal.fileName || `File ${nextIdx + 1}`;
          await bot.sendMessage(
            msg.chat.id,
            `Got it! Now send me the OG file for:\n\n"${label}" (${nextIdx + 1}/${files.length})`
          );
        } else {
          await showChatPicker(bot, msg.chat.id, state, "fileforward_selecting_chats");
        }
        return;
      }

      // ── Inline audio collection ──────────────────────────────────────────────

      if (state?.step === "inline_awaiting_audio") {
        if (msg.audio) {
          const audio = msg.audio;
          const searchText = [audio.title, audio.performer, audio.file_name, msg.caption]
            .filter(Boolean)
            .join(" ");
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
                  addedAt: new Date(),
                },
              });
            state.inlineAddedCount = (state.inlineAddedCount || 0) + 1;
            if (state.inlineAddedCount % 5 === 0) {
              await safeSendMessage(
                bot,
                msg.chat.id,
                `✅ Added ${state.inlineAddedCount} so far. Keep sending, or /done when finished.`
              );
            }
          } catch (err) {
            logger.error({ err }, "Error saving inline audio");
          }
        } else {
          await safeSendMessage(bot, msg.chat.id, "Please send an audio file, or /done when finished.");
        }
        return;
      }

      // ── Early music collection ───────────────────────────────────────────────

      if (state?.step === "earlymusic_collecting") {
        if (msg.audio) {
          const audio = msg.audio;
          state.earlyMusicFiles = state.earlyMusicFiles || [];
          state.earlyMusicFiles.push({
            fileId: audio.file_id,
            fileUniqueId: audio.file_unique_id,
            title: audio.title,
            performer: audio.performer,
            fileName: audio.file_name,
          });
          state.earlyMusicAddedCount = (state.earlyMusicAddedCount || 0) + 1;
          if (state.earlyMusicAddedCount % 5 === 0) {
            await safeSendMessage(bot, msg.chat.id, `🎵 ${state.earlyMusicAddedCount} files queued. Keep sending or /done.`);
          }
        } else {
          await safeSendMessage(bot, msg.chat.id, "Please send an audio file, or /done to broadcast.");
        }
        return;
      }

      // ── Remove file search ───────────────────────────────────────────────────

      if (state?.step === "removefile_searching") {
        const q = msg.text?.trim() || "";
        const words = q.split(/\s+/).filter(Boolean);
        const conditions = words.map((w) => ilike(inlineAudioFilesTable.searchText, `%${w}%`));
        const matches =
          conditions.length > 0
            ? await db.select().from(inlineAudioFilesTable).where(and(...conditions)).limit(20)
            : [];

        if (matches.length === 0) {
          await bot.sendMessage(msg.chat.id, `No songs found for "${q}". Try a different search.`);
          return;
        }

        const keyboard: TelegramBot.InlineKeyboardButton[][] = matches.map((r) => [
          {
            text: `❌ ${formatSongLabel(r)}`.slice(0, 60),
            callback_data: `rm_${r.id}`,
          },
        ]);
        keyboard.push([{ text: "Done ✅", callback_data: "rm_done" }]);

        const sent = await bot.sendMessage(
          msg.chat.id,
          `Found ${matches.length} result(s). Tap to remove:`,
          { reply_markup: { inline_keyboard: keyboard } }
        );
        state.step = "removefile_browsing";
        state.removeFileMessageId = sent.message_id;
        return;
      }

      // ── Tagmp3 — normal mode: awaiting file ──────────────────────────────────

      if (state?.step === "tagmp3_awaiting_file_normal") {
        if (!msg.audio) {
          await safeSendMessage(bot, msg.chat.id, "Please send an audio file to tag.");
          return;
        }
        const audio = msg.audio;
        state.tagCurrentFile = {
          fileId: audio.file_id,
          fileUniqueId: audio.file_unique_id,
          title: audio.title,
          performer: audio.performer,
          fileName: audio.file_name,
        };
        state.step = "tagmp3_awaiting_title_normal";
        const currentTitle = audio.title || audio.file_name || "";
        await bot.sendMessage(
          msg.chat.id,
          `What should the song title be?${currentTitle ? ` (current: "${cleanTitle(currentTitle)}")` : ""}\n\nSend the title, or "skip" to keep it as is.`
        );
        return;
      }

      // ── Tagmp3 — normal mode: awaiting title ─────────────────────────────────

      if (state?.step === "tagmp3_awaiting_title_normal") {
        const raw = (msg.text || "").trim();
        if (raw.toLowerCase() === "skip") {
          const current = state.tagCurrentFile;
          state.tagTitle = cleanTitle(current?.title || current?.fileName || "");
        } else {
          state.tagTitle = raw;
        }
        state.step = "tagmp3_awaiting_artist_normal";
        const currentArtist = state.tagCurrentFile?.performer || "";
        await bot.sendMessage(
          msg.chat.id,
          `What should the artist name be?${currentArtist ? ` (current: "${currentArtist}")` : ""}\n\nSend the artist, or "skip" to keep it as is.`
        );
        return;
      }

      // ── Tagmp3 — normal mode: awaiting artist ────────────────────────────────

      if (state?.step === "tagmp3_awaiting_artist_normal") {
        const raw = (msg.text || "").trim();
        if (raw.toLowerCase() === "skip") {
          state.tagArtist = state.tagCurrentFile?.performer || "";
        } else {
          state.tagArtist = raw;
        }
        state.step = "tagmp3_awaiting_coverart_normal";
        await bot.sendMessage(msg.chat.id, "Now send the cover art (send a photo).");
        return;
      }

      // ── Tagmp3 — normal mode: awaiting cover art ─────────────────────────────

      if (state?.step === "tagmp3_awaiting_coverart_normal") {
        const photo = msg.photo;
        if (!photo || photo.length === 0) {
          await safeSendMessage(bot, msg.chat.id, "Please send a photo as the cover art.");
          return;
        }
        const bestPhoto = photo[photo.length - 1]!;
        state.tagCoverArtFileId = bestPhoto.file_id;

        await processTagNormal(bot, token, msg.chat.id, userId, state);
        return;
      }

      // ── Tagmp3 — fast mode: collecting files ─────────────────────────────────

      if (state?.step === "tagmp3_collecting_fast") {
        if (!msg.audio) {
          await safeSendMessage(bot, msg.chat.id, "Please send audio files, or /done when finished.");
          return;
        }
        state.tagFiles = state.tagFiles || [];
        state.tagFiles.push({
          fileId: msg.audio.file_id,
          fileUniqueId: msg.audio.file_unique_id,
          title: msg.audio.title,
          performer: msg.audio.performer,
          fileName: msg.audio.file_name,
          duration: msg.audio.duration,
        });
        return;
      }

      // ── Tagmp3 — fast mode: awaiting cover art ───────────────────────────────

      if (state?.step === "tagmp3_awaiting_coverart_fast") {
        const photo = msg.photo;
        if (!photo || photo.length === 0) {
          await safeSendMessage(bot, msg.chat.id, "Please send a photo as the cover art.");
          return;
        }
        const bestPhoto = photo[photo.length - 1]!;
        state.tagCoverArtFileId = bestPhoto.file_id;
        state.step = "tagmp3_awaiting_artist_fast";
        await bot.sendMessage(msg.chat.id, "What should the artist name be for all these files?");
        return;
      }

      // ── Tagmp3 — fast mode: awaiting artist ──────────────────────────────────

      if (state?.step === "tagmp3_awaiting_artist_fast") {
        state.tagArtist = (msg.text || "").trim();
        if (!state.tagArtist) {
          await safeSendMessage(bot, msg.chat.id, "Please send an artist name.");
          return;
        }
        await processTagFast(bot, token, msg.chat.id, userId, state);
        return;
      }

      // ── Free premium: awaiting target user ───────────────────────────────────

      if (state?.step === "freepremium_give_awaiting_user") {
        const input = (msg.text || "").trim().replace(/^@/, "");
        const numId = parseInt(input, 10);

        let targetId: number | null = null;
        let targetUsername: string | null = null;

        if (!isNaN(numId)) {
          targetId = numId;
        } else {
          const found = await db
            .select()
            .from(usersTable)
            .where(eq(usersTable.username, input))
            .limit(1);
          if (found.length > 0) {
            targetId = found[0]!.userId;
            targetUsername = found[0]!.username;
          }
        }

        if (!targetId) {
          await bot.sendMessage(
            msg.chat.id,
            `Couldn't find user "${input}". They must have started the bot at least once, or send their numeric Telegram ID.`
          );
          return;
        }

        state.freepremiumTargetId = targetId;
        state.freepremiumTargetUsername = targetUsername || input;
        state.step = "freepremium_give_confirm";

        const name = targetUsername ? `@${targetUsername}` : `User ${targetId}`;
        await bot.sendMessage(
          msg.chat.id,
          `Are you sure you want to give ${name} free CC Premium?`,
          {
            reply_markup: {
              inline_keyboard: [
                [
                  { text: "Gift 🎁", callback_data: "fp_confirm_give" },
                  { text: "Cancel ❌", callback_data: "fp_cancel" },
                ],
              ],
            },
          }
        );
        return;
      }

      if (state?.step === "freepremium_remove_awaiting_user") {
        const input = (msg.text || "").trim().replace(/^@/, "");
        const numId = parseInt(input, 10);

        let targetId: number | null = null;
        let targetUsername: string | null = null;

        if (!isNaN(numId)) {
          targetId = numId;
        } else {
          const found = await db
            .select()
            .from(usersTable)
            .where(eq(usersTable.username, input))
            .limit(1);
          if (found.length > 0) {
            targetId = found[0]!.userId;
            targetUsername = found[0]!.username;
          }
        }

        if (!targetId) {
          await bot.sendMessage(
            msg.chat.id,
            `Couldn't find user "${input}".`
          );
          return;
        }

        await db
          .update(usersTable)
          .set({ isPremium: false, premiumFree: false, premiumExpiry: null })
          .where(eq(usersTable.userId, targetId));

        const name = targetUsername ? `@${targetUsername}` : `User ${targetId}`;
        await bot.sendMessage(msg.chat.id, `✅ Premium removed from ${name}.`);
        try {
          await bot.sendMessage(targetId, "Your CC Premium has been removed by an admin.");
        } catch { }
        userStates.delete(userId);
        return;
      }

      if (state?.step === "freepremium_give_confirm") {
        return;
      }

      // ── Search ───────────────────────────────────────────────────────────────

      if (state?.step === "search_awaiting_query") {
        const query = (msg.text || "").trim();
        userStates.delete(userId);

        const searchingMsg = await bot.sendMessage(msg.chat.id, `🔍 Searching for "${query}"...`);
        const words = query.split(/\s+/).filter(Boolean);
        const conditions = words.map((w) =>
          ilike(inlineAudioFilesTable.searchText, `%${w}%`)
        );
        const rows =
          conditions.length > 0
            ? await db
                .select()
                .from(inlineAudioFilesTable)
                .where(and(...conditions))
                .orderBy(desc(inlineAudioFilesTable.addedAt))
                .limit(10)
            : [];

        try { await bot.deleteMessage(msg.chat.id, searchingMsg.message_id); } catch { }

        if (rows.length === 0) {
          await bot.sendMessage(
            msg.chat.id,
            `sorry gurl couldn't find any results for "${query}" 😔`
          );
        } else {
          await bot.sendMessage(msg.chat.id, `🎵 Results for "${query}":`);
          for (const row of rows) {
            try {
              await bot.sendAudio(msg.chat.id, row.fileId);
            } catch (e) {
              logger.warn({ e }, "Could not send audio in search result");
            }
          }
        }
        return;
      }

      // ── Feedback ─────────────────────────────────────────────────────────────

      if (state?.step === "feedback_awaiting_text") {
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
        return;
      }

      // ── Broadcast message flow ────────────────────────────────────────────────

      if (state?.step === "broadcast_awaiting_message") {
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
        return;
      }

      if (state?.step === "broadcast_awaiting_button_text") {
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
        return;
      }

      if (state?.step === "broadcast_awaiting_button_url") {
        const url = msg.text || "";
        state.buttons.push({ text: state.currentButtonText || "Button", url });
        state.currentButtonText = undefined;
        state.step = "broadcast_awaiting_button_choice";
        const currentButtons = state.buttons.map((b, i) => `${i + 1}. ${b.text} → ${b.url}`).join("\n");
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
        return;
      }

      if (!state) {
        await safeSendMessage(bot, msg.chat.id, HELP_TEXT);
      }
    } catch (err) {
      logger.error({ err }, "Error handling message");
    }
  });

  return bot;
}

// ─── Tagmp3 processing ────────────────────────────────────────────────────────

async function processTagNormal(
  bot: TelegramBot,
  token: string,
  chatId: number,
  userId: number,
  state: UserState
) {
  const file = state.tagCurrentFile!;
  const premium = await isUserPremium(userId);
  const remaining = premium ? Infinity : await getRemainingTags(userId);

  if (remaining <= 0) {
    await sendPremiumPaywall(bot, chatId, `You've used all ${DAILY_TAG_LIMIT} free tags for today.`);
    userStates.delete(userId);
    return;
  }

  const processingMsg = await safeSendMessage(bot, chatId, "⏳ Tagging your file...");

  try {
    const [audioBuffer, coverBuffer] = await Promise.all([
      downloadTelegramFile(token, file.fileId),
      downloadTelegramFile(token, state.tagCoverArtFileId!),
    ]);

    const title = state.tagTitle || cleanTitle(file.title || file.fileName || "Unknown");
    const artist = state.tagArtist || file.performer || "";

    const tagged = NodeID3.write(
      {
        title,
        artist,
        image: {
          mime: "image/jpeg",
          type: { id: 3, name: "Front Cover" },
          description: "Cover Art",
          imageBuffer: coverBuffer,
        },
      },
      audioBuffer
    );

    if (!tagged) throw new Error("node-id3 write returned false");

    const fileName = `${artist ? artist + " - " : ""}${title}.mp3`;
    await bot.sendAudio(chatId, tagged as Buffer, { caption: `✅ Tagged: ${fileName}` }, {
      filename: fileName,
      contentType: "audio/mpeg",
    });

    if (!premium) await incrementTagCount(userId);

    if (processingMsg) {
      try { await bot.deleteMessage(chatId, processingMsg.message_id); } catch { }
    }

    // Ask for next file
    state.step = "tagmp3_awaiting_file_normal";
    state.tagCurrentFile = undefined;
    state.tagTitle = undefined;
    state.tagArtist = undefined;

    const newRemaining = premium ? Infinity : await getRemainingTags(userId);
    const limitNote = premium ? "" : ` (${newRemaining} tag${newRemaining === 1 ? "" : "s"} remaining today)`;
    await safeSendMessage(
      bot,
      chatId,
      `Done!${limitNote} Send another file to tag, or /done when finished.`
    );
  } catch (err) {
    logger.error({ err }, "Error in processTagNormal");
    if (processingMsg) {
      try { await bot.deleteMessage(chatId, processingMsg.message_id); } catch { }
    }
    await safeSendMessage(bot, chatId, "⚠️ Something went wrong tagging that file. Please try again.");
    state.step = "tagmp3_awaiting_file_normal";
    state.tagCurrentFile = undefined;
  }
}

async function processTagFast(
  bot: TelegramBot,
  token: string,
  chatId: number,
  userId: number,
  state: UserState
) {
  const files = state.tagFiles || [];
  const premium = await isUserPremium(userId);

  const processingMsg = await safeSendMessage(
    bot,
    chatId,
    `⏳ Tagging ${files.length} file${files.length === 1 ? "" : "s"}...`
  );

  let coverBuffer: Buffer;
  try {
    coverBuffer = await downloadTelegramFile(token, state.tagCoverArtFileId!);
  } catch {
    if (processingMsg) {
      try { await bot.deleteMessage(chatId, processingMsg.message_id); } catch { }
    }
    await safeSendMessage(bot, chatId, "⚠️ Couldn't download the cover art. Please try again.");
    userStates.delete(userId);
    return;
  }

  let successCount = 0;
  let failCount = 0;

  for (const file of files) {
    if (!premium) {
      const remaining = await getRemainingTags(userId);
      if (remaining <= 0) {
        await safeSendMessage(
          bot,
          chatId,
          `⚠️ You've hit your daily tag limit (${DAILY_TAG_LIMIT}/day). Upgrade to CC Premium for unlimited tagging!\n\n${successCount} file${successCount === 1 ? "" : "s"} tagged before limit.`
        );
        break;
      }
    }

    try {
      const audioBuffer = await downloadTelegramFile(token, file.fileId);
      const title = cleanTitle(file.title || file.fileName || "Unknown");
      const artist = state.tagArtist!;

      const tagged = NodeID3.write(
        {
          title,
          artist,
          image: {
            mime: "image/jpeg",
            type: { id: 3, name: "Front Cover" },
            description: "Cover Art",
            imageBuffer: coverBuffer,
          },
        },
        audioBuffer
      );

      if (!tagged) throw new Error("node-id3 write returned false");

      const fileName = `${artist} - ${title}.mp3`;
      await bot.sendAudio(chatId, tagged as Buffer, {}, { filename: fileName, contentType: "audio/mpeg" });

      if (!premium) await incrementTagCount(userId);
      successCount++;
    } catch (err) {
      logger.error({ err }, "Error tagging file in fast mode");
      failCount++;
    }
  }

  if (processingMsg) {
    try { await bot.deleteMessage(chatId, processingMsg.message_id); } catch { }
  }

  const parts = [`✅ Done! Tagged ${successCount} file${successCount === 1 ? "" : "s"}.`];
  if (failCount > 0) parts.push(`${failCount} failed.`);
  await safeSendMessage(bot, chatId, parts.join(" "));
  userStates.delete(userId);
}

// ─── Early music broadcast ────────────────────────────────────────────────────

async function broadcastEarlyMusic(
  bot: TelegramBot,
  _token: string,
  adminChatId: number,
  adminUserId: number,
  state: UserState
) {
  const files = state.earlyMusicFiles || [];
  if (files.length === 0) {
    userStates.delete(adminUserId);
    await bot.sendMessage(adminChatId, "No files to broadcast.");
    return;
  }

  const recipients = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.earlyMusicEnabled, true));

  const premiumRecipients = recipients.filter((u) => {
    if (!u.isPremium) return false;
    if (!u.premiumExpiry) return true;
    return u.premiumExpiry > new Date();
  });

  if (premiumRecipients.length === 0) {
    userStates.delete(adminUserId);
    await bot.sendMessage(adminChatId, "No premium users have early music enabled yet.");
    return;
  }

  const processingMsg = await bot.sendMessage(
    adminChatId,
    `📤 Sending ${files.length} file${files.length === 1 ? "" : "s"} to ${premiumRecipients.length} subscriber${premiumRecipients.length === 1 ? "" : "s"}...`
  );

  let successCount = 0;

  for (const user of premiumRecipients) {
    for (const file of files) {
      try {
        await bot.sendAudio(user.userId, file.fileId);
        successCount++;
        await new Promise((r) => setTimeout(r, 200));
      } catch (err) {
        logger.warn({ err, userId: user.userId }, "Failed to send early music to user");
      }
    }
  }

  try { await bot.deleteMessage(adminChatId, processingMsg.message_id); } catch { }
  userStates.delete(adminUserId);
  await bot.sendMessage(
    adminChatId,
    `✅ Sent ${files.length} file${files.length === 1 ? "" : "s"} to ${premiumRecipients.length} subscriber${premiumRecipients.length === 1 ? "" : "s"}.`
  );
}

// ─── Broadcast helpers ────────────────────────────────────────────────────────

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
    return { ok: false, banned: isBanError(res.status, text), error: `${res.status} ${text}` };
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

  let replyMarkup: { inline_keyboard: TelegramBot.InlineKeyboardButton[][] } | undefined;

  if (state.buttons.length > 0) {
    replyMarkup = { inline_keyboard: state.buttons.map((b) => [{ text: b.text, url: b.url }]) };
  }

  let successCount = 0;
  let failCount = 0;
  let removedCount = 0;

  for (const chatId of selectedIds) {
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

// ─── File forward (normal + OG with download buttons) ─────────────────────────

async function sendFileForwardToChats(
  bot: TelegramBot,
  token: string,
  state: UserState,
  adminChatId: number,
  selectedIds: Set<string>
) {
  const pairs = state.fileforwardFiles!;

  // Save all files to botFiles first
  for (const pair of pairs) {
    try {
      await db
        .insert(botFilesTable)
        .values({
          fileUniqueId: pair.normal.fileUniqueId,
          fileId: pair.normal.fileId,
          title: pair.normal.title || null,
          performer: pair.normal.performer || null,
          fileName: pair.normal.fileName || null,
          ogFileUniqueId: pair.og?.fileUniqueId || null,
          ogFileId: pair.og?.fileId || null,
        })
        .onConflictDoUpdate({
          target: botFilesTable.fileUniqueId,
          set: {
            fileId: pair.normal.fileId,
            ogFileUniqueId: pair.og?.fileUniqueId || null,
            ogFileId: pair.og?.fileId || null,
          },
        });

      if (pair.og) {
        await db
          .insert(botFilesTable)
          .values({
            fileUniqueId: pair.og.fileUniqueId,
            fileId: pair.og.fileId,
            title: pair.og.title || null,
            performer: pair.og.performer || null,
            fileName: pair.og.fileName || null,
          })
          .onConflictDoUpdate({ target: botFilesTable.fileUniqueId, set: { fileId: pair.og.fileId } });
      }
    } catch (err) {
      logger.error({ err }, "Failed to save fileforward file to botFiles");
    }
  }

  let successCount = 0;
  let failCount = 0;
  const removedChatIds = new Set<string>();

  for (const chatId of selectedIds) {
    for (const pair of pairs) {
      if (removedChatIds.has(chatId)) break;

      const replyMarkup = {
        inline_keyboard: [[
          {
            text: "Download",
            url: `https://t.me/${BOT_USERNAME}?start=get_${pair.normal.fileUniqueId}`,
          },
        ]],
      };

      try {
        const res = await fetch(`https://api.telegram.org/bot${token}/sendAudio`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chat_id: chatId,
            audio: pair.normal.fileId,
            caption: pair.caption || undefined,
            reply_markup: replyMarkup,
          }),
        });

        if (res.ok) {
          successCount++;
        } else {
          const text = await res.text();
          if (isBanError(res.status, text)) {
            removedChatIds.add(chatId);
            logger.warn({ chatId, error: text }, "Bot banned during fileforward — removing from DB");
            try {
              await db.delete(connectedChatsTable).where(eq(connectedChatsTable.chatId, BigInt(chatId)));
            } catch (dbErr) {
              logger.error({ dbErr }, "Failed to remove banned chat");
            }
          } else {
            failCount++;
            logger.error({ chatId, error: `${res.status} ${text}` }, "Failed to fileforward to chat");
          }
        }
      } catch (err) {
        failCount++;
        logger.error({ err, chatId }, "Exception during fileforward send");
      }

      // Small delay between sends to avoid rate limits
      await new Promise((r) => setTimeout(r, 200));
    }
  }

  const totalSent = successCount;
  const parts: string[] = [`${pairs.length} file${pairs.length === 1 ? "" : "s"} sent to ${selectedIds.size - removedChatIds.size} chat${selectedIds.size - removedChatIds.size === 1 ? "" : "s"} (${totalSent} total sends).`];
  if (removedChatIds.size > 0) parts.push(`${removedChatIds.size} removed (bot was banned).`);
  if (failCount > 0) parts.push(`${failCount} failed.`);
  await bot.sendMessage(adminChatId, parts.join(" "));
}
