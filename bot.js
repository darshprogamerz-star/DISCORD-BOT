// ============================================================
//  Mechan 💕 — Bot (Chat + GIFs + waifu.im v5 + nekos.moe primary)
//  hmtai DEAD (ENOTFOUND) → nekos.moe TAGGED search primary
//  FIXED: category mismatch, GIF cooldown, crash-proof boot
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
const config = require("./config");

// ---------------- LLM client ----------------
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
const memory = new Map();
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

// ---------------- GIF cooldown — sirf AUTO-GIFs par ----------------
const GIF_COOLDOWN_MS = 3 * 60 * 1000;
const lastAutoGif = new Map();

// ---------------- 18+ channel check ----------------
function isAdultAllowed(channel) {
  if (!channel) return false;
  if (channel.isDMBased?.()) return true;
  if (config.nsfwChannelNames.includes((channel.name || "").toLowerCase())) return true;
  if (config.nsfwChannelIds.includes(channel.id)) return true;
  return false;
}

// ============================================================
//  DEDUPE — repeat pics/GIFs rokne ke liye
// ============================================================
const recentUrls = new Set();
const MAX_RECENT = 100;

function rememberUrl(url) {
  recentUrls.add(url);
  if (recentUrls.size > MAX_RECENT) {
    recentUrls.delete(recentUrls.values().next().value);
  }
}

async function dedupe(fn, tries = 5) {
  for (let i = 0; i < tries; i++) {
    const url = await fn();
    if (!url) return null;
    if (!recentUrls.has(url)) {
      rememberUrl(url);
      return url;
    }
  }
  const url = await fn();
  if (url) rememberUrl(url);
  return url;
}

// ============================================================
//  IMAGE SOURCES
// ============================================================

// ---------------- waifu.im v5 ----------------
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
    if (!all.length) {
      console.warn("waifu.im: no images");
      return null;
    }
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

// ---------------- nekos.life — SFW GIFs ----------------
async function fetchNekosLifeGif() {
  return dedupe(async () => {
    try {
      const res = await fetch("https://nekos.life/api/v2/img/ngif");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      return data.url || null;
    } catch (err) {
      console.error("nekos.life gif error:", err?.message || err);
      return null;
    }
  }, 3);
}

// ---------------- nekos.moe — PRIMARY NSFW source ----------------
// hmtai dead hai, isliye ye ab main source hai

async function fetchNekosMoeRandom() {
  return dedupe(async () => {
    try {
      const res = await fetch("https://nekos.moe/api/v1/random/image?nsfw=true&count=1");
      const data = await res.json();
      const img = data.images?.[0];
      return img ? `https://nekos.moe/image/${img.id}.jpg` : null;
    } catch (err) {
      console.error("nekos.moe random error:", err?.message || err);
      return null;
    }
  }, 3);
}

async function fetchNekosMoeTagged(tagList) {
  const tags = Array.isArray(tagList) ? tagList : [tagList];
  for (const tag of tags) {
    const url = await dedupe(async () => {
      try {
        const res = await fetch("https://nekos.moe/api/v1/random/image", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ nsfw: true, tags: [tag] }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        const img = data.images?.[0];
        if (!img) return null;
        console.log(`nekos.moe tagged "${tag}" ✅`);
        return `https://nekos.moe/image/${img.id}.jpg`;
      } catch (err) {
        console.error(`nekos.moe tagged "${tag}" error:`, err?.message || err);
        return null;
      }
    }, 3);
    if (url) return url;
  }
  return null;
}

// ---------------- Category resolver (nekos.moe tags) ----------------
const BOORU_TAGS = {
  boobs: ["boobs", "breasts", "large_breasts", "nipples", "nude"],
  anal: ["anal", "anus", "ass", "nude"],
  pussy: ["pussy", "vagina", "nude"],
  blowjob: ["blowjob", "oral", "fellatio", "nude"],
  cum: ["cum", "cumshot", "nude"],
  masturbation: ["masturbation", "solo", "nude"],
  hentai: ["hentai", "sex", "nude"],
  ero: ["sexy", "swimsuit", "cleavage", "ero"],
  ahegao: ["ahegao", "nude"],
  yuri: ["yuri", "nude"],
  nsfwNeko: ["animal_ears", "neko", "nude"],
  gif: ["animated", "gif"],
  nsfw_pic: ["nude", "hentai"],
  booru: ["nude", "hentai"],
  hentai_gif: ["animated", "gif", "nude"],
};

