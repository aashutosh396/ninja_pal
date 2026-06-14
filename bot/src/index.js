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
  quiet: false, // suppress chat for routine autonomy work (still logs to console)
  cancel: false, // cooperative cancel — set by interrupt commands to stop the current task
  goal: 'idle', // current autonomy goal label (for the "status" command)
};
const history = []; // recent chat turns fed back to the LLM for short-term memory

let bot = null;
let skills = null;
let autonomy = null;
let loopsStarted = false;

// Autonomy-loop bookkeeping (module scope so it survives reconnects).
let autoLastGoal = null;
let autoNoProgress = 0;
let autoPausedUntil = 0;
const invTotal = () => {
  try { return bot.inventory.items().reduce((a, b) => a + b.count, 0); } catch (e) { return 0; }
};

// The always-on loops. Started ONCE; they idle while disconnected (skills/bot null) and pick
// straight back up after a reconnect, so we never stack duplicate timers.
function startLoops() {
  if (loopsStarted) return;
  loopsStarted = true;

  // Survival reflexes — flee when low, then defend.
  setInterval(() => {
    if (!skills || !bot || !bot.entity) return;
    try { skills.panicTick(); skills.defendTick(); } catch (e) { /* transient */ }
  }, 1000);

  // Stay fed (self-heal via regen).
  setInterval(() => {
    if (!skills) return;
    skills.eatTick().catch(() => {});
  }, 2500);

  // Autonomy — advance one survival goal whenever free; back off + ask if it can't progress.
  setInterval(() => {
    if (!skills || !autonomy || !bot || !bot.entity) return;
    if (!state.autonomous || state.busy || state.panicking || state.mode === 'follow') return;
    if (Date.now() < autoPausedUntil) return;
    state.busy = true;
    state.cancel = false;
    state.quiet = true; // autonomy works silently (console only) — no chat spam
    const before = invTotal();
    const hadHome = !!memory.getHome();
    autonomy
      .step()
      .then((what) => {
        state.goal = what || state.goal;
        if (what !== autoLastGoal) {
          autoLastGoal = what;
          if (what) console.log('[Ninja Pal] auto:', what);
        }
        const progressed = invTotal() !== before || (!hadHome && !!memory.getHome());
        autoNoProgress = progressed ? 0 : autoNoProgress + 1;
        if (autoNoProgress >= 8) {
          autoNoProgress = 0;
          autoPausedUntil = Date.now() + 90000;
          bot.chat(`i'm stuck trying to ${autoLastGoal || 'get going'} — nothing useful around here. tp me somewhere or tell me what to do`);
          console.log('[Ninja Pal] auto paused 90s (no progress)');
        }
      })
      .catch((e) => console.error('[Ninja Pal] auto error:', e.message))
      .finally(() => { state.busy = false; state.quiet = false; });
  }, 7000);
}

function onMessage(username, message) {
  if (!bot || username === bot.username) return;
  if (config.owner && username !== config.owner) return; // obey only the owner
  handle(message).catch((e) => console.error('[Ninja Pal] handle error:', e.message));
}

// Connect (and auto-reconnect) so it runs unattended.
function connect() {
  try {
    bot = mineflayer.createBot({
      host: config.host || 'localhost',
      port: config.port || 25565,
      username: config.palName || 'Ninja',
      // "auto"/blank => negotiate the server version (1.20.x–1.21.x).
      version: (config.version && config.version !== 'auto') ? config.version : false,
      auth: config.auth || 'offline',
    });
  } catch (e) {
    console.error('[Ninja Pal] createBot failed:', e.message, '— retrying in 8s');
    setTimeout(connect, 8000);
    return;
  }

  bot.loadPlugin(pathfinder);
  bot.loadPlugin(pvp);
  bot.loadPlugin(collectBlock);

  bot.once('spawn', () => {
    skills = makeSkills(bot, config, state);
    autonomy = makeAutonomy(bot, skills, state, memory);
    skills.setMovements();
    console.log(`[Ninja Pal] ${bot.username} spawned. Owner=${config.owner}. brain=${resolveBackend(config)}. autonomous=${state.autonomous}. MC version=${bot.version}.`);
    setTimeout(() => {
      try {
        const solid = bot.findBlocks({ matching: (b) => b && b.boundingBox === 'block', maxDistance: 16, count: 200 }).length;
        console.log(`[Ninja Pal] block-read check: ${solid} solid blocks within 16 (0 => world not parsing for MC ${bot.version})`);
      } catch (e) { console.log('[Ninja Pal] block-read check failed:', e.message); }
    }, 4000);
    bot.chat(`hey ${config.owner}! im doing my own thing — say "follow me", "come", "stop", "tp", or "status" anytime`);
    startLoops();
  });

  bot.on('chat', onMessage);    // public chat
  bot.on('whisper', onMessage); // /msg, /tell, /w
  bot.on('death', () => { state.mode = 'idle'; try { bot.chat('oof i died, be right back'); } catch (e) {} });
  bot.on('kicked', (reason) => console.log('[Ninja Pal] kicked:', reason));
  bot.on('error', (err) => console.error('[Ninja Pal] error:', err.message));
  bot.on('end', (reason) => {
    console.log('[Ninja Pal] disconnected:', reason, '— reconnecting in 8s');
    skills = null;
    autonomy = null;
    state.busy = false;
    setTimeout(connect, 8000);
  });
}

