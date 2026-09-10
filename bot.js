/**
 * Pari 💕 — Cute Anime Girl Companion Bot (FINAL)
 * Hindi / Hinglish / English | 18+ mode ONLY in NSFW channels
 *
 * Features:
 *   💕 AI chat (mention / DM / reply se)
 *   🎬 Tenor GIFs — /gif command + mood-based auto GIFs
 *   🌸 waifu.im anime images/GIFs — /waifu command (18+ sirf NSFW channel mein)
 *   🔄 /reset (memory) aur /mode (current mode check)
 *
 * Environment Variables (Railway → Variables):
 *   DISCORD_TOKEN   (required)
 *   LLM_API_KEY     (required — Groq free)
 *   LLM_MODEL       (optional — default: openai/gpt-oss-120b)
 *   TENOR_API_KEY   (optional — GIFs ke liye)
 */

const {
  Client,
  GatewayIntentBits,
  Partials,
  SlashCommandBuilder,
  REST,
  Routes,
} = require("discord.js");
const OpenAI = require("openai");
const config = require("./config.js");

// ---------------- LLM Client ----------------
const llm = new OpenAI({
  apiKey: config.llmApiKey,
  baseURL: config.llmBaseUrl,
});

// ---------------- Discord Client ----------------
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
  ],
  partials: [Partials.Channel],
});

// Per-channel chat memory: Map<channelId, [{role, content}]>
const history = new Map();

// ---------------- Persona ----------------
function buildSystemPrompt(isNsfwChannel) {
  let prompt = config.basePersona + (isNsfwChannel ? config.nsfwRules : config.sfwRules);

  if (config.tenorApiKey) {
    prompt += `
GIF RULE:
- Jab mood GIF ke liye perfect ho (hug chahiye, user sad hai, celebrate kar rahe hain,
  blush kar rahi ho, good morning/night, etc.) to apne reply ke END mein ye tag add karo:
  [GIF: 2-3 english keywords]
  Example: [GIF: anime hug] ya [GIF: cute blush]
- Har message mein GIF nahi — sirf jab actually cute lage. Zyada-tar messages sirf text.
- Tag ke baad kuch aur na likho.
`;
  }
  return prompt;
}

// ---------------- Tenor GIF Fetch ----------------
async function fetchGif(query, isNsfw) {
  if (!config.tenorApiKey) return null;
  try {
    const params = new URLSearchParams({
      q: query,
      key: config.tenorApiKey,
      limit: "20",
      random: "true",
      contentfilter: isNsfw ? "off" : "high",
      media_filter: "gif",
    });
    const res = await fetch(`https://tenor.googleapis.com/v2/search?${params}`);
    const data = await res.json();
    const results = data.results || [];
    if (!results.length) return null;
    const pick = results[Math.floor(Math.random() * results.length)];
    return pick.media_formats?.gif?.url || pick.media_formats?.tinygif?.url || null;
  } catch (err) {
    console.error("Tenor error:", err?.message || err);
    return null;
  }
}

