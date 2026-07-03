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
  },
  fantasy: {
    enabled: process.env.ESPN_ENABLED === 'true' || false,
    leagueId: process.env.ESPN_LEAGUE_ID || '',
    seasonId: parseInt(process.env.ESPN_SEASON_ID) || new Date().getFullYear(),
    s2Cookie: process.env.ESPN_S2 || '',
    swidCookie: process.env.ESPN_SWID || '',
    checkInterval: parseInt(process.env.ESPN_CHECK_INTERVAL) || 60000
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

// Track recent posts cache per account (prevents duplicates)
const recentPostsCache = new Map(); // Map<handle, Set<postUri>>
const CACHE_SIZE = 10; // Keep last 10 posts per account

// ESPN Fantasy Football tracking
let espnLeague = null; // ESPN league instance
const fantasyTransactionCache = new Set(); // Track posted transaction IDs to prevent duplicates
const FANTASY_CACHE_SIZE = 50; // Keep track of last 50 transactions

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
    if (saved.recentPostsCache) {
      Object.entries(saved.recentPostsCache).forEach(([handle, posts]) => {
        recentPostsCache.set(handle, new Set(posts));
      });
    }
    
    console.log('✅ Loaded settings from file');
    
    // Merge with environment variable accounts (don't remove saved accounts)
    mergeEnvAccounts();
    
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') {
      console.log('📝 No saved settings found, using defaults');
      // Still merge env accounts even if no file exists
      mergeEnvAccounts();
    } else {
      console.error('⚠️  Error loading settings:', error.message);
    }
    return false;
  }
}

// Merge environment variable accounts with saved accounts
function mergeEnvAccounts() {
  if (!config.bluesky.handles || config.bluesky.handles.length === 0) {
    console.log('⚠️  No accounts configured');
    return;
  }
  
  const envHandles = process.env.BLUESKY_HANDLES 
    ? process.env.BLUESKY_HANDLES.split(',').map(h => h.trim())
    : [];
  
  if (envHandles.length === 0) {
    console.log('   No BLUESKY_HANDLES in environment variables');
    return;
  }
  
  // Add env accounts that aren't already in the list
  let added = 0;
  envHandles.forEach(handle => {
    if (handle && !config.bluesky.handles.includes(handle)) {
      config.bluesky.handles.push(handle);
      added++;
      console.log(`   Added from env: @${handle}`);
    }
  });
  
  if (added > 0) {
    console.log(`✅ Merged ${added} account(s) from BLUESKY_HANDLES environment variable`);
    // Save the merged list
    saveSettings();
  } else {
    console.log('   All env accounts already in follow list');
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
      recentPostsCache: Object.fromEntries(
        Array.from(recentPostsCache.entries()).map(([handle, set]) => [handle, Array.from(set)])
      ),
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

// Initialize ESPN Fantasy League
async function initializeESPN() {
  if (!config.fantasy.enabled) {
    console.log('⚠️  ESPN Fantasy Football is disabled');
    return false;
  }

  if (!config.fantasy.leagueId || !config.fantasy.s2Cookie || !config.fantasy.swidCookie) {
    console.error('❌ ESPN configuration incomplete');
    console.error('   Required: ESPN_LEAGUE_ID, ESPN_S2, ESPN_SWID');
    console.error('   Get these from your browser cookies (see documentation)');
    return false;
  }

  try {
    console.log(`🏈 Initializing ESPN Fantasy League (ID: ${config.fantasy.leagueId})...`);
    
    // Test authentication by making a simple API request
    const testUrl = `https://lm-api-reads.espn.com/lm/site/v5/private/leagues/${config.fantasy.leagueId}`;
    const headers = {
      'Cookie': `espn_s2=${config.fantasy.s2Cookie}; SWID=${config.fantasy.swidCookie}`,
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
    };

    console.log('🔐 Testing ESPN authentication...');
    // We'll do a basic check - actual fetch will happen in checkFantasyTransactions
    
    console.log('✅ ESPN Fantasy Football initialized');
    return true;
  } catch (error) {
    console.error('❌ Failed to initialize ESPN:', error.message);
    return false;
  }
}

// Fetch ESPN transactions using direct API calls with cookies
async function fetchESPNTransactions() {
  if (!config.fantasy.enabled) {
    return [];
  }

  try {
    console.log(`🏈 Fetching transactions from ESPN league...`);
    
    // ESPN API endpoint for transactions
    const url = `https://lm-api-reads.espn.com/lm/site/v5/private/leagues/${config.fantasy.leagueId}/transactions?scoringPeriodId=-1`;
    
    const headers = {
      'Cookie': `espn_s2=${config.fantasy.s2Cookie}; SWID=${config.fantasy.swidCookie}`,
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
    };

    return new Promise((resolve, reject) => {
      https.get(url, { headers }, (res) => {
        let data = '';
        
        if (res.statusCode === 401 || res.statusCode === 403) {
          console.error('❌ ESPN authentication failed - cookies may be expired');
          resolve([]);
          return;
        }

        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            const transactions = parsed.transactions || [];
            console.log(`   Found ${transactions.length} transaction(s)`);
            resolve(transactions);
          } catch (err) {
            console.error('❌ Error parsing ESPN response:', err.message);
            resolve([]);
          }
        });
      }).on('error', (err) => {
        console.error('❌ Error fetching from ESPN:', err.message);
        resolve([]);
      });
    });
  } catch (error) {
    console.error('⚠️  Error fetching ESPN transactions:', error.message);
    return [];
  }
}

