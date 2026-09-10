// ============================================================
//  Pari 💕 — Cute Anime Girl Companion Bot
//  Hindi / Hinglish / English · LLM chat · GIFs · 18+ (NSFW-gated)
//  Deploy: Railway (node bot.js)
// ============================================================

const {
  Client,
  GatewayIntentBits,
  Partials,
  SlashCommandBuilder,
  REST,
  Routes,
} = require("discord.js");
const OpenAI = require("openai");
const HMtai = require("hmtai");
const config = require("./config.js");

// ---- Startup checks ----
if (!config.discordToken || !config.llmApiKey) {
  console.error("❌ DISCORD_TOKEN ya LLM_API_KEY missing hai! Railway → Variables check karo.");
  process.exit(1);
}

const hmtai = new HMtai();
const openai = new OpenAI({
  apiKey: config.llmApiKey,
  baseURL: config.llmBaseUrl,
});

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
  ],
  partials: [Partials.Channel],
});

// ---------------- Memory (per channel, last 12 msgs) ----------------
const MEMORY_LIMIT = 12;
const memory = new Map();

function getMemory(channelId) {
  if (!memory.has(channelId)) memory.set(channelId, []);
  return memory.get(channelId);
}

function pushMemory(channelId, role, content) {
  const m = getMemory(channelId);
  m.push({ role, content });
  while (m.length > MEMORY_LIMIT) m.shift();
}

// ---------------- System prompt ----------------
function buildSystemPrompt(isNsfwChannel) {
  const mode = isNsfwChannel
    ? "Current channel: NSFW (18+ mode ALLOWED)."
    : "Current channel: normal (SFW only — 18+ content strictly mana hai, [IMG:cute] ke alawa koi image tag use mat karo).";
  return `${config.persona}\n\n${mode}`;
}

// ---------------- LLM ----------------
async function getLLMReply(channelId, userText, isNsfwChannel) {
  const messages = [
    { role: "system", content: buildSystemPrompt(isNsfwChannel) },
    ...getMemory(channelId),
    { role: "user", content: userText },
  ];
  const res = await openai.chat.completions.create({
    model: config.llmModel,
    messages,
    max_tokens: 300,
    temperature: 0.9,
  });
  const reply = res.choices?.[0]?.message?.content?.trim();
  if (!reply) throw new Error("Empty LLM response");
  pushMemory(channelId, "user", userText);
  pushMemory(channelId, "assistant", reply);
  return reply;
}

// ---------------- Tenor GIFs ----------------
async function fetchGif(query, contentFilter) {
  if (!config.tenorApiKey) return null;
  try {
    const params = new URLSearchParams({
      q: query,
      key: config.tenorApiKey,
      limit: "20",
      contentfilter: contentFilter || "high",
      client_key: "pari_bot",
    });
    const res = await fetch(`https://tenor.googleapis.com/v2/search?${params}`);
    const data = await res.json();
    const results = data.results || [];
    if (!results.length) return null;
    const pick = results[Math.floor(Math.random() * results.length)];
    return pick.media_formats?.gif?.url || pick.media_formats?.mediumgif?.url || null;
  } catch (err) {
    console.error("Tenor error:", err?.message || err);
    return null;
  }
}

// ---------------- waifu.im — anime pics/GIFs ----------------
async function fetchWaifu(isNsfw, wantGif) {
  try {
    const params = new URLSearchParams({
      is_nsfw: String(isNsfw),
      gif: String(wantGif),
      many: "false",
    });
    const res = await fetch(`https://api.waifu.im/search?${params}`);
    const data = await res.json();
    return data.images?.[0]?.url || null;
  } catch (err) {
    console.error("waifu.im error:", err?.message || err);
    return null;
  }
}

// ---------------- nekos.moe — booru-style NSFW ----------------
async function fetchNekosMoe() {
  try {
    const res = await fetch("https://nekos.moe/api/v1/random/image?nsfw=true&count=1");
    const data = await res.json();
    const img = data.images?.[0];
    return img ? `https://nekos.moe/image/${img.id}.jpg` : null;
  } catch (err) {
    console.error("nekos.moe error:", err?.message || err);
    return null;
  }
}

// ---------------- hmtai — hentai categories (with fallback) ----------------
async function fetchHentai(category, wantGif) {
  if (wantGif) {
    try {
      return await hmtai.nsfw.gif();
    } catch (err) {
      console.error("hmtai gif error:", err?.message || err);
    }
  }
  try {
    if (category && typeof hmtai.nsfw[category] === "function") {
      return await hmtai.nsfw[category]();
    }
  } catch (err) {
    console.error("hmtai error:", err?.message || err);
  }
  return await fetchNekosMoe(); // fallback — hmtai fail ho to booru se
}

// ---------------- [IMG:...] / [GIF:...] tag parser ----------------
async function extractImages(replyText, isNsfwChannel) {
  const files = [];

  // Image tags
  const imgRegex = /\[IMG:([a-zA-Z_]+)\]/g;
  const imgTags = [...replyText.matchAll(imgRegex)];
  let text = replyText.replace(imgRegex, "").trim();

  for (const [, rawCat] of imgTags.slice(0, 2)) { // max 2 pics per reply
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

  // Auto-GIF tag
  const gifRegex = /\[GIF:\s*([^\]]+)\]/i;
  const gifMatch = text.match(gifRegex);
  if (gifMatch) {
    text = text.replace(gifRegex, "").trim();
    const filter = isNsfwChannel ? "off" : "high";
    const url = await fetchGif(gifMatch[1].trim(), filter);
    if (url) files.push(url);
  }

  return { text, files };
}

