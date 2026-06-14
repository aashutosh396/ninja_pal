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
const { makeAutonomy } = require('./autonomy');
const { think, resolveBackend } = require('./brain');
const memory = require('./memory');

const cfgPath = path.join(__dirname, '..', 'config.json');
if (!fs.existsSync(cfgPath)) {
  console.error('[Ninja Pal] No config.json found.');
  console.error('  cp config.example.json config.json   then edit "owner" + "apiKey".');
  process.exit(1);
}
const config = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));

const state = {
  mode: 'idle',
  autoDefend: true,
  panicking: false,
  autonomous: config.autonomous !== false, // default ON — the pal plays by itself
  busy: false, // a task is currently running (lock so auto + manual don't collide)
};
const history = []; // recent chat turns fed back to the LLM for short-term memory

const bot = mineflayer.createBot({
  host: config.host || 'localhost',
  port: config.port || 25565,
  username: config.palName || 'Ninja',
  // "auto" / blank => let mineflayer negotiate the version from the server (works 1.20.x–1.21.x).
  version: (config.version && config.version !== 'auto') ? config.version : false,
  auth: config.auth || 'offline',
});

bot.loadPlugin(pathfinder);
bot.loadPlugin(pvp);
bot.loadPlugin(collectBlock);

let skills = null;
let autonomy = null;

bot.once('spawn', () => {
  skills = makeSkills(bot, config, state);
  autonomy = makeAutonomy(bot, skills, state, memory);
  skills.setMovements();
  console.log(`[Ninja Pal] ${bot.username} spawned. Owner=${config.owner}. brain=${resolveBackend(config)}. autonomous=${state.autonomous}.`);
  bot.chat(`hey ${config.owner}! im gonna do my own thing — say "follow me", "come", "stop", or "tp" anytime`);

  // Survival reflexes — always on, independent of what the pal is doing.
  setInterval(() => {
    try {
      skills.panicTick();  // flee/retreat takes priority when health is low
      skills.defendTick();
    } catch (e) {
      /* ignore transient combat errors */
    }
  }, 1000);

  // Stay fed (and thus self-heal via natural regen).
  setInterval(() => {
    skills.eatTick().catch(() => {});
  }, 2500);

  // Autonomy loop — advance one survival goal whenever the pal is free.
  // Detects when it's making no progress (e.g. no trees in a desert) and pauses + asks the owner
  // instead of spamming the same goal forever.
  let autoLastGoal = null;
  let autoNoProgress = 0;
  let autoPausedUntil = 0;
  const invTotal = () => {
    try { return bot.inventory.items().reduce((a, b) => a + b.count, 0); } catch (e) { return 0; }
  };

  setInterval(() => {
    if (!state.autonomous || state.busy || state.panicking || state.mode === 'follow') return;
    if (Date.now() < autoPausedUntil) return;
    state.busy = true;
    const before = invTotal();
    const hadHome = !!memory.getHome();
    autonomy
      .step()
      .then((what) => {
        if (what !== autoLastGoal) {
          autoLastGoal = what;
          if (what) console.log('[Ninja Pal] auto:', what); // log only when the goal changes
        }
        // Count steps that gained nothing (incl. fruitless exploring) — bounded so it eventually asks.
        const progressed = invTotal() !== before || (!hadHome && !!memory.getHome());
        autoNoProgress = progressed ? 0 : autoNoProgress + 1;
        // ~8 fruitless steps (incl. wandering to search) before giving up and asking the owner.
        if (autoNoProgress >= 8) {
          autoNoProgress = 0;
          autoPausedUntil = Date.now() + 90000; // back off 90s
          bot.chat(`i'm stuck trying to ${autoLastGoal || 'get going'} — nothing useful around here. tp me somewhere or tell me what to do`);
          console.log('[Ninja Pal] auto paused 90s (no progress)');
        }
      })
      .catch((e) => console.error('[Ninja Pal] auto error:', e.message))
      .finally(() => { state.busy = false; });
  }, 7000);
});

function onMessage(username, message) {
  if (username === bot.username) return;
  if (config.owner && username !== config.owner) return; // obey only the owner
  handle(message).catch((e) => console.error('[Ninja Pal] handle error:', e.message));
}

bot.on('chat', onMessage);      // public chat
bot.on('whisper', onMessage);   // /msg, /tell, /w to the pal