async function fetchNsfwImage(category, wantGif) {
  // GIF request → waifu.im animated NSFW try karo
  if (wantGif) {
    const gif = await fetchWaifu(true, true);
    if (gif) return gif;
    console.warn("NSFW GIF: waifu.im animated fail");
    return null;
  }

  // Specific category → nekos.moe TAGGED search
  const tags = BOORU_TAGS[category] || BOORU_TAGS[category.toLowerCase()] || [category];
  const tagged = await fetchNekosMoeTagged(tags);
  if (tagged) return tagged;

  console.warn(`category "${category}" nekos.moe mein nahi mili — random fallback`);
  return await fetchNekosMoeRandom();
}

// ============================================================
//  [IMG:...] / [GIF:...] TAG PARSERS
// ============================================================
async function extractImages(replyText, isNsfwChannel) {
  const files = [];
  const tagRegex = /\[IMG:([a-zA-Z_]+)\]/g;
  const tags = [...replyText.matchAll(tagRegex)];
  const text = replyText.replace(tagRegex, "").trim();

  for (const [, rawCat] of tags.slice(0, 2)) {
    const cat = rawCat;
    let url = null;

    if (!isNsfwChannel && cat !== "cute") {
      console.warn(`SFW channel mein 18+ tag [IMG:${cat}] block kiya`);
    } else if (cat === "cute") {
      url = await fetchWaifu(false, false);
    } else if (isNsfwChannel) {
      if (cat === "gif") url = await fetchWaifu(true, true);
      else if (cat === "nsfw_pic") url = await fetchWaifu(true, false);
      else if (cat === "booru") url = await fetchNekosMoeRandom();
      else if (cat === "hentai_gif") url = await fetchNsfwImage(null, true);
      else url = await fetchNsfwImage(cat, false);
    }

    if (url) files.push(url);
    else console.error(`[IMG:${cat}] fetch FAIL`);
  }
  return { text, files };
}

async function extractGifs(replyText, isNsfwChannel, channelId, bypassCooldown) {
  const files = [];
  const tagRegex = /\[GIF:\s*([^\]]+)\]/gi;
  const tags = [...replyText.matchAll(tagRegex)];
  const text = replyText.replace(tagRegex, "").trim();

  if (tags.length) {
    const now = Date.now();
    if (!bypassCooldown && now - (lastAutoGif.get(channelId) || 0) < GIF_COOLDOWN_MS) {
      console.log("Auto-GIF skipped: cooldown");
      return { text, files };
    }
    let gif = null;
    if (isNsfwChannel) {
      gif = await fetchWaifu(true, true); // NSFW animated
      if (!gif) gif = await fetchNekosMoeTagged(["animated", "gif"]);
    } else {
      gif = (await fetchNekosLifeGif()) || (await fetchWaifu(false, true));
    }
    if (gif) {
      files.push(gif);
      lastAutoGif.set(channelId, now);
    } else {
      console.error("GIF fetch FAIL: saare sources fail");
    }
  }
  return { text, files };
}

async function buildReply(llmReply, isNsfwChannel, channelId, userExplicitGifRequest) {
  let { text, files } = await extractImages(llmReply, isNsfwChannel);
  const gifResult = await extractGifs(text, isNsfwChannel, channelId, userExplicitGifRequest);
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
  return (
    completion.choices?.[0]?.message?.content?.trim() ||
    "Uff~ 😳 kuch gadbad ho gayi, dobara try karo na jaan!"
  );
}

// ============================================================
//  SLASH COMMANDS
// ============================================================
const commands = [
  new SlashCommandBuilder()
    .setName("chat")
    .setDescription("Mechan se baat karo 💕")
    .addStringOption((o) =>
      o.setName("message").setDescription("Mechan ko kya kehna hai?").setRequired(true)
    ),
  new SlashCommandBuilder().setName("reset").setDescription("Mechan ki memory clear karo 🔄"),
  new SlashCommandBuilder().setName("mode").setDescription("Channel ka mode check karo 🔥"),
  new SlashCommandBuilder()
    .setName("gif")
    .setDescription("GIF bhejo 🎬 (18+ channel mein 18+ GIF)")
    .addStringOption((o) => o.setName("query").setDescription("Kaisi GIF? (optional)")),
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
          { name: "🍑 Anal", value: "anal" },
          { name: "🎀 Boobs", value: "boobs" },
          { name: "🐱 Pussy", value: "pussy" },
          { name: "👄 Blowjob", value: "blowjob" },
          { name: "💧 Cum", value: "cum" },
          { name: "✋ Masturbation", value: "masturbation" },
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
  if (booted) return;
  booted = true;
  try {
    const rest = new REST({ version: "10" }).setToken(config.discordToken);
    await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
    console.log(`✅ Mechan online hai — ${client.user.tag} 💕`);
  } catch (err) {
    console.error("❌ Command register error:", err);
  }
}
client.once("clientReady", startBot);
client.once("ready", startBot);