// ---------------- Reply sender (text + files) ----------------
async function sendPariReply(target, llmReply, isNsfwChannel) {
  const { text, files } = await extractImages(llmReply, isNsfwChannel);
  const payload = { content: text || "Ye lo~ 🌸✨" };
  if (files.length) payload.files = files;
  await target.send(payload);
}

// ---------------- Slash commands ----------------
const commands = [
  new SlashCommandBuilder()
    .setName("chat")
    .setDescription("Pari se baat karo 💕")
    .addStringOption((opt) =>
      opt.setName("message").setDescription("Kya kehna hai?").setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName("reset")
    .setDescription("Pari ki memory reset karo 🔄"),

  new SlashCommandBuilder()
    .setName("mode")
    .setDescription("Is channel ka current mode check karo"),

  new SlashCommandBuilder()
    .setName("gif")
    .setDescription("Pari ek GIF bhejegi 🎬")
    .addStringOption((opt) =>
      opt.setName("query").setDescription("Kaunsi GIF? (jaise: cute hug)").setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName("waifu")
    .setDescription("Pari anime pic/GIF bhejegi (NSFW channel mein 18+ milta hai) 🌸")
    .addStringOption((opt) =>
      opt.setName("type").setDescription("Kya chahiye?").addChoices(
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
];

// ---------------- Ready → register commands ----------------
client.once("clientReady", async () => {
  try {
    const rest = new REST({ version: "10" }).setToken(config.discordToken);
    await rest.put(Routes.applicationCommands(client.user.id), {
      body: commands.map((c) => c.toJSON()),
    });
    console.log(`✅ Pari online hai — ${client.user.tag}`);
  } catch (err) {
    console.error("❌ Command registration error:", err);
  }
});

// ---------------- Messages (mention ya DM par reply) ----------------
client.on("messageCreate", async (message) => {
  if (message.author.bot) return;

  const mentioned = message.mentions.users.has(client.user.id);
  const isDM = !message.guild;
  if (!mentioned && !isDM) return;

  try {
    await message.channel.sendTyping();
    const isNsfwChannel = message.channel.isNSFW?.() ?? false;
    const userText =
      message.cleanContent.replace(/<@!?\d+>/g, "").trim() || "hi";
    const reply = await getLLMReply(message.channel.id, userText, isNsfwChannel);
    await sendPariReply(message.channel, reply, isNsfwChannel);
  } catch (err) {
    console.error("LLM error:", err?.message || err);
    await message
      .reply("Uff~ 😳 thodi technical dikkat ho gayi, ek baar phir bolo na! ✨")
      .catch(() => {});
  }
});

// ---------------- Interactions ----------------
client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  try {
    const isNsfwChannel = interaction.channel?.isNSFW?.() ?? false;

    // /chat
    if (interaction.commandName === "chat") {
      const userText = interaction.options.getString("message");
      await interaction.deferReply();
      const reply = await getLLMReply(interaction.channel.id, userText, isNsfwChannel);
      const { text, files } = await extractImages(reply, isNsfwChannel);
      const payload = { content: text || "Ye lo~ 🌸✨" };
      if (files.length) payload.files = files;
      await interaction.editReply(payload);
      return;
    }

    // /reset
    if (interaction.commandName === "reset") {
      memory.delete(interaction.channel.id);
      await interaction.reply("Memory reset ho gayi! 🔄 Ab fresh start karein~ 💕");
      return;
    }

    // /mode
    if (interaction.commandName === "mode") {
      await interaction.reply(
        isNsfwChannel
          ? "🔥 Ye NSFW channel hai — 18+ mode ON hai!"
          : "🌸 Ye normal channel hai — sirf SFW mode."
      );
      return;
    }

    // /gif
    if (interaction.commandName === "gif") {
      const query = interaction.options.getString("query");
      await interaction.deferReply();
      const url = await fetchGif(query, isNsfwChannel ? "off" : "high");
      if (url) await interaction.editReply(url);
      else await interaction.editReply("Uff~ 🥺 GIF nahi mili, dobara try karo na!");
      return;
    }

    // /waifu
    if (interaction.commandName === "waifu") {
      const type = interaction.options.getString("type") || "sfw_pic";

      // 18+ sirf NSFW channel mein — warna cute refusal
      if (type !== "sfw_pic" && !isNsfwChannel) {
        return interaction.reply(
          "Hehe~ 🙈 ye sirf NSFW channel mein milega na! Wahan aao ✨"
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
        await interaction.editReply({ content: "Ye lo~ 💦✨", files: [url] });
      } else {
        await interaction.editReply(
          "Uff~ 🥺 sources busy hain, thodi der baad try karo na!"
        );
      }
      return;
    }
  } catch (err) {
    console.error("Interaction error:", err?.message || err);
    const msg = "Uff~ 😳 kuch gadbad ho gayi, phir se try karo na! ✨";
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply(msg).catch(() => {});
    } else {
      await interaction.reply(msg).catch(() => {});
    }
  }
});

// ---------------- Login ----------------
client.login(config.discordToken);
