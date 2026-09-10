// ============================================================
//  Pari 💕 — Bot (Chat + GIFs + waifu.im v5 + hmtai + nekos.moe)
//  FIXED VERSION — is version mein ye bugs fix hain:
//  1. Category mismatch: hmtai case-insensitive + alias lookup,
//     fail hone par nekos.moe TAGGED search (random nahi!)
//  2. SFW GIF hit-rate: Tenor hata diya (dead) — nekos.life add kiya
//  3. Cooldown ab explicit GIF request par bypass hota hai
//  4. nsfwNeko jaise case-sensitive keys ab sahi match hoti hain
//  5. Har fail ka clear log — Railway logs mein reason dikhega
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

// hmtai v3 class ya object — dono handle karo (crash-proof)
const hmtai = typeof HMtai === "function" ? new HMtai() : HMtai;
const hmtaiNsfw = hmtai?.nsfw || {};

// Boot par available categories log karo — category mismatch
// diagnose karne ke liye ye line Railway logs mein zaroor dekhna!
try {
  console.log(
    "hmtai NSFW categories available:",
    Object.keys(hmtaiNsfw).join(", ")
  );
} catch (e) {
  console.error("hmtai categories log nahi ho payi:", e?.message);
}

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

// ---------------- GIF cooldown — sirf AUTO-GIFs par ----------------
const GIF_COOLDOWN_MS = 3 * 60 * 1000; // 3 minute
const lastAutoGif = new Map(); // channelId -> timestamp

// ---------------- 18+ channel check (selected channel + DM) ----------------
function isAdultAllowed(channel) {
  if (!channel) return false;
  if (channel.isDMBased?.()) return true; // DM mein hamesha 18+ allowed
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
    recentUrls.delete(recentUrls.values().next().value); // sabse purani hatao
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
  const url = await fn(); // pool chhota hai — last wala bhej do
  if (url) rememberUrl(url);
  return url;
}

// ============================================================
//  IMAGE SOURCES
// ============================================================

// ---------------- waifu.im (v5 API) ----------------
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
      console.warn("waifu.im: is query mein images nahi mili");
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

// ---------------- nekos.life — SFW GIFs (TENOR DEAD, ye naya hai) ----------------
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

// ---------------- nekos.moe — random NSFW (booru fallback) ----------------
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

// ---------------- nekos.moe TAGGED — specific category ke liye ----------------
// Ye hi ASLI FIX hai: "boobs" maango to nekos.moe par "boobs" TAG se
// search hota hai — random image kabhi nahi jayegi!
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
        console.log(`nekos.moe tagged "${tag}" se image mili ✅`);
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

// ---------------- hmtai — case-insensitive + alias lookup ----------------
// Aliases: hmtai ke asli category names alag ho sakte hain, inme se koi ek match hoga
const HMTAI_ALIASES = {
  boobs: ["boobs", "boob", "tits", "breasts", "oppai", "big_boobs"],
  anal: ["anal", "ass", "anus"],
  pussy: ["pussy", "cunt", "vagina"],
  blowjob: ["blowjob", "bj", "oral", "fellatio"],
  cum: ["cum", "cumshot", "semen"],
  masturbation: ["masturbation", "solo", "fingering"],
  hentai: ["hentai", "sex", "nsfw"],
  ero: ["ero", "erotic", "sexy"],
  ahegao: ["ahegao", "ecchi"],
  yuri: ["yuri", "lesbian"],
  nsfwNeko: ["nsfwNeko", "nsfw_neko", "lewdneko", "lewd", "lewdNeko"],
};

