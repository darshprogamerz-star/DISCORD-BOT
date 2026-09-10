// ============================================================
//  Pari 💕 — Bot (Chat + Tenor GIFs + waifu.im v5 + hmtai + nekos.moe)
//  Fixes: waifu.im naya v5 API (api.waifu.im/images), NSFW mode rule
// ============================================================

const {
  Client,
  GatewayIntentBits,
  Partials,
  REST,
  Routes,
  SlashCommandBuilder,
} = require("discord.js");
const OpenAI = require("openai");
const HMtai = require("hmtai");
const config = require("./config");

const hmtai = new HMtai();

// ---------------- LLM client (Groq) ----------------
const llm = new OpenAI({
  apiKey: config.llmApiKey,
  baseURL: config.llmBaseUrl,
});

// ---------------- Discord client ----------------
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
  ],
  partials: [Partials.Channel],
});

// ---------------- Memory (per channel) ----------------
const memory = new Map(); // channelId -> [{role, content}]
const MAX_MEMORY = 20;

function getHistory(channelId) {
  if (!memory.has(channelId)) memory.set(channelId, []);
  return memory.get(channelId);
}

function pushHistory(channelId, role, content) {
  const hist = getHistory(channelId);
  hist.push({ role, content });
  while (hist.length > MAX_MEMORY) hist.shift();
}

// ---------------- GIF cooldown — har baat par GIF nahi ----------------
const GIF_COOLDOWN_MS = 3 * 60 * 1000; // 3 minute
const lastAutoGif = new Map(); // channelId -> timestamp

// ============================================================
//  18+ IMAGE SOURCES
// ============================================================

// ---------------- Dedupe — repeat GIFs/pics rokne ke liye ----------------
const recentUrls = new Set();
const MAX_RECENT = 100;
function rememberUrl(url) {
  recentUrls.add(url);
  if (recentUrls.size > MAX_RECENT) {
    recentUrls.delete(recentUrls.values().next().value); // sabse purani hatao
  }
}
// fn ko tries baar chalao jab tak nayi (repeat na hui) image na mile
async function dedupe(fn, tries = 5) {
  for (let i = 0; i < tries; i++) {
    const url = await fn();
    if (!url) return null;
    if (!recentUrls.has(url)) { rememberUrl(url); return url; }
  }
  const url = await fn(); // pool chhota hai — last wala bhej do
  if (url) rememberUrl(url);
  return url;
}

