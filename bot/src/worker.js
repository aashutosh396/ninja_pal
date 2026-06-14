'use strict';
// One worker = one named bot: connects (with auto-reconnect), owns its skills, handles commands
// addressed to it, and runs its JOB on a loop (preset role or free-text). The crew manager
// (index.js) spawns these and routes the owner's chat to the right worker(s).

const mineflayer = require('mineflayer');
const { pathfinder } = require('mineflayer-pathfinder');
const { plugin: pvp } = require('mineflayer-pvp');
const collectBlock = require('mineflayer-collectblock').plugin;
const { makeSkills } = require('./skills');
const { makeAutonomy } = require('./autonomy');
const { think, resolveBackend } = require('./brain');
const memory = require('./memory');
const { jobText, interpret } = require('./roles');

function createWorker(config, def, manager) {
  const name = def.name;
  const wcfg = Object.assign({}, config, { palName: name }); // its own username; shares owner/brain
  const state = {
    mode: 'idle', autoDefend: true, panicking: false, busy: false,
    quiet: true, cancel: false, goal: 'idle', paused: false, pausedUntil: 0,
  };
  let bot = null;
  let skills = null;
  let autonomy = null;
  let loops = false;
  let gatherFails = 0;

  const log = (...a) => console.log(`[${name}]`, ...a);
  const RESOURCE_WORDS = ['dirt', 'cobblestone', 'stone', 'wood', 'logs', 'log', 'coal', 'iron', 'gold', 'diamond', 'sand', 'planks'];
  const itemFromText = (m) => RESOURCE_WORDS.find((r) => new RegExp(`\\b${r}\\b`).test(m)) || 'all';
  const countFromText = (m) => { const n = m.match(/\b(\d{1,3})\b/); return n ? parseInt(n[1], 10) : undefined; };

  function connect() {
    try {
      bot = mineflayer.createBot({
        host: wcfg.host || 'localhost',
        port: wcfg.port || 25565,
        username: name,
        version: (wcfg.version && wcfg.version !== 'auto') ? wcfg.version : false,
        auth: wcfg.auth || 'offline',
      });
    } catch (e) {
      log('createBot failed:', e.message, '— retry 8s');
      setTimeout(connect, 8000);
      return;
    }

    bot.loadPlugin(pathfinder);
    bot.loadPlugin(pvp);
    bot.loadPlugin(collectBlock);

    bot.once('spawn', () => {
      skills = makeSkills(bot, wcfg, state);
      autonomy = makeAutonomy(bot, skills, state, memory);
      skills.setMovements();
      log(`spawned. job: ${jobText(def)}`);
      startLoops();
    });

    bot.on('chat', (u, m) => manager.onChat(u, m));
    bot.on('whisper', (u, m) => manager.onChat(u, m));
    bot.on('death', () => { state.mode = 'idle'; });
    bot.on('kicked', (r) => log('kicked:', r));
    bot.on('error', (e) => log('error:', e.message));
    bot.on('end', (r) => {
      log('disconnected:', r, '— reconnect 8s');
      skills = null; autonomy = null; state.busy = false;
      setTimeout(connect, 8000);
    });
  }

  function startLoops() {
    if (loops) return;
    loops = true;
    setInterval(() => { if (skills && bot && bot.entity) { try { skills.panicTick(); skills.defendTick(); } catch (e) { /* */ } } }, 1000);
    setInterval(() => { if (skills) skills.eatTick().catch(() => {}); }, 2500);
    setInterval(() => { jobTick().catch((e) => log('job err:', e.message)); }, 8000);
  }

  async function jobTick() {
    if (!skills || !bot || !bot.entity) return;
    if (state.busy || state.panicking || state.paused || state.mode === 'follow') return;
    if (Date.now() < state.pausedUntil) return;
    state.busy = true;
    state.cancel = false;
    try {
      await runJob();
    } finally {
      state.busy = false;
    }
  }

  async function runJob() {
    const plan = interpret(jobText(def));
    state.goal = describe(plan);
    switch (plan.kind) {
      case 'idle':
        return;
      case 'guard':
        skills.followOwner();
        return;
      case 'hunt': {
        const e = await skills.hunt();
        if (e) await skills.wander();
        return;
      }
      case 'survive':
        await autonomy.step();
        return;
      case 'gather':
        return runGather(plan);
      default:
        return runLlmJob();
    }
  }

  function describe(p) {
    if (p.kind === 'gather') return `${p.verb} ${p.resource} -> ${p.sink}`;
    return p.kind;
  }

  async function runGather(p) {
    const err = p.verb === 'mine'
      ? await skills.mineOre(p.resource, 16)
      : await skills.collect(p.resource, 16);
    if (err) {
      if (++gatherFails >= 6) {
        gatherFails = 0;
        state.pausedUntil = Date.now() + 90000;
        try { bot.chat(`(${name}) stuck: ${err}`); } catch (e) { /* */ }
      } else {
        await skills.wander(); // move and try again
      }
      return;
    }
    gatherFails = 0;
    if (p.sink === 'chest') await skills.depositToChest(p.resource);
    else if (p.sink === 'drop') await skills.drop(p.resource);
    else if (p.sink === 'give') await skills.giveToOwner(p.resource);
    // 'hold' => keep it
  }

  // Free-text job we couldn't parse — let the brain pick the next action(s).
  async function runLlmJob() {
    if (resolveBackend(config) === 'openai' && !config.apiKey) return;
    const { actions } = await think(config, {
      world: skills.perceive(), memories: memory.summary(),
      ownerName: config.owner, message: `Keep doing your job: ${jobText(def)}`, history: [],
    });
    for (const a of actions || []) { if (state.cancel) break; await execute(a); }
  }

  // --- commands addressed to THIS worker (relaxed matching; interrupt the job) ---
  async function handle(message) {
    if (!skills) return;
    const m = String(message).toLowerCase().trim();
    const interrupt = () => { state.cancel = true; try { bot.pathfinder.setGoal(null); } catch (e) {} if (bot.pvp) bot.pvp.stop(); };
    const ack = (err) => { if (err) bot.chat(err); };

    if (/\bstatus\b|\bwyd\b|what('?s| is| are)\b.*\b(goal|doing|job)\b|how('?s| is) it going/.test(m)) {
      const where = state.mode === 'follow' ? 'following you' : (state.paused ? 'paused' : `on job (${state.goal})`);
      const p = bot.entity.position;
      bot.chat(`${name}: ${where} | hp ${Math.round(bot.health)} food ${Math.round(bot.food)} | ${Math.round(p.x)},${Math.round(p.y)},${Math.round(p.z)}`);
      return;
    }
    if (/\b(do your thing|work|resume|continue|carry on|get back to work|keep working)\b/.test(m)) {
      interrupt(); state.paused = false; state.mode = 'idle'; bot.chat(`${name}: back to work`); return;
    }
    if (/\b(wait|stand by|pause|hold position|auto off)\b/.test(m)) { interrupt(); state.paused = true; skills.stop(); bot.chat(`${name}: holding`); return; }
    if (/\bfollow\b/.test(m)) { interrupt(); state.mode = 'follow'; return ack(skills.followOwner()); }
    if (/\btpme\b|\btp me\b|teleport me|bring me|warp me/.test(m)) { interrupt(); skills.tpOwnerHere(); return; }
    if (/\btp\b|teleport|warp to me/.test(m)) { interrupt(); skills.tpToOwner(); return; }
    if (/\b(stop|halt|hold up|hold on|freeze)\b/.test(m)) { interrupt(); state.paused = true; return ack(skills.stop()); }
    if (/\bcome\b|get over here|over here|to me\b/.test(m)) { interrupt(); state.mode = 'idle'; return ack(skills.come()); }
    if (/\bgo home\b|head home/.test(m)) { interrupt(); return ack(goHome()); }
    if (/\bset home\b|make this home|home here/.test(m)) { memory.setHome(bot.entity.position); bot.chat(`${name}: home set`); return; }
    if (/\b(defend|protect|guard)\b/.test(m)) { state.autoDefend = true; bot.chat(`${name}: got your back`); return; }
    if (/\b(stand down|chill|relax|at ease)\b/.test(m)) { state.autoDefend = false; if (bot.pvp) bot.pvp.stop(); bot.chat(`${name}: standing down`); return; }

    // one-shot tasks
    if (state.busy) { bot.chat(`${name}: busy — say "stop" to interrupt`); return; }
    state.cancel = false; state.busy = true;
    try {
      if (/\b(deposit|store|stash)\b|put .*\b(chest|barrel)\b/.test(m)) return ack(await skills.depositToChest(itemFromText(m), countFromText(m)));
      if (/\b(drop|toss|dump)\b/.test(m)) return ack(await skills.drop(itemFromText(m), countFromText(m)));
      if (/\bget tools\b|make tools/.test(m)) return ack(await skills.getTools());
      if (/\bbuild .*house\b|\bhouse\b/.test(m)) return ack(await skills.buildHouse());
      if (/\bshelter\b/.test(m)) return ack(await skills.build('shelter'));
      if (/\bmine\b/.test(m)) return ack(await skills.mineOre(itemFromText(m), countFromText(m) || 8));
      if (/\b(collect|chop|gather)\b/.test(m)) return ack(await skills.collect(itemFromText(m), countFromText(m) || 8));
      // free text -> brain
      if (resolveBackend(config) === 'openai' && !config.apiKey) { bot.chat(`${name}: (no brain key)`); return; }
      const { say, actions } = await think(config, {
        world: skills.perceive(), memories: memory.summary(),
        ownerName: config.owner, message, history: [],
      });
      if (say) bot.chat(`${name}: ${say}`);
      for (const a of actions || []) { if (state.cancel) break; const e = await execute(a); if (e) { bot.chat(e); break; } }
    } catch (e) {
      log('handle err:', e.message);
    } finally {
      state.busy = false;
    }
  }

  async function execute(action) {
    if (!action || !action.name) return null;
    const a = action.args || {};
    switch (action.name) {
      case 'follow': state.mode = 'follow'; return skills.followOwner();
      case 'come': return skills.come();
      case 'stop': state.paused = true; return skills.stop();
      case 'attack': return skills.attackNearest();
      case 'shoot': return await skills.rangedAttackNearest();
      case 'collect': return await skills.collect(a.block || 'wood', a.count || 8);
      case 'mine': return await skills.mineOre(a.ore || a.block || 'iron', a.count || 8);
      case 'craft': return await skills.craft(a.item, a.count || 1);
      case 'get_tools': return await skills.getTools();
      case 'build': return await skills.build(a.what || 'shelter');
      case 'build_house': return await skills.buildHouse();
      case 'hunt': return await skills.hunt();
      case 'deposit': case 'store': return await skills.depositToChest(a.item || 'all', a.count);
      case 'drop': case 'toss': return await skills.drop(a.item || 'all', a.count);
      case 'give': return await skills.giveToOwner(a.item || 'all', a.count);
      case 'scout': case 'find_wood': return await skills.scout();
      case 'explore': case 'wander': return await skills.wander();
      case 'goto': return skills.gotoCoord(Number(a.x), Number(a.y), Number(a.z));
      case 'tp': return skills.tpToOwner();
      case 'tpme': return skills.tpOwnerHere();
      case 'sethome': memory.setHome(bot.entity.position); return null;
      case 'gohome': return goHome();
      case 'remember': memory.add(a.note); return null;
      default: return null;
    }
  }

  function goHome() {
    const h = memory.getHome();
    if (!h) return `${name}: no home set`;
    return skills.gotoCoord(h.x, h.y, h.z);
  }

  function disconnect() {
    try { if (bot) bot.quit('dismissed'); } catch (e) { /* */ }
  }

  connect();
  return {
    name,
    def,
    handle,
    disconnect,
    say: (msg) => { try { if (bot) bot.chat(msg); } catch (e) { /* */ } },
    getState: () => state,
  };
}

module.exports = { createWorker };