// ---------------- waifu.im — Anime Images/GIFs ----------------
async function fetchWaifu(isNsfw, wantGif) {
  try {
    const params = new URLSearchParams({
      is_nsfw: isNsfw ? "true" : "false",
      gif: wantGif ? "true" : "false",
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

// Reply se [GIF: ...] tag nikaalo → { text, gifQuery }
function parseGifTag(reply) {
  const match = reply.match(/\[GIF:\s*([^\]]+)\]/i);
  if (!match) return { text: reply, gifQuery: null };
  return {
    text: reply.replace(match[0], "").trim(),
    gifQuery: match[1].trim(),
  };
}

// ---------------- LLM Reply ----------------
async function pariReply(channel, userName, userMsg) {
  const chId = channel.id;
  const isNsfw = typeof channel.isNSFW === "function" ? channel.isNSFW() : false;

  if (!history.has(chId)) history.set(chId, []);
  const hist = history.get(chId);

  hist.push({ role: "user", content: `${userName}: ${userMsg}` });

  const messages = [
    { role: "system", content: buildSystemPrompt(isNsfw) },
    ...hist.slice(-config.maxHistory),
  ];

  let reply;
  try {
    const res = await llm.chat.completions.create({
      model: config.llmModel,
      messages,
      max_tokens: config.maxTokens,
      temperature: config.temperature,
    });
    reply = res.choices[0].message.content.trim();
  } catch (err) {
    console.error("LLM error:", err?.message || err);
    return { text: "Uff~ 😳 thodi technical dikkat ho gayi, ek baar phir bolo na! ✨", gifUrl: null };
  }

  hist.push({ role: "assistant", content: reply });
  while (hist.length > config.maxHistory) hist.shift();

  const { text, gifQuery } = parseGifTag(reply);
  let gifUrl = null;
  if (gifQuery && config.tenorApiKey) {
    gifUrl = await fetchGif(gifQuery, isNsfw);
  }
  return { text, gifUrl };
}

// ---------------- Reply Bhejne ka Helper ----------------
async function sendPariMessage(channel, result) {
  if (result.gifUrl) {
    await channel.send({ content: result.text || undefined, files: [result.gifUrl] });
  } else {
    await channel.send(result.text);
  }
}

// ---------------- Slash Commands ----------------
const commands = [
  new SlashCommandBuilder()
    .setName("chat")
    .setDescription("Pari se baat karo 💕")
    .addStringOption((opt) =>
      opt.setName("message").setDescription("Pari ko kya kehna hai?").setRequired(true)
    ),
  new SlashCommandBuilder()
    .setName("gif")
    .setDescription("Pari se GIF mangwao 🎬")
    .addStringOption((opt) =>
      opt.setName("query").setDescription("Kaunsi GIF? (jaise: cute hug, happy dance)").setRequired(true)
    ),
  new SlashCommandBuilder()
    .setName("waifu")
    .setDescription("Pari ek anime waifu pic/gif bhejegi 🌸 (18+ sirf NSFW channel mein)")
    .addStringOption((opt) =>
      opt.setName("type").setDescription("Kya chahiye?")
        .addChoices(
          { name: "🌸 Cute pic (SFW)", value: "sfw_pic" },
          { name: "😳 18+ pic", value: "nsfw_pic" },
          { name: "🎬 18+ GIF", value: "nsfw_gif" },
        )
    ),
  new SlashCommandBuilder().setName("reset").setDescription("Pari ki memory reset karo (is channel mein)"),
  new SlashCommandBuilder().setName("mode").setDescription("Check karo Pari ka current mode"),
].map((c) => c.toJSON());

// ---------------- Ready ----------------
client.once("ready", async () => {
  console.log(`✅ Pari online hai — ${client.user.tag}`);
  if (!config.tenorApiKey) console.log("⚠️ TENOR_API_KEY set nahi hai — Tenor GIFs off hain (/waifu phir bhi chalega)");
  try {
    await new REST({ version: "10" }).put(
      Routes.applicationCommands(client.user.id),
      { body: commands }
    );
    console.log("✅ Slash commands registered!");
  } catch (err) {
    console.error("Slash register error:", err);
  }
  client.user.setActivity("aapke messages 💕", { type: 3 });
});

// ---------------- Auto Chat (mention / DM / reply) ----------------
client.on("messageCreate", async (message) => {
  if (message.author.bot) return;

  const mentioned = message.mentions.has(client.user);
  const isDm = !message.guild;

  let isReplyToBot = false;
  if (message.reference && message.reference.messageId) {
    try {
      const ref = await message.fetchReference();
      isReplyToBot = ref.author.id === client.user.id;
    } catch (_) {}
  }

  if (!mentioned && !isDm && !isReplyToBot) return;

  let content = message.content.replace(/<@!?(\d+)>/g, "").trim();
  if (!content) content = "hehe hi~";

  try {
    await message.channel.sendTyping();
    const result = await pariReply(message.channel, message.author.username, content);
    await sendPariMessage(message.channel, result);
  } catch (err) {
    console.error("Reply error:", err);
  }
});

// ---------------- Slash Command Handler ----------------
client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  const isNsfw = interaction.channel && interaction.channel.isNSFW();

  if (interaction.commandName === "chat") {
    await interaction.deferReply();
    const msg = interaction.options.getString("message");
    const result = await pariReply(interaction.channel, interaction.user.username, msg);
    if (result.gifUrl) {
      await interaction.editReply({ content: result.text || undefined, files: [result.gifUrl] });
    } else {
      await interaction.editReply(result.text);
    }
  }

  if (interaction.commandName === "gif") {
    const query = interaction.options.getString("query");
    await interaction.deferReply();
    const gifUrl = await fetchGif(query, isNsfw);
    if (gifUrl) {
      await interaction.editReply({ content: `Ye lo~ 🎬✨`, files: [gifUrl] });
    } else {
      await interaction.editReply(
        config.tenorApiKey
          ? "Oops~ 🥺 ye GIF nahi mili, kuch aur try karo na!"
          : "GIFs ke liye TENOR_API_KEY set karna hoga! 🙈 (Railway Variables mein)"
      );
    }
  }

  if (interaction.commandName === "waifu") {
    const type = interaction.options.getString("type") || "sfw_pic";
    const isNsfwChannel = isNsfw;

    // 18+ sirf NSFW channel mein — warna cute refusal
    if (type !== "sfw_pic" && !isNsfwChannel) {
      return interaction.reply("Hehe~ 🙈 ye sirf NSFW channel mein milega na! Wahan aao ✨");
    }

    await interaction.deferReply();
    const wantGif = type === "nsfw_gif";
    const url = await fetchWaifu(type !== "sfw_pic", wantGif);
    if (url) {
      await interaction.editReply({ content: "Ye lo~ 🌸✨", files: [url] });
    } else {
      await interaction.editReply("Uff~ 🥺 abhi kuch nahi mila, thodi der baad try karo na!");
    }
  }

  if (interaction.commandName === "reset") {
    history.delete(interaction.channelId);
    await interaction.reply("Memory fresh ho gayi~ 🌸 Naya start karte hain! 💕");
  }

  if (interaction.commandName === "mode") {
    if (isNsfw) {
      await interaction.reply("😳💕 18+ girlfriend mode ON hai yahan~ hihi ✨");
    } else {
      await interaction.reply("🌸 Cute friendly mode ON hai! 18+ baatein ke liye NSFW channel mein aao~ 🙈");
    }
  }
});

// ---------------- Start ----------------
client.login(config.discordToken);
