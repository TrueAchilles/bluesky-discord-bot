const { Client, GatewayIntentBits, EmbedBuilder, PermissionFlagsBits } = require('discord.js');
const { BskyAgent } = require('@atproto/api');
const fs = require('fs').promises;
const path = require('path');
const http = require('http');
const https = require('https');

// Path to settings file
const SETTINGS_FILE = path.join(__dirname, 'bot-settings.json');

// Health check server for platforms like Render
const PORT = process.env.PORT || 3000;
const RENDER_URL = process.env.RENDER_EXTERNAL_URL; // Render sets this automatically

const server = http.createServer((req, res) => {
  if (req.url === '/health' || req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'ok',
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
      discord: discord.isReady() ? 'connected' : 'disconnected',
      accountsMonitored: config.bluesky.handles.length
    }));
  } else {
    res.writeHead(404);
    res.end('Not Found');
  }
});

server.listen(PORT, () => {
  console.log(`🏥 Health check server running on port ${PORT}`);
  
  // Self-ping every 14 minutes to prevent Render from sleeping
  // (Render free tier sleeps after 15 minutes of inactivity)
  if (RENDER_URL) {
    console.log(`🔄 Self-ping enabled - pinging ${RENDER_URL}/health every 14 minutes`);
    setInterval(() => {
      const url = `${RENDER_URL}/health`;
      // Use https module for HTTPS URLs, http module for HTTP URLs
      const client = url.startsWith('https://') ? https : http;
      
      client.get(url, (res) => {
        console.log(`✅ Self-ping successful (status: ${res.statusCode})`);
      }).on('error', (err) => {
        console.error('⚠️  Self-ping failed:', err.message);
      });
    }, 14 * 60 * 1000); // 14 minutes
  }
});

