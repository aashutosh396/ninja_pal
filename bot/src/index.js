'use strict';
// Ninja Pal bot — joins your Minecraft world as a real second player and plays alongside you.
// Follows, defends, comes/stops on command, gathers blocks, and chats via an LLM that can
// also trigger those actions. Configure in ../config.json (copy config.example.json).

const fs = require('fs');
const path = require('path');
const mineflayer = require('mineflayer');
const { pathfinder } = require('mineflayer-pathfinder');
const { plugin: pvp } = require('mineflayer-pvp');
const collectBlock = require('mineflayer-collectblock').plugin;
const { makeSkills } = require('./skills');
const { think } = require('./brain');

const cfgPath = path.join(__dirname, '..', 'config.json');
if (!fs.existsSync(cfgPath)) {
  console.error('[Ninja Pal] No config.json found.');
  console.error('  cp config.example.json config.json   then edit "owner" + "apiKey".');
  process.exit(1);
}
const config = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));

const state = { mode: 'idle', autoDefend: true };
const history = []; // recent chat turns fed back to the LLM for short-term memory

const bot = mineflayer.createBot({
  host: config.host || 'localhost',
  port: config.port || 25565,
  username: config.palName || 'Ninja',
  version: config.version || '1.20.4',
  auth: config.auth || 'offline',
});

bot.loadPlugin(pathfinder);
bot.loadPlugin(pvp);
bot.loadPlugin(collectBlock);

let skills = null;

bot.once('spawn', () => {
  skills = makeSkills(bot, config, state);
  skills.setMovements();
  console.log(`[Ninja Pal] ${bot.username} spawned. Owner=${config.owner}. follow+auto-defend on.`);
  bot.chat(`hey ${config.owner}, im here! say "follow me", "stop", "come", or just talk to me`);

  setInterval(() => {
    try {
      skills.defendTick();
    } catch (e) {
      /* ignore transient combat errors */
    }
  }, 1000);

  // Stay fed (and thus self-heal via natural regen).
  setInterval(() => {
    skills.eatTick().catch(() => {});
  }, 2500);

  // start by tagging along if the owner is in sight
  setTimeout(() => {
    if (state.mode === 'idle') skills.followOwner();
  }, 2500);
});

bot.on('chat', (username, message) => {
  if (username === bot.username) return;
  if (config.owner && username !== config.owner) return; // Phase 2: obey only the owner
  handle(message).catch((e) => console.error('[Ninja Pal] handle error:', e.message));
});

async function handle(message) {
  if (!skills) return;
  const m = message.toLowerCase().trim();

  // Fast path — direct keywords, no LLM round-trip.
  if (/^(follow me|follow|come with me|tag along)$/.test(m)) return ack(skills.followOwner());
  if (/^(stop|stay|wait|halt|hold)$/.test(m)) return ack(skills.stop());
  if (/^(come|come here|here|to me)$/.test(m)) return ack(skills.come());
  if (/^(defend|protect|guard)( me)?$/.test(m)) { state.autoDefend = true; bot.chat('got your back'); return; }
  if (/^(stand down|chill|relax|peace)$/.test(m)) { state.autoDefend = false; if (bot.pvp) bot.pvp.stop(); bot.chat('ok, standing down'); return; }
  if (/^(get tools|make tools|tools)$/.test(m)) return ack(await skills.getTools());
  if (/^(shelter|build shelter|cover|hide)$/.test(m)) return ack(await skills.build('shelter'));

  // Everything else -> the LLM brain (chat + optional action).
  if (!config.apiKey) {
    bot.chat("(no api key set — i can still do: follow, stop, come, defend)");
    return;
  }
  try {
    const { say, actions } = await think(config, {
      world: skills.perceive(),
      ownerName: config.owner,
      message,
      history: history.slice(-8),
    });
    history.push({ role: 'user', content: `${config.owner}: ${message}` });
    if (say) {
      bot.chat(say);
      history.push({ role: 'assistant', content: say });
    }
    // Run the plan in order; stop early if a step reports it can't proceed.
    for (const action of actions) {
      const err = await execute(action);
      if (err) {
        bot.chat(err);
        break;
      }
    }
  } catch (e) {
    console.error('[Ninja Pal] brain:', e.message);
    bot.chat('uh my brain glitched, say that again?');
  }
}

// Run one action; returns an error string (to surface + halt the plan) or null on success.
async function execute(action) {
  if (!action || !action.name) return null;
  const a = action.args || {};
  console.log('[Ninja Pal] action:', action.name, JSON.stringify(a));
  switch (action.name) {
    case 'follow': return skills.followOwner();
    case 'come': return skills.come();
    case 'stop': return skills.stop();
    case 'attack': return skills.attackNearest();
    case 'collect': return await skills.collect(a.block || 'wood', a.count || 1);
    case 'craft': return await skills.craft(a.item, a.count || 1);
    case 'get_tools': return await skills.getTools();
    case 'build': return await skills.build(a.what || 'shelter');
    case 'give': return await skills.giveToOwner(a.item || 'all', a.count);
    case 'goto': return skills.gotoCoord(Number(a.x), Number(a.y), Number(a.z));
    default: return null;
  }
}

function ack(err) {
  if (err) bot.chat(err);
}

bot.on('death', () => {
  state.mode = 'idle';
  bot.chat('oof i died, be right back');
});
bot.on('kicked', (reason) => console.log('[Ninja Pal] kicked:', reason));
bot.on('error', (err) => console.error('[Ninja Pal] error:', err.message));
bot.on('end', (reason) => {
  console.log('[Ninja Pal] disconnected:', reason);
  process.exit(0);
});
