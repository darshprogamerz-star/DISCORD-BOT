/**
 * Pari 💕 — Cute Anime Girl Companion Bot
 * Hindi / Hinglish / English | 18+ mode ONLY in NSFW channels
 * Deploy: Railway (GitHub se)
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
  return config.basePersona + (isNsfwChannel ? config.nsfwRules : config.sfwRules);
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
    reply = "Uff~ 😳 thodi technical dikkat ho gayi, ek baar phir bolo na! ✨";
  }

  hist.push({ role: "assistant", content: reply });
  while (hist.length > config.maxHistory) hist.shift();
  return reply;
}

// ---------------- Slash Commands ----------------
const commands = [
  new SlashCommandBuilder()
    .setName("chat")
    .setDescription("Pari se baat karo 💕")
    .addStringOption((opt) =>
      opt.setName("message").setDescription("Pari ko kya kehna hai?").setRequired(true)
    ),
  new SlashCommandBuilder().setName("reset").setDescription("Pari ki memory reset karo (is channel mein)"),
  new SlashCommandBuilder().setName("mode").setDescription("Check karo Pari ka current mode"),
].map((c) => c.toJSON());

// ---------------- Ready ----------------
client.once("ready", async () => {
  console.log(`✅ Pari online hai — ${client.user.tag}`);
  try {
    await new REST({ version: "10" }).put(
      Routes.applicationCommands(client.user.id),
      { body: commands }
    );
    console.log("✅ Slash commands registered!");
  } catch (err) {
    console.error("Slash register error:", err);
  }
  // Cute presence
  client.user.setActivity("aapke messages 💕", { type: 3 }); // WATCHING
});

// ---------------- Auto Chat (mention / DM / reply) ----------------
client.on("messageCreate", async (message) => {
  if (message.author.bot) return;

  const mentioned = message.mentions.has(client.user);
  const isDm = !message.guild;
  const isReplyToPari =
    message.reference &&
    message.reference.messageId;

  let isReplyToBot = false;
  if (isReplyToPari) {
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
    const reply = await pariReply(message.channel, message.author.username, content);
    await message.reply(reply);
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
    const reply = await pariReply(interaction.channel, interaction.user.username, msg);
    await interaction.editReply(reply);
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