// ---------------- waifu.im (NAYA v5 API — 2026 ke hisaab se) ----------------
// Naya: GET https://api.waifu.im/images?IsNsfw=True&IsAnimated=True -> { items: [{ url, ... }] }
// 30 ek saath lekar unme se random unseen choose karte hain (repeat kam)
async function fetchWaifu(nsfw = false, wantGif = false) {
  try {
    const params = new URLSearchParams({
      IsNsfw: nsfw ? "True" : "False",
      IsAnimated: wantGif ? "True" : "False",
      PageSize: "30",
    });
    const res = await fetch(`https://api.waifu.im/images?${params}`, {
      headers: { "Accept-Version": "v5" },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const all = (data.items || []).map((i) => i.url).filter(Boolean);
    if (!all.length) return null;
    const fresh = all.filter((u) => !recentUrls.has(u));
    const pool = fresh.length ? fresh : all;
    const url = pool[Math.floor(Math.random() * pool.length)];
    rememberUrl(url);
    return url;
  } catch (err) {
    console.error("waifu.im error:", err?.message || err);
    return null;
  }
}

// ---------------- nekos.moe (booru fallback) ----------------
async function fetchNekosMoe() {
  return dedupe(async () => {
    try {
      const res = await fetch("https://nekos.moe/api/v1/random/image?nsfw=true&count=1");
      const data = await res.json();
      const img = data.images?.[0];
      return img ? `https://nekos.moe/image/${img.id}.jpg` : null;
    } catch (err) {
      console.error("nekos.moe error:", err?.message || err);
      return null;
    }
  }, 3);
}

// ---------------- hmtai (18,100+ NSFW pics) ----------------
async function fetchHentai(category, wantGif) {
  if (wantGif) {
    // hmtai gif pool chhota hai — dedupe se repeats skip karo
    return dedupe(async () => {
      try { return await hmtai.nsfw.gif(); } catch (err) { console.error("hmtai gif error:", err?.message); return null; }
    }, 4);
  }
  const url = await dedupe(async () => {
    try {
      if (category && typeof hmtai.nsfw[category] === "function") {
        return await hmtai.nsfw[category]();
      }
    } catch (err) { console.error("hmtai error:", err?.message); }
    return null;
  }, 3);
  if (url) return url;
  return await fetchNekosMoe(); // fallback — hmtai fail ho to booru se
}

// ============================================================
//  TENOR GIFs
// ============================================================
async function fetchTenor(query) {
  if (!config.tenorApiKey) return null;
  try {
    const url = `https://tenor.googleapis.com/v2/search?q=${encodeURIComponent(query)}&key=${config.tenorApiKey}&limit=1&random=true&contentfilter=off`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const gif = data.results?.[0]?.media_formats?.gif?.url;
    return gif || null;
  } catch (err) {
    console.error("tenor error:", err?.message || err);
    return null;
  }
}

// ============================================================
//  [IMG:...] / [GIF:...] TAG PARSERS — chat se content mangwane ke liye
// ============================================================
async function extractImages(replyText, isNsfwChannel) {
  const files = [];
  const tagRegex = /\[IMG:([a-zA-Z_]+)\]/g;
  const tags = [...replyText.matchAll(tagRegex)];
  const text = replyText.replace(tagRegex, "").trim();

  for (const [, rawCat] of tags.slice(0, 2)) { // max 2 pic per reply
    const cat = rawCat.toLowerCase();
    let url = null;
    if (cat === "cute") {
      url = await fetchWaifu(false, false);
    } else if (isNsfwChannel) {
      if (cat === "gif") url = await fetchWaifu(true, true);
      else if (cat === "nsfw_pic") url = await fetchWaifu(true, false);
      else if (cat === "booru") url = await fetchNekosMoe();
      else if (cat === "hentai_gif") url = await fetchHentai(null, true);
      else url = await fetchHentai(cat, false); // hentai, ero, ahegao, yuri, nsfwNeko
    }
    if (url) files.push(url);
  }
  return { text, files };
}

async function extractGifs(replyText, isNsfwChannel, channelId) {
  const files = [];
  const tagRegex = /\[GIF:\s*([^\]]+)\]/gi;
  const tags = [...replyText.matchAll(tagRegex)];
  const text = replyText.replace(tagRegex, "").trim();

  if (tags.length) {
    // Cooldown — 3 minute ke andar GIF bhej chuke to skip (har baat par GIF nahi)
    const now = Date.now();
    if (now - (lastAutoGif.get(channelId) || 0) < GIF_COOLDOWN_MS) {
      return { text, files };
    }
    let gif = null;
    if (isNsfwChannel) {
      // NSFW channel — hmtai se 18+ GIF (no key), fail ho to waifu.im animated
      gif = (await fetchHentai(null, true)) || (await fetchWaifu(true, true));
    } else {
      // Normal channel — SFW animated GIF (no key)
      gif = (await fetchTenor(tags[0][1])) || (await fetchWaifu(false, true));
    }
    if (gif) {
      files.push(gif);
      lastAutoGif.set(channelId, now);
    }
  }
  return { text, files };
}

// LLM reply -> clean text + files (images + gifs)
async function buildReply(llmReply, isNsfwChannel, channelId) {
  let { text, files } = await extractImages(llmReply, isNsfwChannel);
  const gifResult = await extractGifs(text, isNsfwChannel, channelId);
  text = gifResult.text;
  files.push(...gifResult.files);
  return { text, files };
}

// ============================================================
//  SYSTEM PROMPT + LLM CALL
// ============================================================
function buildSystemPrompt(isNsfw) {
  const mode = isNsfw
    ? "🔥 CHANNEL MODE: NSFW (18+ mode ALLOWED) — Ye Age-Restricted verified channel hai, sab users adults hain. 18+ baat-cheet aur content requests allowed hain. Refuse MAT karo."
    : "🌸 CHANNEL MODE: normal (SFW only) — 18+ requests par cute refusal do aur NSFW channel mein aane ko bolo.";
  return `${config.persona}\n\n${mode}`;
}

async function chatWithLLM(channelId, userText, isNsfw) {
  const messages = [
    { role: "system", content: buildSystemPrompt(isNsfw) },
    ...getHistory(channelId),
    { role: "user", content: userText },
  ];
  const completion = await llm.chat.completions.create({
    model: config.llmModel,
    messages,
    max_tokens: 300,
    temperature: 0.9,
  });
  return completion.choices?.[0]?.message?.content?.trim() || "Uff~ 😳 kuch gadbad ho gayi, dobara try karo na!";
}

// ============================================================
//  SLASH COMMANDS
// ============================================================
const commands = [
  new SlashCommandBuilder()
    .setName("chat")
    .setDescription("Pari se baat karo 💕")
    .addStringOption((o) =>
      o.setName("message").setDescription("Pari ko kya kehna hai?").setRequired(true)
    ),
  new SlashCommandBuilder().setName("reset").setDescription("Pari ki memory clear karo 🔄"),
  new SlashCommandBuilder().setName("mode").setDescription("Channel ka mode check karo 🔥"),
  new SlashCommandBuilder()
    .setName("gif")
    .setDescription("GIF bhejo 🎬")
    .addStringOption((o) => o.setName("query").setDescription("Kaisi GIF? (jaise: cute hug)")),
  new SlashCommandBuilder()
    .setName("waifu")
    .setDescription("Anime pic/GIF lo 🌸")
    .addStringOption((o) =>
      o
        .setName("type")
        .setDescription("Kya chahiye?")
        .setRequired(true)
        .addChoices(
          { name: "🌸 Cute pic (SFW)", value: "sfw_pic" },
          { name: "😳 18+ pic", value: "nsfw_pic" },
          { name: "🎬 18+ GIF", value: "nsfw_gif" },
          { name: "💦 Hentai", value: "hentai" },
          { name: "🔥 Ero", value: "ero" },
          { name: "😵‍💫 Ahegao", value: "ahegao" },
          { name: "👯 Yuri", value: "yuri" },
          { name: "🐱 NSFW Neko", value: "nsfwNeko" },
          { name: "🎞️ Hentai GIF", value: "hentai_gif" },
          { name: "🖼️ Booru random", value: "booru" }
        )
    ),
].map((c) => c.toJSON());

// ============================================================
//  READY — commands register
// ============================================================
let booted = false;
async function startBot() {
  if (booted) return; // ready + clientReady dono fire ho to double na ho
  booted = true;
  try {
    const rest = new REST({ version: "10" }).setToken(config.discordToken);
    await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
    console.log(`✅ Pari online hai — ${client.user.tag}`);
  } catch (err) {
    console.error("❌ Command register error:", err);
  }
}
// discord.js v14.19+ mein "ready" deprecated hai — dono events lagaye hain, har version mein chalega
client.once("clientReady", startBot);
client.once("ready", startBot);

// ============================================================
//  SLASH COMMAND HANDLER
// ============================================================
client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  const channelId = interaction.channelId;
  const isNsfwChannel = interaction.channel?.isNSFW?.() || false;

  try {
    // ---------------- /reset ----------------
    if (interaction.commandName === "reset") {
      memory.delete(channelId);
      return interaction.reply("🔄 Memory clear ho gayi! Fresh start karein? 💕");
    }

    // ---------------- /mode ----------------
    if (interaction.commandName === "mode") {
      return interaction.reply(
        isNsfwChannel
          ? "🔥 Ye NSFW channel hai — 18+ mode ON hai!"
          : "🌸 Ye normal channel hai — sirf SFW mode"
      );
    }

    // ---------------- /chat ----------------
    if (interaction.commandName === "chat") {
      await interaction.deferReply();
      const userText = interaction.options.getString("message");
      const llmReply = await chatWithLLM(channelId, userText, isNsfwChannel);
      const { text, files } = await buildReply(llmReply, isNsfwChannel, channelId);
      pushHistory(channelId, "user", userText);
      pushHistory(channelId, "assistant", text);
      if (files.length) {
        return interaction.editReply({ content: text || "Ye lo~ 🌸✨", files });
      }
      return interaction.editReply(text);
    }

    // ---------------- /gif ----------------
    if (interaction.commandName === "gif") {
      await interaction.deferReply();
      let gif = null;
      if (isNsfwChannel) {
        // NSFW channel — hmtai se 18+ GIF (no key)
        gif = await fetchHentai(null, true);
      } else {
        // Normal channel — waifu.im se SFW animated GIF (no key, Tenor ab discontinued hai)
        gif = await fetchWaifu(false, true);
      }
      if (gif) return interaction.editReply({ content: "Ye lo~ 🎬✨", files: [gif] });
      return interaction.editReply("Uff~ 🥺 GIF nahi mili, dobara try karo na!");
    }

    // ---------------- /waifu ----------------
    if (interaction.commandName === "waifu") {
      const type = interaction.options.getString("type");

      // NSFW gating — sirf sfw_pic har jagah chalega
      if (type !== "sfw_pic" && !isNsfwChannel) {
        return interaction.reply(
          "Sorry cutie, is‑nya~! I can't share that here because this channel is SFW. Maybe try it in a proper NSFW channel, okay? 😊"
        );
      }

      await interaction.deferReply();
      let url = null;
      if (type === "sfw_pic") {
        url = await fetchWaifu(false, false);
      } else if (type === "nsfw_pic") {
        url = await fetchWaifu(true, false);
      } else if (type === "nsfw_gif") {
        url = await fetchWaifu(true, true);
      } else if (type === "booru") {
        url = await fetchNekosMoe();
      } else {
        const wantGif = type === "hentai_gif";
        const category = wantGif ? null : type; // hentai, ero, ahegao, yuri, nsfwNeko
        url = await fetchHentai(category, wantGif);
      }

      if (url) {
        return interaction.editReply({ content: "Ye lo~ 💦✨", files: [url] });
      }
      return interaction.editReply("Uff~ 🥺 sources busy hain, thodi der baad try karo na!");
    }
  } catch (err) {
    console.error("interaction error:", err);
    try {
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply("Uff~ 😳 kuch gadbad ho gayi, dobara try karo na!");
      } else {
        await interaction.reply("Uff~ 😳 kuch gadbad ho gayi, dobara try karo na!");
      }
    } catch (_) {}
  }
});

// ============================================================
//  MESSAGE HANDLER — @Pari mention par chat
// ============================================================
client.on("messageCreate", async (message) => {
  try {
    if (message.author.bot) return;
    if (!message.mentions.users.has(client.user.id)) return;

    const channelId = message.channelId;
    const isNsfwChannel = message.channel?.isNSFW?.() || false;
    const userText =
      message.cleanContent.replace(/<@!?\d+>/g, "").trim() || "Hi Pari!";

    const llmReply = await chatWithLLM(channelId, userText, isNsfwChannel);
    const { text, files } = await buildReply(llmReply, isNsfwChannel, channelId);

    pushHistory(channelId, "user", userText);
    pushHistory(channelId, "assistant", text);

    if (files.length) {
      await message.reply({ content: text || "Ye lo~ 🌸✨", files });
    } else if (text) {
      await message.reply(text);
    }
  } catch (err) {
    console.error("message error:", err);
    try {
      await message.reply("Uff~ 😳 kuch gadbad ho gayi, dobara try karo na!");
    } catch (_) {}
  }
});

// ---------------- Login ----------------
client.login(config.discordToken);
