// ============================================
// bot.js — Pari Final (COMPLETE)
// Fixes: strict category mapping, cooldown sirf
// auto-GIF par, GIF fallback chain + failure logs
// ============================================

const {
  Client,
  GatewayIntentBits,
  Events,
  REST,
  Routes,
  SlashCommandBuilder,
} = require("discord.js");
const hmtai = require("hmtai");
const config = require("./config.js");

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
  ],
});

// ---------------- Memory ----------------
const chatMemory = new Map();      // chatKey -> [{role, content}]
const recentUrls = new Set();      // dedupe set
const recentUrlQueue = [];         // FIFO for eviction
const lastAutoGifAt = new Map();   // channelId -> timestamp (SIRF auto-GIFs)

function rememberUrl(url) {
  if (!url || recentUrls.has(url)) return false;
  recentUrls.add(url);
  recentUrlQueue.push(url);
  if (recentUrlQueue.length > config.RECENT_URL_LIMIT) {
    recentUrls.delete(recentUrlQueue.shift());
  }
  return true;
}

// ---------------- 18+ Detection (naam-based + DM) ----------------
function isNsfwContext(channel) {
  if (!channel || !channel.guild) return true; // DM = hamesha 18+ allowed
  return config.NSFW_CHANNEL_NAMES.includes(
    String(channel.name).toLowerCase()
  );
}