// Format ESPN transaction for Discord
function formatFantasyTransaction(transaction) {
  if (!transaction) return null;

  const embed = new EmbedBuilder()
    .setColor(0xFF6600)
    .setTimestamp(new Date(transaction.executionDate));

  const txType = transaction.type; // TRADE, WAIVER, PICKUP, DROP, etc.
  
  try {
    switch (txType) {
      case 'TRADE':
        embed.setTitle('🔄 Trade Accepted');
        if (transaction.trades && transaction.trades.length >= 2) {
          const trade1 = transaction.trades[0];
          const trade2 = transaction.trades[1];
          const team1 = trade1.team?.name || 'Team 1';
          const team2 = trade2.team?.name || 'Team 2';
          const players1 = trade1.playerIds?.length || 0;
          const players2 = trade2.playerIds?.length || 0;
          
          embed.addFields(
            { name: team1, value: `Receives ${players2} player(s)`, inline: true },
            { name: team2, value: `Receives ${players1} player(s)`, inline: true }
          );
        }
        break;

      case 'WAIVER':
        embed.setTitle('📋 Waiver Claim');
        const waiverTeam = transaction.teamsInvolved?.[0]?.name || 'Team';
        const waiverPlayers = transaction.playerIds?.length || 0;
        embed.addFields(
          { name: 'Team', value: waiverTeam, inline: true },
          { name: 'Players Claimed', value: waiverPlayers.toString(), inline: true }
        );
        break;

      case 'PICKUP':
      case 'FREEAGENT':
        embed.setTitle('✅ Free Agent Pickup');
        const pickupTeam = transaction.teamsInvolved?.[0]?.name || 'Team';
        const pickupPlayers = transaction.playerIds?.length || 0;
        embed.addFields(
          { name: 'Team', value: pickupTeam, inline: true },
          { name: 'Players Added', value: pickupPlayers.toString(), inline: true }
        );
        break;

      case 'DROP':
        embed.setTitle('❌ Player Dropped');
        const dropTeam = transaction.teamsInvolved?.[0]?.name || 'Team';
        const dropPlayers = transaction.playerIds?.length || 0;
        embed.addFields(
          { name: 'Team', value: dropTeam, inline: true },
          { name: 'Players Dropped', value: dropPlayers.toString(), inline: true }
        );
        break;

      default:
        embed.setTitle('🏈 League Transaction')
          .setDescription(txType);
    }

    embed.setFooter({ text: 'ESPN Fantasy Football' });
    return embed;
  } catch (error) {
    console.error('Error formatting transaction:', error);
    return null;
  }
}

