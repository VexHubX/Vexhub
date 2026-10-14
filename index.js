
const {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  PermissionsBitField
} = require("discord.js");

const fs = require("node:fs");
const path = require("node:path");

// VEX NOTIFY — persistent FadeHost storage
const PREFIX = ".";
const DATA_FILE = "/data/data.json";
const POLL_INTERVAL = 60_000;

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

// ---------- DATA STORAGE ----------

fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });

function loadData() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const parsed = JSON.parse(
        fs.readFileSync(DATA_FILE, "utf8")
      );

      return {
        guilds: parsed.guilds || {},
        subscriptions: Array.isArray(parsed.subscriptions)
          ? parsed.subscriptions
          : []
      };
    }
  } catch (error) {
    console.error("Failed to load data:", error);
  }

  return { guilds: {}, subscriptions: [] };
}

let data = loadData();

function saveData() {
  const temporaryFile = DATA_FILE + ".tmp";

  fs.writeFileSync(
    temporaryFile,
    JSON.stringify(data, null, 2),
    "utf8"
  );

  fs.renameSync(temporaryFile, DATA_FILE);
}

function isManager(message) {
  return message.member?.permissions.has(
    PermissionsBitField.Flags.ManageGuild
  );
}

function getGuildSettings(guildId) {
  if (!data.guilds[guildId]) {
    data.guilds[guildId] = { channelId: null };
  }

  return data.guilds[guildId];
}

// ---------- YOUTUBE FEED ----------