// ---------------- waifu.im (v5 API) ----------------
async function fetchWaifu({ nsfw = false, animated = false, tag = "waifu" } = {}) {
  try {
    const params = new URLSearchParams({
      IsNsfw: nsfw ? "True" : "False",
      IsAnimated: animated ? "True" : "False",
      limit: String(config.WAIFU_BATCH),
    });
    const res = await fetch(`https://api.waifu.im/images?${params}`, {
      headers: { "Accept-Version": "v5" },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const items = data.items || [];
    const urls = items.map((i) => i.url).filter(Boolean);
    const fresh = urls.filter((u) => !recentUrls.has(u));
    const pool = fresh.length ? fresh : urls;
    if (!pool.length) return null;
    return pool[Math.floor(Math.random() * pool.length)];
  } catch (err) {
    console.error("waifu.im error:", err?.message || err);
    return null;
  }
}

// ---------------- hmtai (no key) ----------------
function fetchHmtai(category) {
  try {
    const section = hmtai?.nsfw || {};
    const fn = section[category];
    if (typeof fn !== "function") {
      console.warn(`hmtai: category "${category}" exist nahi karti`);
      return null;
    }
    return fn() || null;
  } catch (err) {
    console.error("hmtai error:", err?.message || err);
    return null;
  }
}

// ---------------- nekos.moe (no key) ----------------
async function fetchNekosMoe(nsfw) {
  try {
    const res = await fetch(
      `https://nekos.moe/api/v1/random/image?nsfw=${nsfw ? "true" : "false"}`
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const img = data.images?.[0];
    return img ? `https://nekos.moe/image/${img.id}` : null;
  } catch (err) {
    console.error("nekos.moe error:", err?.message || err);
    return null;
  }
}

// ---------------- STRICT category resolver ----------------
const NSFW_TAGS = new Set([
  "hentai", "anal", "boobs", "pussy", "blowjob", "cum", "masturbation",
]);

function resolveNsfwTag(tag) {
  const clean = String(tag).toLowerCase().trim();
  if (NSFW_TAGS.has(clean)) return clean;
  // Silent fallback NAHI — warn log taaki LLM ki galti pakde jaye
  console.warn(
    `Unknown IMG tag: "${tag}" — fallback "hentai" (LLM galat tag likh raha hai!)`
  );
  return "hentai";
}

// ---------------- Image fetcher (dedupe + retry) ----------------
async function fetchImage(tag, nsfwAllowed) {
  const clean = String(tag).toLowerCase().trim();

  for (let attempt = 0; attempt < 3; attempt++) {
    let url = null;

    if (clean === "waifu" || clean === "neko") {
      // SFW image
      url = await fetchWaifu({ nsfw: false, tag: clean });
      if (!url) url = await fetchNekosMoe(false);
ecchi      if (!url) url = fetchHmtai(clean) || null;
    } else {
      // 18+ image — sirf allowed context mein
      if (!nsfwAllowed) return { blocked: true };
      const mapped = NSFW_TAGS.has(clean) ? clean : resolveNsfwTag(clean);
      url = fetchHmtai(mapped);
      if (!url) url = await fetchWaifu({ nsfw: true });
      if (!url) url = await fetchNekosMoe(true);
    }

    if (!url) return { url: null };
    if (rememberUrl(url)) return { url };
    console.warn(`Duplicate image mili (attempt ${attempt + 1}), dobara try...`);
  }
  return { url: null };
}

// ---------------- GIF fetcher (fallback chain + logs) ----------------
async function fetchGif(nsfwAllowed) {
  for (let attempt = 0; attempt < 3; attempt++) {
    let url = null;

    if (nsfwAllowed) {
      // 18+ GIF: hmtai gif → waifu.im animated nsfw
      url = fetchHmtai("gif");
      if (!url) url = await fetchWaifu({ nsfw: true, animated: true });
    } else {
      // SFW GIF: waifu.im animated (Tenor ab dead hai)
      url = await fetchWaifu({ nsfw: false, animated: true });
      if (!url) url = await fetchWaifu({ nsfw: false, animated: true, tag: "neko" });
    }

    if (!url) {
      console.error("GIF fetch failed: saare sources empty/fail ho gaye");
      return null;
    }
    if (rememberUrl(url)) return url;
    console.warn(`Duplicate GIF mili (attempt ${attempt + 1}), dobara try...`);
  }
  console.error("GIF fetch failed: 3 attempts mein bhi fresh GIF nahi mili");
  return null;
}

// ---------------- LLM (Groq) ----------------
async function askLLM(systemPrompt, history) {
  const res = await fetch(config.LLM_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.LLM_API_KEY}`,
    },
    body: JSON.stringify({
      model: config.LLM_MODEL,
      messages: [{ role: "system", content: systemPrompt }, ...history],
      max_tokens: 500,
      temperature: 0.9,
    }),
  });
  if (!res.ok) {
    throw new Error(`LLM HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  const data = await res.json();
  return data.choices?.[0]?.message?.content || null;
}

// ---------------- Tag parser ----------------
function parseTags(text) {
  const images = [...text.matchAll(/\[IMG:([a-zA-Z]+)\]/g)].map((m) => m[1]);
  const gifs = [...text.matchAll(/\[GIF:([a-zA-Z]+)\]/g)].map((m) => m[1]);
  const clean = text.replace(/\[(IMG|GIF):[a-zA-Z ]+\]/g, "").trim();
  return { clean, images, gifs };
}

// ---------------- Chat handler ----------------
client.on(Events.MessageCreate, async (message) => {
  try {
    if (message.author.bot) return;

    const isDM = !message.guild;
    const mentioned = message.mentions.users.has(client.user.id);
    // DM mein bina mention bhi reply; server mein mention zaroori
    if (!isDM && !mentioned) return;

    const nsfwAllowed = isNsfwContext(message.channel);
    const modeLine = nsfwAllowed
      ? "CURRENT CHANNEL MODE: 18+ mode ON"
      : "CURRENT CHANNEL MODE: SFW mode";
    const system = `${config.PERSONA}\n\n${modeLine}`;

    const chatKey = isDM ? `dm-${message.author.id}` : message.channel.id;
    const history = chatMemory.get(chatKey) || [];
    history.push({
      role: "user",
      content: (message.cleanContent || message.content).slice(0, 1000),
    });
    if (history.length > config.MEMORY_LIMIT) {
      history.splice(0, history.length - config.MEMORY_LIMIT);
    }

    const raw = await askLLM(system, history);
    if (!raw) {
      await message.reply(
        "Uff~ 🥺 mujhe thodi technical problem aa gayi, thodi der baad baat karo na~ 💕"
      );
      return;
    }

    history.push({ role: "assistant", content: raw });
    chatMemory.set(chatKey, history);

    const { clean, images, gifs } = parseTags(raw);
    if (clean) await message.reply(clean);

    // ---- Auto-GIFs: cooldown SIRF yahan lagta hai ----
    const autoGifKeyword = gifs[0]; // max 1 auto-GIF per message
    if (autoGifKeyword) {
      const now = Date.now();
      const last = lastAutoGifAt.get(message.channel.id) || 0;
      if (now - last < config.AUTO_GIF_COOLDOWN) {
        console.log(
          "Auto-GIF skipped: cooldown active (/gif command par cooldown nahi lagta)"
        );
      } else {
        const gifUrl = await fetchGif(nsfwAllowed);
        if (gifUrl) {
          lastAutoGifAt.set(message.channel.id, now);
          await message.channel.send(gifUrl);
        } else {
          console.error("Auto-GIF fetch failed — upar ka log dekho");
        }
      }
    }

    // ---- Images (strict category) ----
    for (const tag of images.slice(0, config.MAX_IMAGES_PER_REPLY)) {
      const result = await fetchImage(tag, nsfwAllowed);
      if (result.blocked) {
        await message.channel.send(
          "Yahan sab dekh rahe hain 🙈 18+ channel mein aao na~ 💕"
        );
        continue;
      }
      if (result.url) {
        await message.channel.send(result.url);
      } else {
        console.error(`Image fetch failed for tag: "${tag}"`);
      }
    }
  } catch (err) {
    console.error("Message handler error:", err?.message || err);
  }
});

// ---------------- Slash Commands ----------------
const commands = [
  new SlashCommandBuilder()
    .setName("mode")
    .setDescription("Pari se poocho — ye channel 18+ hai ya SFW?"),
  new SlashCommandBuilder()
    .setName("waifu")
    .setDescription("Pari se ek pic maango")
    .addStringOption((opt) => {
      opt.setName("type").setDescription("Kaisi pic?").setRequired(true);
      [
        "waifu", "neko", "hentai", "anal", "boobs",
        "pussy", "blowjob", "cum", "masturbation",
      ].forEach((t) => opt.addChoices({ name: t, value: t }));
      return opt;
    }),
  new SlashCommandBuilder()
    .setName("gif")
    .setDescription("Pari ek GIF degi (18+ channel mein 18+ GIF)"),
  new SlashCommandBuilder()
    .setName("reset")
    .setDescription("Pari ki chat memory reset karo"),
].map((c) => c.toJSON());

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (!interaction.isChatInputCommand()) return;
    const nsfwAllowed = isNsfwContext(interaction.channel);

    if (interaction.commandName === "mode") {
      await interaction.reply(
        nsfwAllowed
          ? "🔥 Ye NSFW channel hai — 18+ mode ON hai! 💦"
          : "🌸 Ye SFW channel hai — 18+ OFF. Cute vibes only! 💕"
      );
      return;
    }

    if (interaction.commandName === "waifu") {
      const type = interaction.options.getString("type");
      await interaction.deferReply();
      const result = await fetchImage(type, nsfwAllowed);
      if (result.blocked) {
        await interaction.editReply(
          "Ye wali pic sirf 18+ channel mein milegi 🙈 #18plus mein aao ya DM karo~ 💕"
        );
        return;
      }
      if (!result.url) {
        await interaction.editReply(
          "Uff~ 🥺 abhi sources busy hain, thodi der baad try karo~"
        );
        return;
      }
      await interaction.editReply(result.url);
      return;
    }

    if (interaction.commandName === "gif") {
      // USER-REQUESTED GIF — cooldown yahan LAGTA HI NAHI
      await interaction.deferReply();
      const gifUrl = await fetchGif(nsfwAllowed);
      if (!gifUrl) {
        await interaction.editReply(
          "Uff~ 🥺 abhi GIF sources busy hain, thodi der baad try karo na~ 💕"
        );
        return;
      }
      await interaction.editReply(gifUrl);
      return;
    }

    if (interaction.commandName === "reset") {
      const chatKey = interaction.guild
        ? interaction.channel.id
        : `dm-${interaction.user.id}`;
      chatMemory.delete(chatKey);
      await interaction.reply(
        "Memory reset ho gayi ✨ ab fresh shuru karein~ 💕"
      );
      return;
    }
  } catch (err) {
    console.error("Interaction error:", err?.message || err);
    try {
      if (!interaction.replied) {
        await interaction.editReply("Arey 🥺 kuch technical problem ho gayi...");
      }
    } catch (_) {}
  }
});

// ---------------- Boot (ready + clientReady dono safe) ----------------
let booted = false;
async function boot() {
  if (booted) return;
  booted = true;
  try {
    const rest = new REST({ version: "10" }).setToken(config.DISCORD_TOKEN);
    await rest.put(Routes.applicationCommands(client.user.id), {
      body: commands,
    });
    console.log(`✅ Pari online hai — ${client.user.tag} (${client.user.id})`);
  } catch (err) {
    console.error("Command registration error:", err?.message || err);
  }
}

// Purana "ready" (deprecated warning deta hai) + naya "clientReady" —
// dono par lagaya, booted flag se double-registration nahi hogi
client.on("ready", boot);
client.on("clientReady", boot);

// ---------------- Start ----------------
if (!config.DISCORD_TOKEN || !config.LLM_API_KEY) {
  console.error(
    "❌ DISCORD_TOKEN ya LLM_API_KEY missing hai — Railway Variables check karo!"
  );
  process.exit(1);
}

client.login(config.DISCORD_TOKEN);