async function handle(message) {
  if (!skills) return;
  const m = message.toLowerCase().trim();

  // --- STATUS: report what it's doing (read-only, never blocked) ---
  if (/\bstatus\b|\bwyd\b|what('?s| is| are)\b.*\b(goal|doing|up to)\b|whatcha doing|how('?s| is) it going|how much .*done/.test(m)) {
    const where = state.autonomous
      ? `working on my own (${state.goal})`
      : (state.mode === 'follow' ? 'following you' : 'waiting for orders');
    const p = bot.entity.position;
    bot.chat(`${where} | hp ${Math.round(bot.health)} food ${Math.round(bot.food)} | at ${Math.round(p.x)},${Math.round(p.y)},${Math.round(p.z)}`);
    const inv = skills.inventorySummary();
    bot.chat(`carrying: ${inv.length > 120 ? inv.slice(0, 120) + '…' : inv}`);
    return;
  }

  // --- CONTROL commands: relaxed matching (work inside sentences) + interrupt the current job ---
  // interrupt() cancels any running task + stops movement so the command takes over immediately.
  const interrupt = () => { state.cancel = true; bot.pathfinder.setGoal(null); if (bot.pvp) bot.pvp.stop(); };

  if (/\b(do your thing|go work|auto on|be free|go play|get back to work|keep working|carry on)\b/.test(m)) {
    interrupt(); state.autonomous = true; state.mode = 'idle'; bot.chat('cool, doing my own thing'); return;
  }
  if (/\b(auto off|wait for me|stop working|hold position|stand by)\b/.test(m)) {
    interrupt(); state.autonomous = false; skills.stop(); bot.chat('ok, ill wait for orders'); return;
  }
  if (/\bfollow\b/.test(m)) {
    interrupt(); state.autonomous = false; return ack(skills.followOwner());
  }
  if (/\btpme\b|\btp me\b|teleport me|bring me|warp me|pull me/.test(m)) {
    interrupt(); skills.tpOwnerHere(); return;
  }
  if (/\btp\b|teleport|warp to me|come tp/.test(m)) {
    interrupt(); skills.tpToOwner(); return;
  }
  if (/\b(stop|wait|halt|hold up|hold on|freeze|pause)\b/.test(m)) {
    interrupt(); state.autonomous = false; return ack(skills.stop());
  }
  // "come" keeps autonomy on so it works wherever you led it (e.g. to a forest)
  if (/\bcome\b|get over here|over here|to me\b/.test(m)) {
    interrupt(); return ack(skills.come());
  }
  if (/\bgo home\b|head home|gohome/.test(m)) { interrupt(); state.autonomous = false; return ack(goHome()); }
  if (/\bset home\b|sethome|make this home|home here/.test(m)) { memory.setHome(bot.entity.position); bot.chat('home set right here'); return; }
  if (/\b(defend|protect|guard)\b/.test(m)) { state.autoDefend = true; bot.chat('got your back'); return; }
  if (/\b(stand down|chill|relax|at ease)\b/.test(m)) { state.autoDefend = false; if (bot.pvp) bot.pvp.stop(); bot.chat('ok, standing down'); return; }

  // --- BUSY: still chat back (no new task) so conversation flows while it works ---
  if (state.busy) {
    if (resolveBackend(config) === 'openai' && !config.apiKey) {
      bot.chat('on it already — say "stop" or "come" to interrupt'); return;
    }
    try {
      const { say } = await think(config, {
        world: skills.perceive(), memories: memory.summary(),
        ownerName: config.owner, message, history: history.slice(-8),
      });
      bot.chat(say || 'on it — say "stop" or "come" to interrupt');
    } catch (e) {
      bot.chat('on it already — say "stop" or "come" to interrupt');
    }
    return;
  }

  // --- HEAVY tasks + LLM brain: one at a time ---
  state.cancel = false;
  state.busy = true;
  try {
    if (/\b(deposit|store|stash|put .*\b(chest|barrel)|drop .*\b(chest|barrel))\b/.test(m)) {
      return ack(await skills.depositToChest(itemFromText(m), countFromText(m)));
    }
    if (/\b(drop|throw away|toss|dump|get rid of)\b/.test(m)) {
      return ack(await skills.drop(itemFromText(m), countFromText(m)));
    }
    if (/^(get tools|make tools|tools)$/.test(m)) return ack(await skills.getTools());
    if (/^(shelter|build shelter|cover|hide)$/.test(m)) return ack(await skills.build('shelter'));
    if (/^(build house|build a house|house|make a house)$/.test(m)) return ack(await buildHouseAndRemember());
    if (/^(scout|find wood|find a forest|find trees|go that way|go straight|find forest)$/.test(m)) return ack(await skills.scout());

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
  state.goal = action.name + (a.block || a.ore || a.item || a.what ? ` ${a.block || a.ore || a.item || a.what}` : '');
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
    case 'scout': case 'find_wood': return await skills.scout();
    case 'explore': case 'wander': return await skills.wander();
    case 'deposit': case 'store': return await skills.depositToChest(a.item || 'all', a.count);
    case 'drop': case 'toss': return await skills.drop(a.item || 'all', a.count);
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

// Pull a resource name / a count out of a free-text command (for drop/deposit keywords).
const RESOURCE_WORDS = ['dirt', 'cobblestone', 'stone', 'wood', 'logs', 'log', 'coal', 'iron', 'gold', 'diamond', 'sand', 'planks'];
function itemFromText(m) {
  const w = RESOURCE_WORDS.find((r) => new RegExp(`\\b${r}\\b`).test(m));
  return w || 'all';
}
function countFromText(m) {
  const n = m.match(/\b(\d{1,3})\b/);
  return n ? parseInt(n[1], 10) : undefined;
}

// Keep the autonomous run alive through unexpected errors instead of crashing.
process.on('unhandledRejection', (e) => console.error('[Ninja Pal] unhandledRejection:', e && e.message));
process.on('uncaughtException', (e) => console.error('[Ninja Pal] uncaughtException:', e && e.message));

connect();