// Configuration - uses environment variables for security
const config = {
  discord: {
    token: process.env.DISCORD_TOKEN || 'YOUR_DISCORD_BOT_TOKEN',
    channelId: process.env.DISCORD_CHANNEL_ID || 'YOUR_CHANNEL_ID',
    adminRoleIds: process.env.ADMIN_ROLE_IDS ? 
      process.env.ADMIN_ROLE_IDS.split(',').map(id => id.trim()) : 
      []
  },
  bluesky: {
    handle: process.env.BLUESKY_BOT_HANDLE || '', // Your Bluesky handle for authentication
    password: process.env.BLUESKY_BOT_PASSWORD || '', // Your Bluesky app password
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

// Load settings from file
async function loadSettings() {
  try {
    const data = await fs.readFile(SETTINGS_FILE, 'utf8');
    const saved = JSON.parse(data);
    
    // Restore saved settings
    if (saved.handles) config.bluesky.handles = saved.handles;
    if (saved.keywords) config.filter.keywords = saved.keywords;
    if (saved.mode) config.filter.mode = saved.mode;
    if (saved.caseSensitive !== undefined) config.filter.caseSensitive = saved.caseSensitive;
    if (saved.adminRoleIds) config.discord.adminRoleIds = saved.adminRoleIds;
    if (saved.lastSeenPosts) {
      Object.entries(saved.lastSeenPosts).forEach(([handle, uri]) => {
        lastSeenPosts.set(handle, uri);
      });
    }
    
    console.log('✅ Loaded settings from file');
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') {
      console.log('📝 No saved settings found, using defaults');
    } else {
      console.error('⚠️  Error loading settings:', error.message);
    }
    return false;
  }
}

// Save settings to file
async function saveSettings() {
  try {
    const settings = {
      handles: config.bluesky.handles,
      keywords: config.filter.keywords,
      mode: config.filter.mode,
      caseSensitive: config.filter.caseSensitive,
      adminRoleIds: config.discord.adminRoleIds,
      lastSeenPosts: Object.fromEntries(lastSeenPosts),
      lastUpdated: new Date().toISOString()
    };
    
    await fs.writeFile(SETTINGS_FILE, JSON.stringify(settings, null, 2), 'utf8');
    console.log('💾 Settings saved');
    return true;
  } catch (error) {
    console.error('⚠️  Error saving settings:', error.message);
    return false;
  }
}

// Login to Bluesky
async function loginToBluesky() {
  if (!config.bluesky.handle || !config.bluesky.password) {
    console.error('⚠️  Warning: BLUESKY_BOT_HANDLE and BLUESKY_BOT_PASSWORD not set.');
    console.error('⚠️  The bot may not be able to fetch posts. Please add these credentials.');
    return false;
  }

  try {
    await agent.login({
      identifier: config.bluesky.handle,
      password: config.bluesky.password
    });
    console.log(`✅ Logged into Bluesky as @${config.bluesky.handle}`);
    return true;
  } catch (error) {
    console.error('❌ Failed to login to Bluesky:', error.message);
    console.error('Please check your BLUESKY_BOT_HANDLE and BLUESKY_BOT_PASSWORD');
    return false;
  }
}

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
        await saveSettings();
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
        await saveSettings();
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
        await saveSettings();
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
        await saveSettings();
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
        await saveSettings();
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
          await saveSettings();
          await message.reply('✅ Case-sensitive filtering enabled.');
        } else if (caseSetting === 'off') {
          config.filter.caseSensitive = false;
          await saveSettings();
          await message.reply('✅ Case-insensitive filtering enabled.');
        } else {
          await message.reply('❌ Use `on` or `off`');
        }
        break;

      case 'roles':
        // Manage authorized roles: !bsky roles add/remove/list
        if (args.length < 2) {
          await message.reply('Usage: `!bsky roles <add|remove|list> [role ID or @mention]`\nExample: `!bsky roles add @Moderator`');
          return;
        }
        
        // Only server admins can modify role permissions
        if (!message.member.permissions.has(PermissionFlagsBits.ManageGuild)) {
          await message.reply('❌ Only server administrators can modify role permissions.');
          return;
        }
        
        const roleAction = args[1].toLowerCase();
        
        if (roleAction === 'list') {
          if (config.discord.adminRoleIds.length === 0) {
            await message.reply('📋 **Authorized Roles:** None configured\n\nUsers with "Manage Server" permission can use bot commands.');
            return;
          }
          const roleList = config.discord.adminRoleIds.map(id => {
            const role = message.guild.roles.cache.get(id);
            return role ? `• ${role.name} (${id})` : `• Unknown Role (${id})`;
          }).join('\n');
          await message.reply(`📋 **Authorized Roles:**\n${roleList}\n\nUsers with these roles can use bot commands.`);
        } else if (roleAction === 'add') {
          if (args.length < 3) {
            await message.reply('Usage: `!bsky roles add <role ID or @mention>`\nExample: `!bsky roles add @Moderator`');
            return;
          }
          
          // Extract role ID from mention or direct ID
          let roleId = args[2].replace(/[<@&>]/g, '');
          const role = message.guild.roles.cache.get(roleId);
          
          if (!role) {
            await message.reply('❌ Could not find that role. Use a role mention (@Role) or role ID.');
            return;
          }
          
          if (config.discord.adminRoleIds.includes(roleId)) {
            await message.reply(`❌ Role ${role.name} is already authorized.`);
            return;
          }
          
          config.discord.adminRoleIds.push(roleId);
          await saveSettings();
          await message.reply(`✅ Added ${role.name} to authorized roles.\nMembers with this role can now use bot commands.`);
        } else if (roleAction === 'remove') {
          if (args.length < 3) {
            await message.reply('Usage: `!bsky roles remove <role ID or @mention>`');
            return;
          }
          
          let roleId = args[2].replace(/[<@&>]/g, '');
          const idx = config.discord.adminRoleIds.indexOf(roleId);
          
          if (idx === -1) {
            await message.reply('❌ That role is not in the authorized list.');
            return;
          }
          
          const role = message.guild.roles.cache.get(roleId);
          config.discord.adminRoleIds.splice(idx, 1);
          await saveSettings();
          await message.reply(`✅ Removed ${role ? role.name : 'role'} from authorized roles.`);
        } else {
          await message.reply('Usage: `!bsky roles <add|remove|list>`');
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
            },
            {
              name: '👥 Authorized Roles',
              value: config.discord.adminRoleIds.length > 0
                ? config.discord.adminRoleIds.map(id => {
                    const role = message.guild.roles.cache.get(id);
                    return role ? role.name : 'Unknown';
                  }).join(', ')
                : 'Manage Server permission required',
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
            { name: '**Permission Commands**', value: '\u200b', inline: false },
            { name: '!bsky roles add @Role', value: 'Authorize a role to use bot commands (Admin only)' },
            { name: '!bsky roles remove @Role', value: 'Remove role authorization (Admin only)' },
            { name: '!bsky roles list', value: 'List authorized roles' },
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
    const postUri = postData.uri;
    
    // Double-check we haven't posted this already (extra safety)
    const handle = author.handle;
    if (lastSeenPosts.get(handle) === postUri) {
      console.log(`⚠️  Duplicate detected - skipping post from @${handle}`);
      return;
    }
    
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
    console.log(`✅ Posted to Discord from @${author.handle}: ${record.text.substring(0, 50)}...`);
  } catch (error) {
    console.error('❌ Error posting to Discord:', error);
    // Don't throw - we want to continue checking other accounts
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
    await saveSettings();
    console.log(`Tracking @${handle} - initial post recorded`);
    return;
  }
  
  // If we have a new post (URI is different from last seen)
  if (postUri !== lastSeen) {
    console.log(`New post detected from @${handle}`);
    
    // Check if post matches filter criteria
    if (matchesFilter(postText)) {
      console.log(`Post from @${handle} matches filter, posting to Discord...`);
      await postToDiscord(latestPost);
      
      // Update last seen post AFTER successfully posting to Discord
      lastSeenPosts.set(handle, postUri);
      await saveSettings();
    } else {
      console.log(`Post from @${handle} filtered out based on keywords.`);
      // Still update last seen even if filtered, to prevent re-checking
      lastSeenPosts.set(handle, postUri);
      await saveSettings();
    }
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
discord.once('ready', async () => {
  console.log(`Discord bot logged in as ${discord.user.tag}`);
  
  // Load saved settings first
  await loadSettings();
  
  // Login to Bluesky
  const loggedIn = await loginToBluesky();
  
  if (!loggedIn) {
    console.error('⚠️  Bot started but cannot fetch Bluesky posts without authentication.');
    console.error('⚠️  Please set BLUESKY_BOT_HANDLE and BLUESKY_BOT_PASSWORD environment variables.');
    return;
  }
  
  console.log(`Monitoring ${config.bluesky.handles.length} Bluesky account(s):`);
  config.bluesky.handles.forEach(h => console.log(`  - @${h}`));
  
  // Initialize tracking for all accounts (don't override loaded values)
  config.bluesky.handles.forEach(handle => {
    if (!lastSeenPosts.has(handle)) {
      lastSeenPosts.set(handle, null);
    }
  });
  
  // Start checking for new posts
  checkAllAccounts();
  setInterval(checkAllAccounts, config.bluesky.checkInterval);
});

// Listen for messages (commands)
discord.on('messageCreate', handleCommand);

// Login to Discord
discord.login(config.discord.token);
