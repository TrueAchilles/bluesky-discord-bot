const { Client, GatewayIntentBits, EmbedBuilder, PermissionFlagsBits } = require('discord.js');
const { BskyAgent } = require('@atproto/api');

// Configuration - uses environment variables for security
const config = {
  discord: {
    token: process.env.DISCORD_TOKEN || 'YOUR_DISCORD_BOT_TOKEN',
    channelId: process.env.DISCORD_CHANNEL_ID || 'YOUR_CHANNEL_ID',
    adminRoleId: process.env.ADMIN_ROLE_ID || null
  },
  bluesky: {
    handles: process.env.BLUESKY_HANDLES ? 
      process.env.BLUESKY_HANDLES.split(',').map(h => h.trim()) : 
      ['user.bsky.social'],
    checkInterval: parseInt(process.env.CHECK_INTERVAL) || 60000
  },
  filter: {
    keywords: process.env.FILTER_KEYWORDS ? 
      process.env.FILTER_KEYWORDS.split(',').map(k => k.trim().toLowerCase()) : 
      [],
    mode: process.env.FILTER_MODE || 'none',
    caseSensitive: process.env.FILTER_CASE_SENSITIVE === 'true'
  }
};

// Initialize Discord client with message content intent
const discord = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

// Initialize Bluesky agent
const agent = new BskyAgent({
  service: 'https://bsky.social'
});

// Track the last seen post for each account
const lastSeenPosts = new Map();

// Check if user has permission to use bot commands
function hasPermission(member) {
  if (config.discord.adminRoleId) {
    return member.roles.cache.has(config.discord.adminRoleId);
  }
  return member.permissions.has(PermissionFlagsBits.ManageGuild);
}

// Validate Bluesky handle format
function isValidHandle(handle) {
  // Basic validation: should contain a dot and no spaces
  return handle.includes('.') && !handle.includes(' ') && handle.length > 3;
}