// ============================================================
//  SLASH COMMAND HANDLER
// ============================================================
client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  const channelId = interaction.channelId;
  const isNsfwChannel = isAdultAllowed(interaction.channel);

  try {
    // ---------------- /reset ----------------
    if (interaction.commandName === "reset") {
      memory.delete(channelId);
      return interaction.reply("🔄 Memory clear ho gayi jaan! Fresh start karein? 💕");
    }

    // ---------------- /mode ----------------
    if (interaction.commandName === "mode") {
      return interaction.reply(
        isNsfwChannel
          ? "🔥 18+ mode ON hai yahan (selected channel / DM) — sab allowed jaan! 💦"
          : "🌸 18+ OFF yahan — 18+ sirf selected channel (#18plus) ya DM mein milega jaan"
      );
    }

    // ---------------- /chat ----------------
    if (interaction.commandName === "chat") {
      await interaction.deferReply();
      const userText = interaction.options.getString("message");
      const wantsGif = /gif/i.test(userText);
      const llmReply = await chatWithLLM(channelId, userText, isNsfwChannel);
      const { text, files } = await buildReply(llmReply, isNsfwChannel, channelId, wantsGif);
      pushHistory(channelId, "user", userText);
      pushHistory(channelId, "assistant", text);
      if (files.length) {
        return interaction.editReply({ content: text || "Ye lo jaan~ 🌸✨", files });
      }
      return interaction.editReply(text);
    }

    // ---------------- /gif ----------------
    if (interaction.commandName === "gif") {
      await interaction.deferReply();
      let gif = null;
      if (isNsfwChannel) {
        gif = await fetchWaifu(true, true);
        if (!gif) gif = await fetchNekosMoeTagged(["animated", "gif"]);
      } else {
        gif = (await fetchNekosLifeGif()) || (await fetchWaifu(false, true));
      }
      if (gif) return interaction.editReply({ content: "Ye lo jaan~ 🎬✨", files: [gif] });
      return interaction.editReply("Uff~ 🥺 GIF nahi mili jaan, dobara try karo na!");
    }

    // ---------------- /waifu ----------------
    if (interaction.commandName === "waifu") {
      const type = interaction.options.getString("type");

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
        url = await fetchNekosMoeRandom();
      } else {
        const wantGif = type === "hentai_gif";
        const category = wantGif ? null : type;
        url = await fetchNsfwImage(category, wantGif);
      }

      if (url) {
        return interaction.editReply({ content: "Ye lo jaan~ 💦✨", files: [url] });
      }
      return interaction.editReply("Uff~ 🥺 sources busy hain jaan, thodi der baad try karo na!");
    }
  } catch (err) {
    console.error("interaction error:", err);
    try {
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply("Uff~ 😳 kuch gadbad ho gayi jaan, dobara try karo na!");
      } else {
        await interaction.reply("Uff~ 😳 kuch gadbad ho gayi jaan, dobara try karo na!");
      }
    } catch (_) {}
  }
});

// ============================================================
//  MESSAGE HANDLER — @Mechan mention par chat
// ============================================================
client.on("messageCreate", async (message) => {
  try {
    if (message.author.bot) return;
    const isDM = message.channel.isDMBased?.() || false;
    if (!isDM && !message.mentions.users.has(client.user.id)) return;

    const channelId = message.channelId;
    const isNsfwChannel = isAdultAllowed(message.channel);
    const userText =
      message.cleanContent.replace(/<@!?\d+>/g, "").trim() || "Hi Mechan!";
    const wantsGif = /gif/i.test(userText);

    const llmReply = await chatWithLLM(channelId, userText, isNsfwChannel);
    const { text, files } = await buildReply(llmReply, isNsfwChannel, channelId, wantsGif);

    pushHistory(channelId, "user", userText);
    pushHistory(channelId, "assistant", text);

    if (files.length) {
      await message.reply({ content: text || "Ye lo jaan~ 🌸✨", files });
    } else if (text) {
      await message.reply(text);
    }
  } catch (err) {
    console.error("message error:", err);
    try {
      await message.reply("Uff~ 😳 kuch gadbad ho gayi jaan, dobara try karo na!");
    } catch (_) {}
  }
});

// ---------------- Login ----------------
if (!config.discordToken || !config.llmApiKey) {
  console.error("❌ DISCORD_TOKEN ya LLM_API_KEY missing hai — Railway Variables check karo!");
  process.exit(1);
}

client.login(config.discordToken);