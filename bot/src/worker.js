'use strict';
// One worker = one named bot: connects (with auto-reconnect), owns its skills, handles commands
// addressed to it, and runs its JOB on a loop (preset role or free-text). The crew manager
// (index.js) spawns these and routes the owner's chat to the right worker(s).

const mineflayer = require('mineflayer');
const { pathfinder, goals } = require('mineflayer-pathfinder');
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
  let stopped = false;        // set when dismissed — prevents auto-reconnect
  const timers = [];          // interval ids so we can stop cleanly
  let lastNudge = 0;          // throttle the logistics "supplies ready" announce
  let lastSupplyCheck = 0;    // throttle opening the supply chest to count
  let cachedSupply = null;    // last {tools, food} reading

  const log = (...a) => console.log(`[${name}]`, ...a);
  const RESOURCE_WORDS = ['dirt', 'cobblestone', 'stone', 'wood', 'logs', 'log', 'coal', 'iron', 'gold', 'diamond', 'sand', 'planks'];
  const itemFromText = (m) => RESOURCE_WORDS.find((r) => new RegExp(`\\b${r}\\b`).test(m)) || 'all';
  const countFromText = (m) => { const n = m.match(/\b(\d{1,3})\b/); return n ? parseInt(n[1], 10) : undefined; };

  function connect() {
    if (stopped) return;
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
    bot.on('whisper', (u, m) => manager.onWhisper(u, m, name));
    bot.on('death', () => { state.mode = 'idle'; });
    bot.on('kicked', (r) => log('kicked:', r));
    bot.on('error', (e) => log('error:', e.message));
    bot.on('end', (r) => {
      skills = null; autonomy = null; state.busy = false;
      if (stopped) { log('stopped'); return; } // dismissed — do NOT reconnect
      log('disconnected:', r, '— reconnect 8s');
      setTimeout(connect, 8000);
    });
  }

  function startLoops() {
    if (loops) return;
    loops = true;
    timers.push(setInterval(() => { if (skills && bot && bot.entity) { try { skills.panicTick(); skills.defendTick(); } catch (e) { /* */ } } }, 1000));
    timers.push(setInterval(() => { if (skills) skills.eatTick().catch(() => {}); }, 2500));
    timers.push(setInterval(() => { jobTick().catch((e) => log('job err:', e.message)); }, 8000));
  }

  async function jobTick() {
    if (!skills || !bot || !bot.entity) return;
    if (state.busy || state.panicking || state.paused || state.mode === 'follow') return;
    if (Date.now() < state.pausedUntil) return;
    state.busy = true;
    state.cancel = false;
    try {
      const spot = def.chest || memory.getBase();
      const mcData = require('minecraft-data')(bot.version);
      const hasFood = bot.inventory.items().some((i) => mcData.foodsByName[i.name]);
      // Self-care: hungry with no food -> go to base to restock (and drop loot while there).
      if (spot && bot.food <= 7 && !hasFood) {
        state.goal = 'low on food, heading to base';
        await baseRun(spot);
      } else if (spot && bot.inventory.emptySlotCount() <= 6) {
        // Bag filling -> loot run to MY chest (if assigned) else the shared base.
        await baseRun(spot);
      } else {
        await runJob();
      }
    } finally {
      state.busy = false;
    }
  }

  // Stop the current job and stop moving (used by interrupt commands).
  function interrupt() {
    state.cancel = true;
    try { bot.pathfinder.setGoal(null); } catch (e) { /* */ }
    if (bot.pvp) bot.pvp.stop();
  }

  // Come to base NOW and drop off everything (then restock). For "come deposit" / "unload".
  async function comeDeposit() {
    const spot = def.chest || memory.getBase();
    if (!spot) { bot.chat(`${name}: no base set — stand by a chest and say "set base"`); return; }
    interrupt();
    state.busy = true;
    try { await baseRun(spot); bot.chat(`${name}: dropped everything off at base`); }
    catch (e) { log('deposit err:', e.message); }
    finally { state.busy = false; }
  }

  // Come to base and take supplies (tools/food). For "restock" / "supplies ready".
  async function comeRestock() {
    const spot = def.chest || memory.getBase();
    if (!spot) { bot.chat(`${name}: no base set`); return; }
    interrupt();
    state.busy = true;
    try {
      state.goal = 'getting supplies';
      try { await bot.pathfinder.goto(new goals.GoalNear(spot.x, spot.y, spot.z, 2)); }
      catch (e) { skills.tpTo(spot.x, spot.y, spot.z); await new Promise((r) => setTimeout(r, 1500)); }
      const got = await skills.restockFromSupply();
      if (got === false) bot.chat(`${name}: no supply chest set — say "set supply" at it`);
      else if (!got) bot.chat(`${name}: already stocked, took nothing`);
      else { bot.chat(`${name}: grabbed ${got} from supply`); log('restock:', got); }
    } finally { state.busy = false; }
  }

  async function baseRun(spot) {
    state.goal = def.chest ? 'returning to my chest' : 'returning to base';
    log('loot run ->', def.chest ? 'own chest' : 'base');
    // WALK to base (no op needed). If it can't path there (too far/blocked), try a tp if op'd.
    try {
      await bot.pathfinder.goto(new goals.GoalNear(spot.x, spot.y, spot.z, 2));
    } catch (e) {
      skills.tpTo(spot.x, spot.y, spot.z);
      await new Promise((r) => setTimeout(r, 1800));
    }
    const got = await skills.restockFromSupply(); // grab tools/food from the supply chest if missing
    if (got && got !== true) { bot.chat(`${name}: took ${got} from supply`); log('restock:', got); }

    // If a chest is assigned, deposit into THAT exact chest.
    if (def.chest) {
      const e1 = await skills.depositIntoChestAt(def.chest);
      if (!e1) return;
      log('assigned chest issue —', e1);
    }
    // Otherwise (or if the assigned chest is gone): route to labeled/non-supply chests at base.
    let e = await skills.depositLabeled();
    if (e) {
      const base = memory.getBase();
      if (base) {
        try { await bot.pathfinder.goto(new goals.GoalNear(base.x, base.y, base.z, 2)); } catch (err) { /* */ }
        e = await skills.depositLabeled();
      }
    }
    if (e) e = await skills.depositLoot();           // last resort: nearest non-supply chest
    if (e) log('could not deposit —', e);
  }

  async function runJob() {
    const plan = interpret(jobText(def));
    state.goal = describe(plan);
    switch (plan.kind) {
      case 'idle':
        return;
      case 'guard': {
        await skills.ensureTool('sword'); // arm the guard (fast no-op once it has one)
        // Re-affirm a dynamic follow goal each tick WITHOUT setting mode='follow' (which would
        // make the job loop skip and the guard freeze). Defense reflexes handle fighting.
        const owner = skills.findOwner();
        if (owner) {
          try { bot.pathfinder.setGoal(new goals.GoalFollow(owner, 3), true); } catch (e) { /* */ }
        }
        return;
      }
      case 'hunt': {
        await skills.ensureTool('sword'); // get/forge a sword before hunting
        const e = await skills.hunt();
        if (e) await skills.wander();
        return;
      }
      case 'farm': {
        await skills.ensureTool('hoe'); // get/forge a hoe first
        const e = await skills.farm(); // harvest + replant crops
        await skills.plantTrees();      // farmers also plant trees
        if (e) await skills.wander();   // no ripe crops here — roam to find a field
        return;
      }
      case 'survive':
        await autonomy.step();
        return;
      case 'logistics':
        return runLogistics();
      case 'gather':
        return runGather(plan);
      default:
        return runLlmJob();
    }
  }

  const TOOL_TARGET = 8;
  const FOOD_TARGET = 24;

  async function idleAtBase() {
    const spot = memory.getBase() || memory.getSupply();
    if (spot) { try { await bot.pathfinder.goto(new goals.GoalNear(spot.x, spot.y, spot.z, 3)); } catch (e) { /* */ } }
  }

  // Logistics/foreman: keep the supply chest stocked with tools + food, and keep the crew working.
  async function runLogistics() {
    if (!memory.getSupply()) {
      if (Date.now() - lastNudge > 60000) { lastNudge = Date.now(); bot.chat(`${name}: set a supply chest first — stand at it and say "set supply"`); }
      await idleAtBase();
      return;
    }

    // Throttle the (expensive) supply-chest read; reuse the cached counts in between.
    let counts = cachedSupply;
    if (!counts || Date.now() - lastSupplyCheck > 20000) {
      counts = await skills.supplyCounts();
      cachedSupply = counts;
      lastSupplyCheck = Date.now();
    }
    if (!counts) { await idleAtBase(); return; }

    if (counts.tools < TOOL_TARGET) {
      state.goal = 'forging tools for supply';
      await skills.makeToolset();   // pulls logs/cobble from base chests first, then gathers shortfall
      await skills.stockSupply();
      cachedSupply = null;          // force a fresh read next time
      bot.chat(`${name}: restocked tools in supply`);
      return;
    }
    if (counts.food < FOOD_TARGET) {
      state.goal = 'getting food for supply';
      const e = await skills.hunt();
      await skills.stockSupply();
      cachedSupply = null;
      if (e) await skills.wander();
      else bot.chat(`${name}: added food to supply`);
      return;
    }

    // Stocked -> idle at base and (occasionally) keep the crew moving.
    state.goal = 'running logistics (stocked)';
    if (Date.now() - lastNudge > 90000) {
      lastNudge = Date.now();
      if (manager.tellAll) manager.tellAll('work');
      bot.chat(`${name}: supplies stocked — crew, grab tools/food and keep working`);
    }
    await idleAtBase();
  }

  function describe(p) {
    if (p.kind === 'gather') return `${p.verb} ${p.resource} -> ${p.sink}`;
    return p.kind;
  }

  async function runGather(p) {
    // Default flow: make sure I have the right tool (take from supply, else forge), THEN work.
    const toolFor = p.verb === 'mine' ? 'pickaxe'
      : (p.resource === 'wood' ? 'axe' : (p.resource === 'dirt' || p.resource === 'sand' ? 'shovel' : 'pickaxe'));
    await skills.ensureTool(toolFor);
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
    const ack = (err) => { if (err) bot.chat(err); };

    // come to base + drop everything / go take supplies (these interrupt the current job)
    if (/\b(unload|drop off|come deposit|deposit everything|deposit all|to base|deposit at base)\b/.test(m) || /^(deposit|return)$/.test(m)) {
      await comeDeposit(); return;
    }
    if (/\b(restock|resupply|get supplies|grab supplies|take supplies|need supplies|supplies ready|come get)\b/.test(m)) {
      await comeRestock(); return;
    }

    if (/\bstatus\b|\bwyd\b|what('?s| is| are)\b.*\b(goal|doing|job)\b|how('?s| is) it going/.test(m)) {
      const where = state.mode === 'follow' ? 'following you' : (state.paused ? 'paused' : `on job (${state.goal})`);
      const p = bot.entity.position;
      const chest = def.chest ? `${def.chest.x},${def.chest.y},${def.chest.z}` : 'shared base';
      bot.chat(`${name} status:`);
      bot.chat(`- ${where}`);
      bot.chat(`- hp ${Math.round(bot.health)}/20, food ${Math.round(bot.food)}/20`);
      bot.chat(`- at ${Math.round(p.x)},${Math.round(p.y)},${Math.round(p.z)} | chest: ${chest}`);
      bot.chat(`- supplies: ${skills.gearSummary()}`);
      return;
    }
    if (/^(help|commands|what can you do)$/.test(m)) {
      bot.chat(`${name} commands:`);
      bot.chat('- come / stop / follow / go home');
      bot.chat('- deposit (come dump at base) / restock (get supplies)');
      bot.chat('- this is your chest / clear chest');
      bot.chat('- mine <ore> / collect <block> / get tools / build house');
      bot.chat('- status / defend / stand down');
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
    if (/\bremember\b|\bnote\b|\bkeep in mind\b/.test(m)) { memory.add(message); bot.chat(`${name}: got it, noted`); return; }
    if (/\b(clear chest|forget chest|unassign chest|remove chest|reset chest|no chest|use base|use the base)\b/.test(m)) {
      def.chest = null;
      if (manager.persist) manager.persist();
      bot.chat(`${name}: chest cleared — i'll use the shared base now`);
      return;
    }
    if (/\b(this is your chest|your chest|chest here|set chest|my chest|assign chest)\b/.test(m)) {
      const o = skills.findOwner();
      const p = o ? o.position : bot.entity.position; // your spot if visible, else where i'm standing
      def.chest = { x: Math.round(p.x), y: Math.round(p.y), z: Math.round(p.z) };
      if (manager.persist) manager.persist();
      bot.chat(`${name}: got it — my chest is at ${def.chest.x},${def.chest.y},${def.chest.z}`);
      return;
    }

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
      case 'farm': return await skills.farm();
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
    stopped = true;
    while (timers.length) clearInterval(timers.pop());
    try { if (bot) bot.quit('dismissed'); } catch (e) { /* */ }
  }

  connect();
  return {
    name,
    def,
    handle,
    disconnect,
    say: (msg) => { try { if (bot) bot.chat(msg); } catch (e) { /* */ } },
    ownerPos: () => { try { const o = skills && skills.findOwner(); return o ? o.position : null; } catch (e) { return null; } },
    chestNear: (pos) => { try { const b = skills && skills.chestBlockNear(pos); return b ? b.position : null; } catch (e) { return null; } },
    getState: () => state,
  };
}

module.exports = { createWorker };