// Handle bot commands
async function handleCommand(message) {
  if (message.author.bot) return;

  const content = message.content.trim();
  
  if (!content.startsWith('!bsky')) return;

  if (!hasPermission(message.member)) {
    await message.reply('❌ You need Manage Server permission to use bot commands.');
    return;
  }

  const args = content.slice(5).trim().split(/\s+/);
  const command = args[0]?.toLowerCase();

  try {
    switch (command) {
      // Account management commands
      case 'follow':
        // Follow a new account: !bsky follow username.bsky.social
        if (args.length < 2) {
          await message.reply('Usage: `!bsky follow <handle.bsky.social>`\nExample: `!bsky follow jack.bsky.social`');
          return;
        }
        const handleToFollow = args[1].toLowerCase();
        if (!isValidHandle(handleToFollow)) {
          await message.reply('❌ Invalid handle format. Use format: `username.bsky.social`');
          return;
        }
        if (config.bluesky.handles.includes(handleToFollow)) {
          await message.reply(`❌ Already following @${handleToFollow}`);
          return;
        }
        
        // Verify the account exists
        try {
          await agent.getProfile({ actor: handleToFollow });
          config.bluesky.handles.push(handleToFollow);
          lastSeenPosts.set(handleToFollow, null);
          await message.reply(`✅ Now following @${handleToFollow}\nTotal accounts: ${config.bluesky.handles.length}`);
        } catch (error) {
          await message.reply(`❌ Could not find Bluesky account: @${handleToFollow}`);
        }
        break;

      case 'unfollow':
        // Unfollow an account: !bsky unfollow username.bsky.social
        if (args.length < 2) {
          await message.reply('Usage: `!bsky unfollow <handle.bsky.social>`');
          return;
        }
        const handleToUnfollow = args[1].toLowerCase();
        const index = config.bluesky.handles.indexOf(handleToUnfollow);
        if (index === -1) {
          await message.reply(`❌ Not following @${handleToUnfollow}`);
          return;
        }
        config.bluesky.handles.splice(index, 1);
        lastSeenPosts.delete(handleToUnfollow);
        await message.reply(`✅ Unfollowed @${handleToUnfollow}\nTotal accounts: ${config.bluesky.handles.length}`);
        break;

      case 'accounts':
        // List all followed accounts: !bsky accounts
        if (config.bluesky.handles.length === 0) {
          await message.reply('📋 Not following any accounts yet. Use `!bsky follow <handle>` to add one.');
          return;
        }
        const accountList = config.bluesky.handles.map((h, i) => `${i + 1}. @${h}`).join('\n');
        await message.reply(`📋 **Following ${config.bluesky.handles.length} account(s):**\n${accountList}`);
        break;

      // Keyword filter commands
      case 'add':
        if (args.length < 2) {
          await message.reply('Usage: `!bsky add <keyword1> <keyword2> ...`');
          return;
        }
        const newKeywords = args.slice(1).map(k => k.toLowerCase());
        newKeywords.forEach(kw => {
          if (!config.filter.keywords.includes(kw)) {
            config.filter.keywords.push(kw);
          }
        });
        await message.reply(`✅ Added keywords: ${newKeywords.join(', ')}\nCurrent keywords: ${config.filter.keywords.join(', ')}`);
        break;

      case 'remove':
        if (args.length < 2) {
          await message.reply('Usage: `!bsky remove <keyword1> <keyword2> ...`');
          return;
        }
        const toRemove = args.slice(1).map(k => k.toLowerCase());
        toRemove.forEach(kw => {
          const idx = config.filter.keywords.indexOf(kw);
          if (idx > -1) {
            config.filter.keywords.splice(idx, 1);
          }
        });
        await message.reply(`✅ Removed keywords: ${toRemove.join(', ')}\nCurrent keywords: ${config.filter.keywords.join(', ') || 'None'}`);
        break;

      case 'keywords':
        // List current keywords: !bsky keywords
        const keywordList = config.filter.keywords.length > 0 
          ? config.filter.keywords.join(', ') 
          : 'No keywords set';
        await message.reply(`📋 **Keywords:** ${keywordList}`);
        break;

      case 'clear':
        config.filter.keywords = [];
        await message.reply('✅ All keywords cleared.');
        break;

      case 'mode':
        if (args.length < 2) {
          await message.reply('Usage: `!bsky mode <include|exclude|none>`');
          return;
        }
        const mode = args[1].toLowerCase();
        if (!['include', 'exclude', 'none'].includes(mode)) {
          await message.reply('❌ Mode must be: `include`, `exclude`, or `none`');
          return;
        }
        config.filter.mode = mode;
        await message.reply(`✅ Filter mode set to: **${mode}**`);
        break;

      case 'case':
        if (args.length < 2) {
          await message.reply('Usage: `!bsky case <on|off>`');
          return;
        }
        const caseSetting = args[1].toLowerCase();
        if (caseSetting === 'on') {
          config.filter.caseSensitive = true;
          await message.reply('✅ Case-sensitive filtering enabled.');
        } else if (caseSetting === 'off') {
          config.filter.caseSensitive = false;
          await message.reply('✅ Case-insensitive filtering enabled.');
        } else {
          await message.reply('❌ Use `on` or `off`');
        }
        break;

      case 'status':
        // Show complete bot status: !bsky status
        const statusEmbed = new EmbedBuilder()
          .setTitle('🦋 Bluesky Bot Status')
          .setColor(0x1185FE)
          .addFields(
            { 
              name: '📊 Accounts Following', 
              value: config.bluesky.handles.length > 0 
                ? config.bluesky.handles.map(h => `• @${h}`).join('\n')
                : 'None',
              inline: false
            },
            { 
              name: '🔍 Filter Mode', 
              value: config.filter.mode,
              inline: true
            },
            { 
              name: '🔤 Case Sensitive', 
              value: config.filter.caseSensitive ? 'Yes' : 'No',
              inline: true
            },
            { 
              name: '🏷️ Keywords', 
              value: config.filter.keywords.length > 0 
                ? config.filter.keywords.join(', ')
                : 'None',
              inline: false
            }
          )
          .setFooter({ text: `Checking every ${config.bluesky.checkInterval / 1000} seconds` });
        await message.reply({ embeds: [statusEmbed] });
        break;

      case 'help':
        const helpEmbed = new EmbedBuilder()
          .setTitle('🦋 Bluesky Bot Commands')
          .setColor(0x1185FE)
          .setDescription('Manage Bluesky account monitoring and filters')
          .addFields(
            { name: '**Account Commands**', value: '\u200b', inline: false },
            { name: '!bsky follow <handle>', value: 'Follow a Bluesky account\nExample: `!bsky follow jack.bsky.social`' },
            { name: '!bsky unfollow <handle>', value: 'Unfollow a Bluesky account' },
            { name: '!bsky accounts', value: 'List all followed accounts' },
            { name: '**Filter Commands**', value: '\u200b', inline: false },
            { name: '!bsky add <keywords>', value: 'Add filter keywords\nExample: `!bsky add AI crypto`' },
            { name: '!bsky remove <keywords>', value: 'Remove filter keywords' },
            { name: '!bsky keywords', value: 'List current keywords' },
            { name: '!bsky clear', value: 'Clear all keywords' },
            { name: '!bsky mode <type>', value: '`include` = only post matching\n`exclude` = skip matching\n`none` = post all' },
            { name: '!bsky case <on|off>', value: 'Toggle case-sensitive filtering' },
            { name: '**Other Commands**', value: '\u200b', inline: false },
            { name: '!bsky status', value: 'Show complete bot status' },
            { name: '!bsky help', value: 'Show this help message' }
          );
        await message.reply({ embeds: [helpEmbed] });
        break;

      default:
        await message.reply('Unknown command. Use `!bsky help` for available commands.');
    }
  } catch (error) {
    console.error('Error handling command:', error);
    await message.reply('❌ An error occurred processing your command.');
  }
}