function decodeXML(value = "") {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

async function getLatestVideo(channelId) {
  if (!/^UC[a-zA-Z0-9_-]{22}$/.test(channelId)) {
    throw new Error("Invalid YouTube channel ID.");
  }

  const url =
    "https://www.youtube.com/feeds/videos.xml?channel_id=" +
    encodeURIComponent(channelId);

  const response = await fetch(url, {
    headers: { "User-Agent": "VexNotify/1.0" },
    signal: AbortSignal.timeout(15000)
  });

  if (!response.ok) {
    throw new Error(`YouTube returned HTTP ${response.status}`);
  }

  const xml = await response.text();
  const entry = xml.match(/<entry>([\s\S]*?)<\/entry>/);

  if (!entry) return null;

  const content = entry[1];

  const videoId = content.match(
    /<yt:videoId>([\s\S]*?)<\/yt:videoId>/
  )?.[1]?.trim();

  const title = decodeXML(
    content.match(/<title>([\s\S]*?)<\/title>/)?.[1]?.trim()
      || "New YouTube video"
  );

  const author = decodeXML(
    content.match(/<name>([\s\S]*?)<\/name>/)?.[1]?.trim()
      || "YouTube creator"
  );

  const published = content.match(
    /<published>([\s\S]*?)<\/published>/
  )?.[1]?.trim();

  if (!videoId) return null;

  return {
    videoId,
    title,
    author,
    published,
    url: `https://www.youtube.com/watch?v=${videoId}`
  };
}

function makeVideoEmbed(video, channelId) {
  return new EmbedBuilder()
    .setColor(0xFF0000)
    .setAuthor({
      name: `${video.author} uploaded a video!`,
      url: `https://www.youtube.com/channel/${channelId}`
    })
    .setTitle(video.title)
    .setURL(video.url)
    .setDescription(
      `[▶ Watch on YouTube](${video.url})`
    )
    .setThumbnail(
      `https://i.ytimg.com/vi/${video.videoId}/hqdefault.jpg`
    )
    .setTimestamp(
      video.published ? new Date(video.published) : new Date()
    )
    .setFooter({ text: "Vex Notify" });
}

// ---------- COMMANDS ----------

client.on("messageCreate", async (message) => {
  if (message.author.bot || !message.guild) return;
  if (!message.content.startsWith(PREFIX)) return;

  const args = message.content.slice(PREFIX.length).trim().split(/\s+/);
  const command = (args.shift() || "").toLowerCase();

  try {
    if (command === "help") {
      const embed = new EmbedBuilder()
        .setColor(0x5865F2)
        .setTitle("Vex Notify — Help")
        .setDescription("YouTube upload notifications for your server.")
        .addFields(
          {
            name: "`.setchannel`",
            value: "Set this channel for upload notifications."
          },
          {
            name: "`.addyoutube UC...`",
            value: "Subscribe to a YouTube channel ID."
          },
          {
            name: "`.removeyoutube UC...`",
            value: "Remove a YouTube subscription."
          },
          {
            name: "`.listyoutube`",
            value: "List this server's subscriptions."
          },
          {
            name: "`.testnotify`",
            value: "Send a test notification."
          }
        )
        .setFooter({ text: "Vex Notify • Prefix: ." });

      return message.reply({ embeds: [embed] });
    }

    if (command === "setchannel") {
      if (!isManager(message)) {
        return message.reply(
          "You need the **Manage Server** permission to use this command."
        );
      }

      const settings = getGuildSettings(message.guild.id);
      settings.channelId = message.channel.id;
      saveData();

      return message.reply(
        `YouTube notifications will be sent to ${message.channel}.`
      );
    }

    if (command === "addyoutube") {
      if (!isManager(message)) {
        return message.reply(
          "You need the **Manage Server** permission to use this command."
        );
      }

      const channelId = args[0];

      if (!channelId || !/^UC[a-zA-Z0-9_-]{22}$/.test(channelId)) {
        return message.reply(
          "Provide a valid YouTube channel ID beginning with `UC`.\n" +
          "Example: `.addyoutube UCxxxxxxxxxxxxxxxxxxxxxx`"
        );
      }

      const exists = data.subscriptions.some(
        (sub) =>
          sub.guildId === message.guild.id &&
          sub.channelId === channelId
      );

      if (exists) {
        return message.reply("That YouTube channel is already subscribed.");
      }

      const loadingMessage = await message.reply(
        "Checking the YouTube channel..."
      );

      let latestVideo;

      try {
        latestVideo = await getLatestVideo(channelId);
      } catch (error) {
        console.error("YouTube check failed:", error);
        return loadingMessage.edit(
          "I couldn't check that channel. Verify the channel ID and try again."
        );
      }

      data.subscriptions.push({
        guildId: message.guild.id,
        channelId,
        lastVideoId: latestVideo?.videoId || null
      });

      saveData();

      return loadingMessage.edit(
        `Subscribed to [this YouTube channel](https://www.youtube.com/channel/${channelId}).\n` +
        "I'll check for new uploads every minute."
      );
    }

    if (command === "removeyoutube") {
      if (!isManager(message)) {
        return message.reply(
          "You need the **Manage Server** permission to use this command."
        );
      }

      const channelId = args[0];

      if (!channelId) {
        return message.reply(
          "Usage: `.removeyoutube UC...`"
        );
      }

      const before = data.subscriptions.length;

      data.subscriptions = data.subscriptions.filter(
        (sub) =>
          !(
            sub.guildId === message.guild.id &&
            sub.channelId === channelId
          )
      );

      if (data.subscriptions.length === before) {
        return message.reply("That subscription wasn't found.");
      }

      saveData();
      return message.reply("YouTube subscription removed.");
    }

    if (command === "listyoutube") {
      const subscriptions = data.subscriptions.filter(
        (sub) => sub.guildId === message.guild.id
      );

      if (subscriptions.length === 0) {
        return message.reply(
          "No YouTube channels are subscribed yet. Use `.addyoutube UC...`."
        );
      }

      const embed = new EmbedBuilder()
        .setColor(0xFF0000)
        .setTitle("YouTube Subscriptions")
        .setDescription(
          subscriptions
            .map(
              (sub, index) =>
                `**${index + 1}.** [YouTube channel]` +
                `(https://www.youtube.com/channel/${sub.channelId})\n` +
                `ID: \`${sub.channelId}\``
            )
            .join("\n\n")
        )
        .setFooter({
          text: `${subscriptions.length} subscription(s)`
        });

      return message.reply({ embeds: [embed] });
    }

    if (command === "testnotify") {
      if (!isManager(message)) {
        return message.reply(
          "You need the **Manage Server** permission to use this command."
        );
      }

      const settings = getGuildSettings(message.guild.id);

      if (!settings.channelId) {
        return message.reply(
          "Set a notification channel first with `.setchannel`."
        );
      }

      const channel = await client.channels.fetch(settings.channelId)
        .catch(() => null);

      if (!channel?.isTextBased() || !channel.send) {
        return message.reply(
          "I can't access the configured notification channel. Run `.setchannel` again."
        );
      }

      const embed = new EmbedBuilder()
        .setColor(0xFF0000)
        .setTitle("Vex Notify — Test Notification")
        .setDescription("Your YouTube notification channel is working!")
        .setFooter({ text: "Vex Notify" })
        .setTimestamp();

      await channel.send({ embeds: [embed] });

      return message.reply("Test notification sent!");
    }
  } catch (error) {
    console.error("Command error:", error);
    return message.reply(
      "Something went wrong while running that command."
    ).catch(() => {});
  }
});

// ---------- AUTOMATIC UPLOAD CHECKS ----------

let checkingFeeds = false;

async function checkYouTubeFeeds() {
  if (checkingFeeds) return;
  checkingFeeds = true;

  try {
    for (const sub of [...data.subscriptions]) {
      try {
        const video = await getLatestVideo(sub.channelId);

        if (!video) continue;

        // First successful check establishes a baseline.
        if (!sub.lastVideoId) {
          sub.lastVideoId = video.videoId;
          saveData();
          continue;
        }

        if (sub.lastVideoId === video.videoId) continue;

        const settings = data.guilds[sub.guildId];
        if (!settings?.channelId) {
          sub.lastVideoId = video.videoId;
          saveData();
          continue;
        }

        const channel = await client.channels.fetch(settings.channelId)
          .catch(() => null);

        if (!channel?.isTextBased() || !channel.send) continue;

        await channel.send({
          embeds: [makeVideoEmbed(video, sub.channelId)]
        });

        sub.lastVideoId = video.videoId;
        saveData();

        // Avoid hammering YouTube if several feeds are subscribed.
        await new Promise((resolve) => setTimeout(resolve, 1000));
      } catch (error) {
        console.error(
          `Feed check failed for ${sub.channelId}:`,
          error.message
        );
      }
    }
  } finally {
    checkingFeeds = false;
  }
}

// ---------- STARTUP ----------

client.once("ready", () => {
  console.log(`Vex Notify is online as ${client.user.tag}`);
  console.log(`Persistent data file: ${DATA_FILE}`);

  checkYouTubeFeeds();
  setInterval(checkYouTubeFeeds, POLL_INTERVAL);
});

client.on("error", (error) => {
  console.error("Discord client error:", error);
});

if (!process.env.DISCORD_TOKEN) {
  console.error(
    "Missing DISCORD_TOKEN. Add your bot token in the hosting service's environment settings."
  );
  process.exit(1);
}

client.login(process.env.DISCORD_TOKEN).catch((error) => {
  console.error("Discord login failed:", error.message);
  process.exit(1);
});