// nekos.moe booru tags — user category ke hisaab se kaunse tags try karne hain
const BOORU_TAGS = {
  boobs: ["boobs", "breasts", "large_breasts", "nipples", "nude"],
  anal: ["anal", "anus", "nude"],
  pussy: ["pussy", "vagina", "nude"],
  blowjob: ["blowjob", "oral", "fellatio", "nude"],
  cum: ["cum", "cumshot", "nude"],
  masturbation: ["masturbation", "solo", "nude"],
  hentai: ["hentai", "sex", "nude"],
  ero: ["sexy", "swimsuit", "cleavage"],
  ahegao: ["ahegao", "nude"],
  yuri: ["yuri", "nude"],
  nsfwNeko: ["animal_ears", "nude"],
};

function getHmtaiCategoryFn(category) {
  const candidates = HMTAI_ALIASES[category] || [category];
  const keys = Object.keys(hmtaiNsfw);
  for (const cand of candidates) {
    // Pehle exact match, phir substring match (jaise "boobs" vs key "big_boobs")
    let match = keys.find((k) => k.toLowerCase() === cand.toLowerCase());
    if (!match) {
      match = keys.find((k) => k.toLowerCase().includes(cand.toLowerCase()));
    }
    if (match && typeof hmtaiNsfw[match] === "function") {
      return hmtaiNsfw[match];
    }
  }
  return null;
}

async function fetchHentai(category, wantGif) {
  // ---- GIF ----
  if (wantGif) {
    const gif = await dedupe(async () => {
      try {
        if (typeof hmtaiNsfw.gif !== "function") return null;
        return await hmtaiNsfw.gif();
      } catch (err) {
        console.error("hmtai gif error:", err?.message);
        return null;
      }
    }, 4);
    if (gif) return gif;
    console.warn("hmtai gif fail — waifu.im animated try kar raha hun");
    return await fetchWaifu(true, true);
  }

  // ---- Specific category (boobs, anal, etc.) ----
  if (category) {
    const fn = getHmtaiCategoryFn(category);
    if (fn) {
      const url = await dedupe(async () => {
        try {
          return await fn();
        } catch (err) {
          console.error(`hmtai "${category}" error:`, err?.message);
          return null;
        }
      }, 3);
      if (url) return url;
      console.warn(`hmtai "${category}" se image nahi mili`);
    } else {
      console.warn(
        `hmtai: category "${category}" available nahi hai — boot log mein available categories dekho`
      );
    }
    // hmtai fail → nekos.moe TAGGED search (random NAHI — yahi pehle bug tha!)
    const tagged = await fetchNekosMoeTagged(
      BOORU_TAGS[category] || BOORU_TAGS[category.toLowerCase()] || [category]
    );
    if (tagged) return tagged;
    console.warn(
      `category "${category}" dono sources mein nahi mili — fallback "hentai"`
    );
  }

  // ---- Generic hentai fallback ----
  const hentaiFn = getHmtaiCategoryFn("hentai");
  if (hentaiFn) {
    const url = await dedupe(async () => {
      try {
        return await hentaiFn();
      } catch (err) {
        console.error("hmtai hentai error:", err?.message);
        return null;
      }
    }, 3);
    if (url) return url;
  }
  return await fetchNekosMoe();
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
    // ⚠️ FIX: lowercase NAHI karte — hmtai keys case-sensitive hain (nsfwNeko)
    const cat = rawCat;
    let url = null;

    if (!isNsfwChannel && cat !== "cute") {
      // SFW channel mein 18+ tag block — safety
      console.warn(`SFW channel mein 18+ tag [IMG:${cat}] aaya — block kiya`);
    } else if (cat === "cute") {
      url = await fetchWaifu(false, false);
    } else if (isNsfwChannel) {
      if (cat === "gif") url = await fetchWaifu(true, true);
      else if (cat === "nsfw_pic") url = await fetchWaifu(true, false);
      else if (cat === "booru") url = await fetchNekosMoe();
      else if (cat === "hentai_gif") url = await fetchHentai(null, true);
      else url = await fetchHentai(cat, false);
    }

    if (url) files.push(url);
    else console.error(`[IMG:${cat}] fetch FAIL — upar ka log dekho`);
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
    // ⚠️ FIX: user ne EXPLICITLY GIF maangi to cooldown bypass
    if (!bypassCooldown && now - (lastAutoGif.get(channelId) || 0) < GIF_COOLDOWN_MS) {
      console.log("Auto-GIF skipped: cooldown (explicit request nahi thi)");
      return { text, files };
    }
    let gif = null;
    if (isNsfwChannel) {
      gif = (await fetchHentai(null, true)) || (await fetchWaifu(true, true));
    } else {
      // SFW GIF: nekos.life (naya) → waifu.im animated (Tenor ab dead hai)
      gif = (await fetchNekosLifeGif()) || (await fetchWaifu(false, true));
    }
    if (gif) {
      files.push(gif);
      lastAutoGif.set(channelId, now);
    } else {
      console.error("GIF fetch FAIL: saare sources fail ho gaye");
    }
  }
  return { text, files };
}