// Function to check if post matches filter criteria
function matchesFilter(text) {
  if (config.filter.mode === 'none' || config.filter.keywords.length === 0) {
    return true;
  }

  const searchText = config.filter.caseSensitive ? text : text.toLowerCase();
  const hasKeyword = config.filter.keywords.some(keyword => 
    searchText.includes(config.filter.caseSensitive ? keyword : keyword.toLowerCase())
  );

  if (config.filter.mode === 'include') {
    return hasKeyword;
  }

  if (config.filter.mode === 'exclude') {
    return !hasKeyword;
  }

  return true;
}

// Function to fetch latest post from a Bluesky user
async function getLatestPost(handle) {
  try {
    const response = await agent.getAuthorFeed({
      actor: handle,
      limit: 1
    });

    if (response.data.feed.length > 0) {
      return response.data.feed[0];
    }
    return null;
  } catch (error) {
    console.error(`Error fetching Bluesky post for @${handle}:`, error);
    return null;
  }
}

// Function to post to Discord
async function postToDiscord(post) {
  try {
    const channel = await discord.channels.fetch(config.discord.channelId);
    
    const postData = post.post;
    const author = postData.author;
    const record = postData.record;
    
    // Create embed
    const embed = new EmbedBuilder()
      .setAuthor({
        name: `${author.displayName || author.handle} (@${author.handle})`,
        iconURL: author.avatar,
        url: `https://bsky.app/profile/${author.handle}/post/${postData.uri.split('/').pop()}`
      })
      .setDescription(record.text)
      .setColor(0x1185FE)
      .setTimestamp(new Date(record.createdAt))
      .setFooter({ text: 'Bluesky' });

    // Add image if present
    if (record.embed?.images?.[0]) {
      const imageUrl = record.embed.images[0].fullsize || record.embed.images[0].thumb;
      embed.setImage(imageUrl);
    }

    // Add link preview if present
    if (record.embed?.external) {
      embed.addFields({
        name: 'Link',
        value: `[${record.embed.external.title}](${record.embed.external.uri})`
      });
      if (record.embed.external.thumb) {
        embed.setThumbnail(record.embed.external.thumb);
      }
    }

    await channel.send({ embeds: [embed] });
    console.log(`Posted to Discord from @${author.handle}: ${record.text.substring(0, 50)}...`);
  } catch (error) {
    console.error('Error posting to Discord:', error);
  }
}

// Function to check for new posts from a specific account
async function checkAccountForNewPosts(handle) {
  const latestPost = await getLatestPost(handle);
  
  if (!latestPost) return;
  
  const postUri = latestPost.post.uri;
  const postText = latestPost.post.record.text;
  
  // Get the last seen post for this account
  const lastSeen = lastSeenPosts.get(handle);
  
  // If this is the first check for this account
  if (lastSeen === null || lastSeen === undefined) {
    lastSeenPosts.set(handle, postUri);
    console.log(`Tracking @${handle} - initial post recorded`);
    return;
  }
  
  // If we have a new post
  if (postUri !== lastSeen) {
    console.log(`New post detected from @${handle}`);
    
    // Check if post matches filter criteria
    if (matchesFilter(postText)) {
      console.log(`Post from @${handle} matches filter, posting to Discord...`);
      await postToDiscord(latestPost);
    } else {
      console.log(`Post from @${handle} filtered out based on keywords.`);
    }
    
    lastSeenPosts.set(handle, postUri);
  }
}

// Function to check all accounts for new posts
async function checkAllAccounts() {
  for (const handle of config.bluesky.handles) {
    await checkAccountForNewPosts(handle);
    // Small delay between checks to avoid rate limiting
    await new Promise(resolve => setTimeout(resolve, 500));
  }
}

// Discord bot ready event
discord.once('ready', () => {
  console.log(`Discord bot logged in as ${discord.user.tag}`);
  console.log(`Monitoring ${config.bluesky.handles.length} Bluesky account(s):`);
  config.bluesky.handles.forEach(h => console.log(`  - @${h}`));
  
  // Initialize tracking for all accounts
  config.bluesky.handles.forEach(handle => {
    lastSeenPosts.set(handle, null);
  });
  
  // Start checking for new posts
  checkAllAccounts();
  setInterval(checkAllAccounts, config.bluesky.checkInterval);
});

// Listen for messages (commands)
discord.on('messageCreate', handleCommand);

// Login to Discord
discord.login(config.discord.token);