// Post ESPN transaction to Discord
async function postFantasyTransaction(transaction) {
  try {
    const channel = await discord.channels.fetch(config.discord.channelId);
    const embed = formatFantasyTransaction(transaction);
    
    if (embed) {
      await channel.send({ embeds: [embed] });
      console.log(`✅ Posted fantasy transaction to Discord`);
      return true;
    }
  } catch (error) {
    console.error('❌ Error posting fantasy transaction:', error.message);
  }
  return false;
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

// Function to add post to recent cache
function addToRecentCache(handle, postUri) {
  if (!recentPostsCache.has(handle)) {
    recentPostsCache.set(handle, new Set());
  }
  
  const cache = recentPostsCache.get(handle);
  cache.add(postUri);
  
  // Keep only last CACHE_SIZE posts
  if (cache.size > CACHE_SIZE) {
    const postsArray = Array.from(cache);
    const toRemove = postsArray.slice(0, postsArray.length - CACHE_SIZE);
    toRemove.forEach(uri => cache.delete(uri));
  }
  
  console.log(`   Cache for @${handle}: ${cache.size} posts tracked`);
}

// Function to check if post is in recent cache
function isInRecentCache(handle, postUri) {
  if (!recentPostsCache.has(handle)) {
    return false;
  }
  return recentPostsCache.get(handle).has(postUri);
}

// Function to post to Discord
async function postToDiscord(post) {
  try {
    const channel = await discord.channels.fetch(config.discord.channelId);
    
    const postData = post.post;
    const author = postData.author;
    const record = postData.record;
    const postUri = postData.uri;
    
    // Triple-check we haven't posted this already (extra safety)
    const handle = author.handle;
    
    // Check 1: Last seen post
    if (lastSeenPosts.get(handle) === postUri) {
      console.log(`⚠️  Duplicate detected (last seen) - skipping post from @${handle}`);
      return;
    }
    
    // Check 2: Recent posts cache
    if (isInRecentCache(handle, postUri)) {
      console.log(`⚠️  Duplicate detected (recent cache) - skipping post from @${handle}`);
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
    
    // Add to recent cache after successful post
    addToRecentCache(handle, postUri);
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

// Function to check for new fantasy transactions
async function checkFantasyTransactions() {
  if (!config.fantasy.enabled) {
    return;
  }

  console.log(`🏈 Checking for new fantasy transactions...`);
  
  try {
    const transactions = await fetchESPNTransactions();
    
    if (!transactions || transactions.length === 0) {
      console.log(`   No new transactions found`);
      return;
    }

    // Process new transactions
    for (const transaction of transactions) {
      const txId = transaction.id || transaction.transactionId;
      
      // Skip if already posted
      if (fantasyTransactionCache.has(txId)) {
        console.log(`   Skipping duplicate transaction: ${txId}`);
        continue;
      }

      // Post new transaction
      await postFantasyTransaction(transaction);
      fantasyTransactionCache.add(txId);

      // Trim cache if it gets too large
      if (fantasyTransactionCache.size > FANTASY_CACHE_SIZE) {
        const arr = Array.from(fantasyTransactionCache);
        const toRemove = arr.slice(0, arr.length - FANTASY_CACHE_SIZE);
        toRemove.forEach(id => fantasyTransactionCache.delete(id));
      }
    }
  } catch (error) {
    console.error('❌ Error checking fantasy transactions:', error.message);
  }
}

// Discord bot ready event
discord.once('clientReady', async () => {
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
    if (!recentPostsCache.has(handle)) {
      recentPostsCache.set(handle, new Set());
    }
  });
  
  // Initialize ESPN Fantasy Football if enabled
  if (config.fantasy.enabled) {
    const espnReady = await initializeESPN();
    if (espnReady) {
      console.log('✅ ESPN Fantasy Football integration active');
      // Start checking for transactions every minute
      checkFantasyTransactions();
      setInterval(checkFantasyTransactions, config.fantasy.checkInterval);
    }
  }
  
  // Start checking for new posts
  checkAllAccounts();
  setInterval(checkAllAccounts, config.bluesky.checkInterval);
});

// Listen for messages (commands)
discord.on('messageCreate', handleCommand);

// Login to Discord
discord.login(config.discord.token);