async function handle(message) {
  if (!skills) return;
  const m = message.toLowerCase().trim();

  // --- autonomy + movement toggles (these change how the pal behaves) ---
  if (/^(do your thing|go work|auto on|be free|go play|work)$/.test(m)) {
    state.autonomous = true; state.mode = 'idle'; bot.chat('cool, doing my own thing'); return;
  }
  if (/^(auto off|manual|wait for me|stop working)$/.test(m)) {
    state.autonomous = false; bot.chat('ok, ill wait for orders'); return;
  }
  if (/^(follow me|follow|come with me|tag along)$/.test(m)) {
    state.autonomous = false; return ack(skills.followOwner());
  }
  if (/^(stop|stay|wait|halt|hold)$/.test(m)) {
    state.autonomous = false; return ack(skills.stop());
  }
  // teleport (needs the world's cheats on + the pal /op'd)
  if (/^(tp|teleport|come tp|warp to me)$/.test(m)) { skills.tpToOwner(); return; }
  if (/^(tpme|tp me|bring me|warp me)$/.test(m)) { skills.tpOwnerHere(); return; }

  // --- one-shot commands (don't disable autonomy; they run then it resumes) ---
  if (state.busy && /^(come|defend|guard|get tools|tools|shelter|build house|house|go home)/.test(m)) {
    bot.chat('busy right now, one sec');
    return;
  }
  state.busy = true;
  try {
    if (/^(come|come here|here|to me)$/.test(m)) return ack(skills.come());
    if (/^(defend|protect|guard)( me)?$/.test(m)) { state.autoDefend = true; bot.chat('got your back'); return; }
    if (/^(stand down|chill|relax|peace)$/.test(m)) { state.autoDefend = false; if (bot.pvp) bot.pvp.stop(); bot.chat('ok, standing down'); return; }
    if (/^(get tools|make tools|tools)$/.test(m)) return ack(await skills.getTools());
    if (/^(shelter|build shelter|cover|hide)$/.test(m)) return ack(await skills.build('shelter'));
    if (/^(build house|build a house|house|make a house)$/.test(m)) return ack(await buildHouseAndRemember());
    if (/^(set home|sethome|home set)$/.test(m)) { memory.setHome(bot.entity.position); bot.chat('home set right here'); return; }
    if (/^(go home|gohome|head home)$/.test(m)) return ack(goHome());

    // Everything else -> the LLM brain (chat + optional multi-step plan).
    // Only the OpenAI backend needs a key; the Claude backend uses the local CLI login.
    if (resolveBackend(config) === 'openai' && !config.apiKey) {
      bot.chat("(no api key — i can still do: follow, come, defend, get tools, build house, tp)");
      return;
    }
    const { say, actions } = await think(config, {
      world: skills.perceive(),
      memories: memory.summary(),
      ownerName: config.owner,
      message,
      history: history.slice(-8),
    });
    history.push({ role: 'user', content: `${config.owner}: ${message}` });
    if (say) {
      bot.chat(say);
      history.push({ role: 'assistant', content: say });
    }
    for (const action of actions) {
      const err = await execute(action);
      if (err) { bot.chat(err); break; }
    }
  } catch (e) {
    console.error('[Ninja Pal] handle:', e.message);
    bot.chat('uh my brain glitched, say that again?');
  } finally {
    state.busy = false;
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
    case 'shoot': return await skills.rangedAttackNearest();
    case 'mine': return await skills.mineOre(a.ore || a.block || 'iron', a.count || 1);
    case 'hunt': return await skills.hunt();
    case 'build_house': return await buildHouseAndRemember();
    case 'explore': case 'wander': return await skills.wander();
    case 'tp': return skills.tpToOwner();
    case 'tpme': return skills.tpOwnerHere();
    case 'work': case 'auto_on': state.autonomous = true; state.mode = 'idle'; return null;
    case 'auto_off': state.autonomous = false; return null;
    case 'goto': return skills.gotoCoord(Number(a.x), Number(a.y), Number(a.z));
    case 'sethome': memory.setHome(bot.entity.position); return null;
    case 'gohome': return goHome();
    case 'remember': memory.add(a.note); return null;
    default: return null;
  }
}

// Build a house and remember where it is (so "go home" works afterwards).
async function buildHouseAndRemember() {
  const err = await skills.buildHouse();
  if (!err) memory.setHome(bot.entity.position);
  return err;
}

// Walk back to the saved home position, if one exists.
function goHome() {
  const h = memory.getHome();
  if (!h) return "i don't have a home set — say \"set home\" where you want it";
  return skills.gotoCoord(h.x, h.y, h.z);
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