async function buildReply(llmReply, isNsfwChannel, channelId, userExplicitGifRequest) {
  let { text, files } = await extractImages(llmReply, isNsfwChannel);
  const gifResult = await extractGifs(
    text,
    isNsfwChannel,
    channelId,
    userExplicitGifRequest
  );
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
    "Uff~ 😳 kuch gadbad ho gayi, dobara try karo na!"
  );
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
    console.log(`✅ Pari online hai — ${client.user.tag}`);
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
      return interaction.reply("🔄 Memory clear ho gayi! Fresh start karein? 💕");
    }

    // ---------------- /mode ----------------
    if (interaction.commandName === "mode") {
      return interaction.reply(
        isNsfwChannel
          ? "🔥 18+ mode ON hai yahan (selected channel / DM) — sab allowed! 💦"
          : "🌸 18+ OFF yahan — 18+ sirf selected channel (#18plus) ya DM mein milega"
      );
    }

    // ---------------- /chat ----------------
    if (interaction.commandName === "chat") {
      await interaction.deferReply();
      const userText = interaction.options.getString("message");
      const wantsGif = /gif/i.test(userText); // explicit GIF request → cooldown bypass
      const llmReply = await chatWithLLM(channelId, userText, isNsfwChannel);
      const { text, files } = await buildReply(
        llmReply,
        isNsfwChannel,
        channelId,
        wantsGif
      );
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
      // USER-REQUESTED GIF — cooldown yahan LAGTA HI NAHI
      let gif = null;
      if (isNsfwChannel) {
        gif = (await fetchHentai(null, true)) || (await fetchWaifu(true, true));
      } else {
        gif = (await fetchNekosLifeGif()) || (await fetchWaifu(false, true));
      }
      if (gif) return interaction.editReply({ content: "Ye lo~ 🎬✨", files: [gif] });
      console.error("/gif FAIL: saare sources fail (upar ka log dekho)");
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
        const category = wantGif ? null : type;
        url = await fetchHentai(category, wantGif);
      }

      if (url) {
        return interaction.editReply({ content: "Ye lo~ 💦✨", files: [url] });
      }
      console.error(`/waifu "${type}" FAIL — upar ka log dekho`);
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
    const isDM = message.channel.isDMBased?.() || false;
    if (!isDM && !message.mentions.users.has(client.user.id)) return;

    const channelId = message.channelId;
    const isNsfwChannel = isAdultAllowed(message.channel);
    const userText =
      message.cleanContent.replace(/<@!?\d+>/g, "").trim() || "Hi Pari!";
    const wantsGif = /gif/i.test(userText); // explicit GIF request → cooldown bypass

    const llmReply = await chatWithLLM(channelId, userText, isNsfwChannel);
    const { text, files } = await buildReply(
      llmReply,
      isNsfwChannel,
      channelId,
      wantsGif
    );

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
if (!config.discordToken || !config.llmApiKey) {
  console.error(
    "❌ DISCORD_TOKEN ya LLM_API_KEY missing hai — Railway Variables check karo!"
  );
  process.exit(1);
}

client.login(config.discordToken);