'use strict';
// Action primitives the pal can perform in the world: movement, combat, mining.
// Everything here drives the live mineflayer bot. State (mode, autoDefend) is shared
// with index.js so the chat handler and the defense loop see the same flags.

const { goals, Movements } = require('mineflayer-pathfinder');
const { Vec3 } = require('vec3');
const memory = require('./memory');

// Blocks the pal will happily place when building (preferred order).
const BUILD_BLOCKS = [
  'cobblestone', 'dirt', 'stone', 'netherrack', 'cobbled_deepslate', 'deepslate',
  'andesite', 'diorite', 'granite', 'oak_planks', 'spruce_planks', 'birch_planks',
];

// Log -> plank mapping for the "get tools" multi-step task.
const LOG_TO_PLANK = {
  oak_log: 'oak_planks', birch_log: 'birch_planks', spruce_log: 'spruce_planks',
  jungle_log: 'jungle_planks', acacia_log: 'acacia_planks', dark_oak_log: 'dark_oak_planks',
  mangrove_log: 'mangrove_planks', cherry_log: 'cherry_planks',
};

const HOSTILES = new Set([
  'zombie', 'husk', 'drowned', 'zombie_villager', 'skeleton', 'stray', 'wither_skeleton',
  'creeper', 'spider', 'cave_spider', 'witch', 'enderman', 'slime', 'magma_cube', 'phantom',
  'pillager', 'vindicator', 'evoker', 'ravager', 'vex', 'zombified_piglin', 'piglin_brute',
  'hoglin', 'zoglin', 'blaze', 'ghast', 'silverfish', 'endermite', 'warden', 'breeze',
]);

// Friendly aliases -> concrete block names so "collect wood" / "mine iron" just work.
const BLOCK_ALIASES = {
  wood: ['oak_log', 'birch_log', 'spruce_log', 'jungle_log', 'acacia_log', 'dark_oak_log', 'mangrove_log', 'cherry_log'],
  log: ['oak_log', 'birch_log', 'spruce_log', 'jungle_log', 'acacia_log', 'dark_oak_log', 'mangrove_log', 'cherry_log'],
  logs: ['oak_log', 'birch_log', 'spruce_log', 'jungle_log', 'acacia_log', 'dark_oak_log', 'mangrove_log', 'cherry_log'],
  stone: ['stone', 'cobblestone'],
  cobblestone: ['cobblestone', 'stone'],
  coal: ['coal_ore', 'deepslate_coal_ore'],
  iron: ['iron_ore', 'deepslate_iron_ore'],
  gold: ['gold_ore', 'deepslate_gold_ore'],
  diamond: ['diamond_ore', 'deepslate_diamond_ore'],
  dirt: ['dirt', 'grass_block'],
  sand: ['sand'],
};

function resolveBlockNames(name) {
  const n = String(name || '').toLowerCase().trim();
  return BLOCK_ALIASES[n] || [n];
}

// Best-first melee weapons (the pal equips the strongest it owns before fighting).
const WEAPONS = [
  'netherite_sword', 'diamond_sword', 'iron_sword', 'stone_sword', 'golden_sword', 'wooden_sword',
  'netherite_axe', 'diamond_axe', 'iron_axe', 'stone_axe', 'golden_axe', 'wooden_axe',
];

function makeSkills(bot, config, state) {
  let eating = false;
  let lastSaid = '';
  let lastSaidAt = 0;

  // Progress chatter. During autonomy (state.quiet) it goes to the console only — the pal works
  // silently. For manual commands it chats, but still suppresses the SAME line within 30s.
  function say(msg) {
    if (state.quiet) { console.log('[Ninja Pal]', msg); return; }
    const now = Date.now();
    if (msg === lastSaid && now - lastSaidAt < 30000) return;
    lastSaid = msg;
    lastSaidAt = now;
    bot.chat(msg);
  }

  // Throttled console log — same idea for noisy dig failures.
  let lastLog = '';
  let lastLogAt = 0;
  function logOnce(msg) {
    const now = Date.now();
    if (msg === lastLog && now - lastLogAt < 30000) return;
    lastLog = msg;
    lastLogAt = now;
    console.error(msg);
  }

  function findOwner() {
    return (bot.players[config.owner] && bot.players[config.owner].entity) || null;
  }

  function inventorySummary() {
    const items = bot.inventory.items();
    if (!items.length) return 'empty';
    const counts = {};
    for (const it of items) counts[it.name] = (counts[it.name] || 0) + it.count;
    return Object.entries(counts)
      .map(([n, c]) => `${c} ${n}`)
      .join(', ');
  }

  // A rich snapshot of what the pal can sense — fed to the brain so it reasons about the
  // actual situation (night? mobs closing in? low food? what's in the bag?).
  function perceive() {
    const pos = bot.entity ? bot.entity.position : new Vec3(0, 0, 0);
    const t = (bot.time && bot.time.timeOfDay) || 0;
    const isNight = t > 13000 && t < 23000;
    const hostiles = Object.values(bot.entities)
      .filter((e) => e.type === 'mob' && HOSTILES.has(e.name) && e.position)
      .map((e) => ({ name: e.name, d: Math.round(e.position.distanceTo(pos)) }))
      .filter((e) => e.d < 32)
      .sort((a, b) => a.d - b.d)
      .slice(0, 5);
    const players = Object.values(bot.players)
      .filter((p) => p.entity && p.username !== bot.username)
      .map((p) => p.username);
    return [
      `pos=(${Math.round(pos.x)},${Math.round(pos.y)},${Math.round(pos.z)})`,
      `time=${isNight ? 'NIGHT' : 'day'}`,
      `health=${Math.round(bot.health)}/20`,
      `food=${Math.round(bot.food)}/20`,
      `mode=${state.mode}`,
      `autoDefend=${state.autoDefend}`,
      `threats=[${hostiles.map((h) => `${h.name}@${h.d}m`).join(', ') || 'none'}]`,
      `players=[${players.join(', ') || 'none'}]`,
      `carrying=[${inventorySummary()}]`,
    ].join(' | ');
  }

  function equipBestWeapon() {
    const items = bot.inventory.items();
    for (const name of WEAPONS) {
      const it = items.find((i) => i.name === name);
      if (it) {
        bot.equip(it, 'hand').catch(() => {});
        return;
      }
    }
  }

  function setMovements() {
    const mcData = require('minecraft-data')(bot.version);
    const m = new Movements(bot);
    m.allowSprinting = true;
    m.canDig = true;
    m.digCost = 3; // mild nudge to prefer walking; still digs freely for resources / to get unstuck

    // NEVER break doors / trapdoors / fence gates — go through or around them.
    try {
      for (const n of Object.keys(mcData.blocksByName)) {
        if (/_door$|_trapdoor$|_fence_gate$/.test(n)) {
          const id = mcData.blocksByName[n].id;
          if (m.blocksCantBreak && id != null) m.blocksCantBreak.add(id);
        }
      }
    } catch (e) { /* older mineflayer */ }

    // No-dig ZONE around the base: dig freely in the world, but never tunnel through the base
    // (the player's build). Outside the zone everything is normal, so the bot never gets trapped.
    if (typeof m.safeToBreak === 'function') {
      const origSafe = m.safeToBreak.bind(m);
      m.safeToBreak = (block) => {
        try {
          const base = memory.getBase();
          if (base && block && block.position) {
            const p = block.position;
            // protected 16x16 footprint around the base (±8), tall enough for a real build (±8)
            if (Math.abs(p.x - base.x) <= 8 && Math.abs(p.y - base.y) <= 8 && Math.abs(p.z - base.z) <= 8) {
              return false; // never dig here -> use the door / go around
            }
          }
        } catch (e) { /* */ }
        return origSafe(block);
      };
    }

    bot.pathfinder.setMovements(m);
  }

  function followOwner() {
    const owner = findOwner();
    if (!owner) return "i can't see you right now";
    state.mode = 'follow';
    bot.pathfinder.setGoal(new goals.GoalFollow(owner, 2), true); // dynamic = keep chasing
    return null;
  }

  function stop() {
    state.mode = 'idle';
    bot.pathfinder.setGoal(null);
    if (bot.pvp) bot.pvp.stop();
    return null;
  }

  function come() {
    const owner = findOwner();
    if (!owner) return "i can't see you right now";
    state.mode = 'idle';
    const p = owner.position;
    bot.pathfinder.setGoal(new goals.GoalNear(p.x, p.y, p.z, 1));
    return null;
  }

  // Equip the right tool for a block (axe for wood, pickaxe for stone/ore) — best tier owned.
  async function equipForBlock(block) {
    const n = block.name;
    const kind =
      n.endsWith('_log') || n.includes('wood') || n.endsWith('_planks') || n.includes('leaves')
        ? '_axe'
        : '_pickaxe';
    const order =
      kind === '_pickaxe'
        ? ['netherite_pickaxe', 'diamond_pickaxe', 'iron_pickaxe', 'stone_pickaxe', 'wooden_pickaxe']
        : ['netherite_axe', 'diamond_axe', 'iron_axe', 'stone_axe', 'wooden_axe'];
    const items = bot.inventory.items();
    for (const name of order) {
      const it = items.find((i) => i.name === name);
      if (it) {
        try { await bot.equip(it, 'hand'); } catch (e) { /* ignore */ }
        return;
      }
    }
  }

  // Try to dig ONE matching block, considering several nearest candidates (so a single
  // unreachable tree doesn't make us give up). Returns:
  //   'ok' | 'none' (nothing in range) | 'cantbreak' (wrong tool) | 'unreachable' (found but
  //   couldn't path/dig any) | 'cancel'.
  async function gatherOne(ids, label, maxDistance = 64) {
    const positions = bot.findBlocks({ matching: ids, maxDistance, count: 12 });
    if (!positions.length) return 'none';
    logOnce(`[Ninja Pal] ${label}: ${positions.length} candidate(s) in range`);
    let sawCantBreak = false;
    for (const pos of positions) {
      if (state.cancel) return 'cancel';
      const block = bot.blockAt(pos);
      if (!block) continue;
      try {
        await bot.pathfinder.goto(new goals.GoalGetToBlock(pos.x, pos.y, pos.z));
        bot.pathfinder.setGoal(null); // stop moving so the dig isn't aborted by residual pathing
        await equipForBlock(block);
        if (!bot.canDigBlock(block)) { sawCantBreak = true; continue; }
        await bot.dig(block);
        try { await bot.pathfinder.goto(new goals.GoalNear(pos.x, pos.y, pos.z, 0)); } catch (e) { /* grab drop */ }
        return 'ok';
      } catch (e) {
        logOnce(`[Ninja Pal] dig fail (${label}): ${e.message}`);
        // try the next candidate
      }
    }
    return sawCantBreak ? 'cantbreak' : 'unreachable';
  }

  async function collect(blockName, count = 1) {
    const mcData = require('minecraft-data')(bot.version);
    const ids = resolveBlockNames(blockName)
      .map((n) => mcData.blocksByName[n] && mcData.blocksByName[n].id)
      .filter((x) => x != null);
    if (!ids.length) return `i don't know how to collect "${blockName}"`;
    const want = Math.max(1, Math.min(count | 0 || 1, 16));
    say(`getting ${want} ${blockName}`);
    let got = 0;
    let unreachable = 0;
    while (got < want) {
      if (state.cancel) return null;
      const r = await gatherOne(ids, blockName);
      if (r === 'ok') { got++; unreachable = 0; continue; }
      if (r === 'cancel') return null;
      if (r === 'cantbreak') return got > 0 ? null : `i can't break ${blockName} with my tools`;
      if (r === 'none') return got > 0 ? null : `no ${blockName} in sight`;
      // 'unreachable' — found some but couldn't path/dig; try a couple times then report clearly
      if (++unreachable >= 2) {
        return got > 0 ? null : `i see ${blockName} but can't reach it (blocked by leaves/terrain)`;
      }
    }
    return null;
  }

  function gotoCoord(x, y, z) {
    if ([x, y, z].some((v) => typeof v !== 'number' || Number.isNaN(v))) {
      return 'give me real coordinates';
    }
    state.mode = 'idle';
    bot.pathfinder.setGoal(new goals.GoalNear(x, y, z, 1));
    return null;
  }

  function attackNearest() {
    const target = bot.nearestEntity((e) => e.type === 'mob' && HOSTILES.has(e.name));
    if (!target) return 'nothing to fight nearby';
    equipBestWeapon();
    bot.pvp.attack(target);
    return null;
  }

  // Reactive defense — run on a short timer. Auto-engages hostiles near the owner or the
  // pal itself, independent of the LLM so it reacts instantly.
  function defendTick() {
    if (!state.autoDefend || state.panicking) return; // don't re-engage while fleeing
    const owner = findOwner();
    const ref = owner ? owner.position : bot.entity.position;
    const target = bot.nearestEntity(
      (e) => e.type === 'mob' && HOSTILES.has(e.name) && e.position.distanceTo(ref) < 12
    );
    if (target && !bot.pvp.target) {
      equipBestWeapon();
      bot.pvp.attack(target);
    }
  }

  // --- doors: open one in the way, close it behind ---------------------------
  let lastDoorPos = null;
  const isDoorBlock = (b) => b && (b.name.endsWith('_door') || b.name.endsWith('_fence_gate'));
  const isDoorOpen = (b) => {
    const p = b && b.getProperties ? b.getProperties() : {};
    return p.open === true || p.open === 'true';
  };
  let doorBusy = false;
  let doorCooldownUntil = 0;
  let doorCooldownPos = null;
  async function doorTick() {
    if (doorBusy) return;
    const goal = bot.pathfinder && bot.pathfinder.goal;
    if (!goal) return; // only operate doors while actually travelling somewhere
    // Open the nearest CLOSED door in reach (the pathfinder treats it as a wall), step through,
    // then close it behind us.
    const door = bot.findBlock({ matching: (b) => isDoorBlock(b) && !isDoorOpen(b), maxDistance: 4.5 });
    if (!door) return;
    if (doorCooldownPos && Date.now() < doorCooldownUntil && door.position.equals(doorCooldownPos)) return; // just used it
    doorBusy = true;
    try {
      await bot.lookAt(door.position.offset(0.5, 0.5, 0.5), true);
      await bot.activateBlock(door); // open
      // walk to the block just past the doorway (door now open => pathfinder routes through)
      const me = bot.entity.position.floored();
      const d = door.position;
      const far = { x: d.x + (Math.sign(d.x - me.x) || 0), y: me.y, z: d.z + (Math.sign(d.z - me.z) || 0) };
      await bot.pathfinder.goto(new goals.GoalBlock(far.x, far.y, far.z));
      // close it behind us
      const b = bot.blockAt(d);
      if (isDoorBlock(b) && isDoorOpen(b)) {
        await bot.lookAt(d.offset(0.5, 0.5, 0.5), true);
        await bot.activateBlock(b);
      }
      doorCooldownPos = d.clone();
      doorCooldownUntil = Date.now() + 5000; // don't re-open this door for a bit (avoids a loop)
    } catch (e) { /* */ } finally {
      if (goal) { try { bot.pathfinder.setGoal(goal, true); } catch (e) { /* */ } } // resume original route
      doorBusy = false;
    }
  }

  // Auto-eat when hungry so the pal doesn't starve (and natural regen keeps health up).
  async function eatTick() {
    // Don't equip food mid-task (equipping aborts an in-progress dig). Only eat when free or starving.
    if (eating || bot.food >= 18) return;
    if (state.busy && bot.food > 6) return;
    const mcData = require('minecraft-data')(bot.version);
    const food = bot.inventory.items().find((i) => mcData.foodsByName[i.name]);
    if (!food) return;
    eating = true;
    try {
      await bot.equip(food, 'hand');
      await bot.consume();
    } catch (e) {
      /* interrupted / not edible right now */
    } finally {
      eating = false;
    }
  }

  // Craft an item, using a nearby crafting table when the recipe needs one.
  async function craft(itemName, count = 1) {
    const mcData = require('minecraft-data')(bot.version);
    const item = mcData.itemsByName[String(itemName || '').toLowerCase().trim()];
    if (!item) return `i don't know the item "${itemName}"`;

    const tableId = mcData.blocksByName.crafting_table.id;
    const table = bot.findBlock({ matching: tableId, maxDistance: 32 });
    const want = Math.max(1, Math.min(count | 0 || 1, 64));

    const withTable = table ? bot.recipesFor(item.id, null, 1, table) : [];
    const withoutTable = bot.recipesFor(item.id, null, 1, null);
    const recipe = withoutTable[0] || withTable[0];
    if (!recipe) return `i can't craft ${itemName} with what i have`;

    const needTable = recipe.requiresTable;
    if (needTable && !table) return `i need a crafting table near me to make ${itemName}`;

    try {
      if (needTable) {
        await bot.pathfinder.goto(new goals.GoalNear(table.position.x, table.position.y, table.position.z, 2));
      }
      await bot.craft(recipe, want, needTable ? table : null);
      return null;
    } catch (e) {
      return `crafting ${itemName} failed: ${e.message}`;
    }
  }

  // Walk to the owner and drop items so they can pick them up.
  async function giveToOwner(itemName, count) {
    const owner = findOwner();
    if (!owner) return "i can't see you to hand it over";
    await bot.pathfinder.goto(new goals.GoalNear(owner.position.x, owner.position.y, owner.position.z, 2));
    await bot.lookAt(owner.position.offset(0, 1, 0));

    const items = bot.inventory.items();
    if (!items.length) return "i've got nothing to give";

    const wanted = String(itemName || 'all').toLowerCase().trim();
    let tossed = 0;
    if (wanted === 'all' || wanted === 'everything') {
      for (const it of items) {
        try { await bot.toss(it.type, null, it.count); tossed += it.count; } catch (e) { /* skip */ }
      }
    } else {
      const names = resolveBlockNames(wanted);
      for (const it of items.filter((i) => names.includes(i.name) || i.name === wanted)) {
        const n = count ? Math.min(count, it.count) : it.count;
        try { await bot.toss(it.type, null, n); tossed += n; } catch (e) { /* skip */ }
      }
    }
    if (tossed === 0) return `i don't have any ${wanted}`;
    return null;
  }

  // Drop items on the ground where the pal is standing.
  async function drop(itemName, count) {
    const wanted = String(itemName || 'all').toLowerCase().trim();
    const items = bot.inventory.items();
    const matches = (wanted === 'all' || wanted === 'everything')
      ? items
      : items.filter((i) => resolveBlockNames(wanted).includes(i.name) || i.name === wanted);
    if (!matches.length) return `i don't have any ${wanted}`;
    let tossed = 0;
    for (const it of matches) {
      const n = count ? Math.min(count, it.count) : it.count;
      try { await bot.toss(it.type, null, n); tossed += n; } catch (e) { /* skip */ }
    }
    return tossed ? null : `couldn't drop ${wanted}`;
  }

  const FOOD_RESERVE = 8; // food a worker keeps to eat; surplus gets deposited

  // Tools/weapons/utility a worker keeps (NOT food — food is handled with a reserve so hunters
  // and farmers actually deposit their harvest).
  function isKeepTool(name) {
    if (/_(pickaxe|axe|sword|shovel|hoe)$/.test(name)) return true;
    if (['bucket', 'water_bucket', 'lava_bucket', 'bow', 'crossbow', 'arrow', 'shield',
      'flint_and_steel', 'torch', 'crafting_table', 'furnace', 'shears'].includes(name)) return true;
    return false;
  }

  // Everything a worker is carrying that counts as "supplies/gear" (incl. food) — for status.
  function isGear(name, mcData) {
    return isKeepTool(name) || (mcData.foodsByName && mcData.foodsByName[name]);
  }

  // Is there still depositable loot on us? (non-tool, or food beyond the reserve)
  function hasLoot(mcData) {
    let food = 0;
    for (const it of bot.inventory.items()) {
      if (isKeepTool(it.name)) continue;
      if (mcData.foodsByName && mcData.foodsByName[it.name]) { food += it.count; if (food > FOOD_RESERVE) return true; continue; }
      return true;
    }
    return false;
  }

  // Deposit loot into an OPEN chest: all non-tools, plus food beyond foodBox.n (shared reserve).
  async function dumpInto(chest, foodBox) {
    const mcData = require('minecraft-data')(bot.version);
    for (const it of bot.inventory.items()) {
      if (isKeepTool(it.name)) continue;
      if (mcData.foodsByName && mcData.foodsByName[it.name]) {
        const keep = Math.min(it.count, foodBox.n);
        foodBox.n -= keep;
        const dep = it.count - keep;
        if (dep > 0) { try { await chest.deposit(it.type, null, dep); } catch (e) { /* full */ } }
      } else {
        try { await chest.deposit(it.type, null, it.count); } catch (e) { /* full */ }
      }
    }
  }

  // Find a chest block at/adjacent to a saved spot (handles standing on/next to the chest).
  function chestBlockNear(pos) {
    const chestNames = new Set(['chest', 'trapped_chest', 'barrel']);
    const offs = [[0, 0, 0], [0, -1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, 1, 0]];
    for (const d of offs) {
      const b = bot.blockAt(new Vec3(pos.x + d[0], pos.y + d[1], pos.z + d[2]));
      if (b && chestNames.has(b.name)) return b;
    }
    return null;
  }

  // Deposit loot into the EXACT chest at a saved spot (for an assigned chest).
  async function depositIntoChestAt(pos) {
    try { await bot.pathfinder.goto(new goals.GoalNear(pos.x, pos.y, pos.z, 2)); } catch (e) { /* */ }
    const block = chestBlockNear(pos);
    if (!block) return 'no chest at the assigned spot';
    let chest;
    try { chest = await bot.openContainer(block); } catch (e) { return "couldn't open my chest"; }
    await dumpInto(chest, { n: FOOD_RESERVE });
    try { chest.close(); } catch (e) { /* */ }
    return null;
  }

  // Teleport to a coordinate via server command (needs cheats + the worker /op'd).
  function tpTo(x, y, z) {
    bot.chat(`/tp ${bot.username} ${Math.round(x)} ${Math.round(y)} ${Math.round(z)}`);
    return null;
  }

  // Dump LOOT into the nearest NON-supply chest(s), keeping tools + a food reserve. Overflow-safe.
  async function depositLoot() {
    const mcData = require('minecraft-data')(bot.version);
    const me = bot.entity.position;
    const chests = scanChests(16)
      .filter((c) => !/supply|tools|gear|items/.test(c.label))
      .sort((a, b) => a.pos.distanceTo(me) - b.pos.distanceTo(me));
    if (!chests.length) return 'no chest at base';
    const foodBox = { n: FOOD_RESERVE };
    for (const c of chests) {
      if (state.cancel || !hasLoot(mcData)) break;
      try {
        await bot.pathfinder.goto(new goals.GoalGetToBlock(c.pos.x, c.pos.y, c.pos.z));
        const chest = await bot.openContainer(bot.blockAt(c.pos));
        await dumpInto(chest, foodBox);
        try { chest.close(); } catch (e) { /* */ }
      } catch (e) { /* */ }
    }
    return null;
  }

  // Deposit items into the nearest chest/barrel.
  async function depositToChest(itemName, count) {
    const mcData = require('minecraft-data')(bot.version);
    const chestIds = ['chest', 'trapped_chest', 'barrel']
      .map((n) => mcData.blocksByName[n] && mcData.blocksByName[n].id)
      .filter((x) => x != null);
    const chestBlock = bot.findBlock({ matching: chestIds, maxDistance: 16 });
    if (!chestBlock) return "i don't see a chest nearby — drop it on the ground instead?";
    try {
      await bot.pathfinder.goto(new goals.GoalGetToBlock(chestBlock.position.x, chestBlock.position.y, chestBlock.position.z));
    } catch (e) { /* try to open anyway */ }
    let chest;
    try {
      chest = await bot.openContainer(chestBlock);
    } catch (e) {
      return "couldn't open the chest";
    }
    const wanted = String(itemName || 'all').toLowerCase().trim();
    const items = bot.inventory.items().filter(
      (i) => wanted === 'all' || resolveBlockNames(wanted).includes(i.name) || i.name === wanted
    );
    let stored = 0;
    for (const it of items) {
      const n = count ? Math.min(count, it.count) : it.count;
      try { await chest.deposit(it.type, null, n); stored += n; } catch (e) { /* full / mismatch */ }
    }
    try { chest.close(); } catch (e) { /* ignore */ }
    if (!stored) return `nothing to store (no ${wanted})`;
    return null;
  }

  // Harvest ripe crops nearby and replant the seed. Returns null if it harvested anything.
  const CROPS = {
    wheat: { age: 7, seed: 'wheat_seeds' },
    carrots: { age: 7, seed: 'carrot' },
    potatoes: { age: 7, seed: 'potato' },
    beetroots: { age: 3, seed: 'beetroot_seeds' },
  };
  async function farm() {
    const mcData = require('minecraft-data')(bot.version);
    const cropIds = Object.keys(CROPS)
      .map((n) => mcData.blocksByName[n] && mcData.blocksByName[n].id)
      .filter((x) => x != null);
    if (!cropIds.length) return 'i dont know the crops here';
    const positions = bot.findBlocks({ matching: cropIds, maxDistance: 32, count: 30 });
    if (!positions.length) return 'no crops nearby';

    let harvested = 0;
    for (const pos of positions) {
      if (state.cancel) break;
      const block = bot.blockAt(pos);
      if (!block) continue;
      const crop = CROPS[block.name];
      if (!crop) continue;
      const props = block.getProperties ? block.getProperties() : {};
      if (Number(props.age) < crop.age) continue; // not ripe yet
      try {
        await bot.pathfinder.goto(new goals.GoalGetToBlock(pos.x, pos.y, pos.z));
        await bot.dig(block);
        harvested++;
        // replant onto the farmland below
        const farmland = bot.blockAt(pos.offset(0, -1, 0));
        const seed = bot.inventory.items().find((i) => i.name === crop.seed);
        if (farmland && farmland.name === 'farmland' && seed) {
          try { await bot.equip(seed, 'hand'); await bot.placeBlock(farmland, new Vec3(0, 1, 0)); } catch (e) { /* */ }
        }
      } catch (e) { /* next crop */ }
    }
    return harvested ? null : 'no ripe crops to harvest';
  }

  // ---- labeled chests (signs) -----------------------------------------------

  // Read a sign's text (front+back), lowercased. Best-effort across MC versions.
  function readSign(b) {
    if (!b) return '';
    try {
      if (typeof b.getSignText === 'function') {
        const t = b.getSignText();
        return (Array.isArray(t) ? t.join(' ') : String(t || '')).toLowerCase();
      }
    } catch (e) { /* */ }
    if (b.signText) return String(b.signText).toLowerCase();
    return '';
  }

  // Coarse resource label for matching chest signs.
  function resourceOf(name) {
    if (name.endsWith('_log') || name.endsWith('_planks')) return 'wood';
    if (name.includes('iron')) return 'iron';
    if (name.includes('gold')) return 'gold';
    if (name.includes('diamond')) return 'diamond';
    if (name.includes('coal')) return 'coal';
    if (name === 'cobblestone' || name === 'stone' || name.includes('deepslate')) return 'stone';
    if (name === 'dirt' || name === 'grass_block') return 'dirt';
    if (name === 'sand') return 'sand';
    return name;
  }

  // Find chests near a point and read the sign labeling each (sign on/above/beside the chest).
  function scanChests(maxDistance = 24) {
    const mcData = require('minecraft-data')(bot.version);
    const chestIds = ['chest', 'trapped_chest', 'barrel']
      .map((n) => mcData.blocksByName[n] && mcData.blocksByName[n].id)
      .filter((x) => x != null);
    const positions = bot.findBlocks({ matching: chestIds, maxDistance, count: 24 });
    const around = [[0, 1, 0], [0, 2, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [1, 1, 0], [-1, 1, 0], [0, 1, 1], [0, 1, -1]];
    return positions.map((pos) => {
      let label = '';
      for (const d of around) {
        const b = bot.blockAt(pos.offset(d[0], d[1], d[2]));
        if (b && b.name.includes('sign')) { const t = readSign(b).trim(); if (t) { label = t; break; } }
      }
      return { pos, label };
    });
  }

  // Deposit loot, routing each resource to its labeled chest; if a chest is FULL, overflow into
  // any other chest with space. Keeps tools/weapons/food. Returns null if it deposited (or had
  // nothing); a message if there were no usable chests.
  // True if this chest is the supply chest — by sign label OR by the saved supply position.
  function isSupplyChest(c) {
    if (/supply|tools|gear|items/.test(c.label)) return true;
    const s = memory.getSupply();
    return !!(s && Math.abs(c.pos.x - s.x) <= 1 && Math.abs(c.pos.y - s.y) <= 1 && Math.abs(c.pos.z - s.z) <= 1);
  }

  async function depositLabeled() {
    const mcData = require('minecraft-data')(bot.version);
    const chests = scanChests(24);
    if (!chests.length) return 'no chests at base';
    // NEVER deposit loot into the supply chest (by label or saved position).
    const drops = chests.filter((c) => !isSupplyChest(c));
    if (!drops.length) return 'no deposit chest at base (only supply?)';

    const isGeneric = (c) => !c.label || /deposit|loot|drop|store|misc|junk/.test(c.label);
    const ordered = [
      ...drops.filter((c) => c.label && !isGeneric(c)),
      ...drops.filter((c) => isGeneric(c) && c.label),
      ...drops.filter((c) => !c.label),
    ];
    const foodBox = { n: FOOD_RESERVE };

    // Pass 1: resource-labeled chests take only their resource; generic chests take anything.
    for (const c of ordered) {
      if (state.cancel || !hasLoot(mcData)) break;
      try {
        await bot.pathfinder.goto(new goals.GoalGetToBlock(c.pos.x, c.pos.y, c.pos.z));
        const chest = await bot.openContainer(bot.blockAt(c.pos));
        if (c.label && !isGeneric(c)) {
          for (const it of bot.inventory.items()) {
            if (isKeepTool(it.name) || (mcData.foodsByName && mcData.foodsByName[it.name])) continue;
            const res = resourceOf(it.name);
            if (!(c.label.includes(res) || res.includes(c.label))) continue;
            try { await chest.deposit(it.type, null, it.count); } catch (e) { /* */ }
          }
        } else {
          await dumpInto(chest, foodBox);
        }
        try { chest.close(); } catch (e) { /* */ }
      } catch (e) { /* */ }
    }

    // Pass 2 (overflow): dump whatever's left into any non-supply chest with space.
    if (hasLoot(mcData)) {
      for (const c of ordered) {
        if (state.cancel || !hasLoot(mcData)) break;
        try {
          await bot.pathfinder.goto(new goals.GoalGetToBlock(c.pos.x, c.pos.y, c.pos.z));
          const chest = await bot.openContainer(bot.blockAt(c.pos));
          await dumpInto(chest, foodBox);
          try { chest.close(); } catch (e) { /* */ }
        } catch (e) { /* */ }
      }
    }
    return null;
  }

  // Withdraw ONLY what's needed from the supply chest (sign: supply/tools), up to a small target
  // ("supply ratio") — e.g. up to 2 pickaxes, 1 axe/sword/shovel, a little food + torches.
  async function restockFromSupply() {
    // Prefer the saved supply position (signs may not read); else a sign-labeled supply chest.
    let supplyBlock = null;
    const s = memory.getSupply();
    if (s) supplyBlock = chestBlockNear(new Vec3(s.x, s.y, s.z));
    if (!supplyBlock) {
      const c = scanChests(24).find((c2) => /supply|tools|gear|items/.test(c2.label));
      if (c) supplyBlock = bot.blockAt(c.pos);
    }
    if (!supplyBlock) return false; // no supply chest at all
    const mcData = require('minecraft-data')(bot.version);
    const countMine = (match) => bot.inventory.items().filter(match).reduce((a, b) => a + b.count, 0);
    const snap = () => { const m = {}; for (const it of bot.inventory.items()) m[it.name] = (m[it.name] || 0) + it.count; return m; };
    try {
      await bot.pathfinder.goto(new goals.GoalGetToBlock(supplyBlock.position.x, supplyBlock.position.y, supplyBlock.position.z));
      const chest = await bot.openContainer(supplyBlock);
      const before = snap();

      // take up to `target` of items matching `match` (works on both inventory + chest items via .name)
      const take = async (match, target) => {
        let have = countMine(match);
        for (const item of chest.containerItems()) {
          if (have >= target) break;
          if (match(item)) {
            try { await chest.withdraw(item.type, null, Math.min(target - have, item.count)); } catch (e) { /* */ }
            have = countMine(match);
          }
        }
      };

      await take((i) => i.name.endsWith('_pickaxe'), 2);
      await take((i) => i.name.endsWith('_sword'), 1);
      await take((i) => i.name.endsWith('_axe'), 1);
      await take((i) => i.name.endsWith('_shovel'), 1);
      await take((i) => i.name.endsWith('_hoe'), 1);
      await take((i) => i.name.endsWith('_seeds') || i.name === 'carrot' || i.name === 'potato', 16);
      if (bot.food < 16) await take((i) => mcData.foodsByName && mcData.foodsByName[i.name], 8);
      await take((i) => i.name === 'torch', 16);

      try { chest.close(); } catch (e) { /* */ }

      // Report exactly what was withdrawn.
      const after = snap();
      const got = [];
      for (const n of Object.keys(after)) {
        const d = after[n] - (before[n] || 0);
        if (d > 0) got.push(`${d} ${n}`);
      }
      return got.length ? got.join(', ') : ''; // '' = took nothing (already stocked)
    } catch (e) { return false; }
  }

  // Locate the supply chest block (saved position first, else a sign-labeled one).
  function supplyChestBlock() {
    const s = memory.getSupply();
    if (s) { const b = chestBlockNear(new Vec3(s.x, s.y, s.z)); if (b) return b; }
    const c = scanChests(24).find((c2) => /supply|tools|gear|items/.test(c2.label));
    return c ? bot.blockAt(c.pos) : null;
  }

  // How many tools + food are sitting in the supply chest (for the logistics worker).
  async function supplyCounts() {
    const block = supplyChestBlock();
    if (!block) return null;
    const mcData = require('minecraft-data')(bot.version);
    try {
      await bot.pathfinder.goto(new goals.GoalGetToBlock(block.position.x, block.position.y, block.position.z));
      const chest = await bot.openContainer(block);
      let tools = 0;
      let food = 0;
      for (const it of chest.containerItems()) {
        if (/_(pickaxe|axe|sword|shovel|hoe)$/.test(it.name)) tools += it.count;
        else if (mcData.foodsByName && mcData.foodsByName[it.name]) food += it.count;
      }
      try { chest.close(); } catch (e) { /* */ }
      return { tools, food };
    } catch (e) { return null; }
  }

  // Put surplus tools + food from inventory INTO the supply chest (keep a little for self).
  async function stockSupply() {
    const block = supplyChestBlock();
    if (!block) return 'no supply chest set';
    const mcData = require('minecraft-data')(bot.version);
    try {
      await bot.pathfinder.goto(new goals.GoalGetToBlock(block.position.x, block.position.y, block.position.z));
      const chest = await bot.openContainer(block);
      const keep = { pickaxe: 1, axe: 1 };
      let foodKeep = FOOD_RESERVE;
      for (const it of bot.inventory.items()) {
        const kind = (it.name.match(/_(pickaxe|axe|sword|shovel|hoe)$/) || [])[1];
        if (kind) {
          const k = keep[kind] || 0; keep[kind] = 0;
          if (it.count - k > 0) { try { await chest.deposit(it.type, null, it.count - k); } catch (e) { /* */ } }
        } else if (mcData.foodsByName && mcData.foodsByName[it.name]) {
          const k = Math.min(it.count, foodKeep); foodKeep -= k;
          if (it.count - k > 0) { try { await chest.deposit(it.type, null, it.count - k); } catch (e) { /* */ } }
        }
      }
      try { chest.close(); } catch (e) { /* */ }
      return null;
    } catch (e) { return 'couldnt reach supply chest'; }
  }

  // Withdraw up to `amount` of items matching `match` from the base deposit chests (not supply).
  async function withdrawFromBase(match, amount) {
    const chests = scanChests(24).filter((c) => !isSupplyChest(c));
    let got = 0;
    for (const c of chests) {
      if (got >= amount || state.cancel) break;
      try {
        await bot.pathfinder.goto(new goals.GoalGetToBlock(c.pos.x, c.pos.y, c.pos.z));
        const chest = await bot.openContainer(bot.blockAt(c.pos));
        for (const item of chest.containerItems()) {
          if (got >= amount) break;
          if (match(item)) {
            const take = Math.min(amount - got, item.count);
            try { await chest.withdraw(item.type, null, take); got += take; } catch (e) { /* */ }
          }
        }
        try { chest.close(); } catch (e) { /* */ }
      } catch (e) { /* */ }
    }
    return got;
  }

  // Forge a stone tool set. First uses materials the crew already stored (logs/cobblestone in the
  // deposit chests); only gathers the shortfall itself. Tools stay on the worker.
  async function makeToolset() {
    const countName = (n) => bot.inventory.items().filter((i) => i.name === n).reduce((a, b) => a + b.count, 0);
    const planks = () => bot.inventory.items().filter((i) => i.name.endsWith('_planks')).reduce((a, b) => a + b.count, 0);

    // Materials: only get/convert wood if we DON'T already have enough planks (no over-gathering).
    if (planks() < 8) {
      await withdrawFromBase((i) => i.name.endsWith('_log') || i.name.endsWith('_planks'), 4);
      if (countLogs() < 2 && planks() < 4) {
        const e = await collect('wood', 2);
        if (e && planks() < 2) return e;
      }
      await craftPlanksFromLogs();
    }

    // Crafting table (tools need one) — reuse a nearby one, only build if none.
    const t = await ensureCraftingTable();
    if (t) return t;

    if (countName('stick') < 4) await craft('stick', 2);

    // Cobblestone: only mine if short.
    if (countName('cobblestone') < 12) {
      await withdrawFromBase((i) => i.name === 'cobblestone', 16);
      if (countName('cobblestone') < 6) {
        const e = await mineOre('stone', 12);
        if (e && countName('cobblestone') < 3) return e;
      }
    }

    const made = [];
    for (const tool of ['stone_pickaxe', 'stone_axe', 'stone_sword', 'stone_shovel', 'stone_hoe']) {
      if (state.cancel) break;
      const e = await craft(tool, 1);
      if (!e) made.push(tool.replace('stone_', ''));
    }
    return made.length ? null : 'couldnt craft tools (need stone + a crafting table)';
  }

  // --- default bootstrap: make sure a worker HAS the tool its job needs ----------------------
  function hasTool(kind) {
    return bot.inventory.items().some((i) => i.name.endsWith(`_${kind}`));
  }

  // Ensure the worker has a tool of `kind` (pickaxe/axe/sword/shovel/hoe):
  //   1) already have it -> done; 2) take one from the supply chest; 3) forge a wooden one.
  async function ensureTool(kind) {
    if (hasTool(kind)) return null;
    await restockFromSupply();           // try the supply chest first
    if (hasTool(kind)) return null;
    // forge a wooden one: wood -> planks -> table -> stick -> wooden_<kind>
    if (countLogs() < 2 && !bot.inventory.items().some((i) => i.name.endsWith('_planks'))) {
      const e = await collect('wood', 2);
      if (e) return `no ${kind}, and no wood to make one`;
    }
    await craftPlanksFromLogs();
    await ensureCraftingTable();
    await craft('stick', 1);
    await craft(`wooden_${kind}`, 1);
    return hasTool(kind) ? null : `couldn't make a ${kind}`;
  }

  // Plant trees: get saplings (break leaves if none on hand), then plant on grass/dirt nearby.
  async function plantTrees(max = 3) {
    const SAPLINGS = ['oak_sapling', 'birch_sapling', 'spruce_sapling', 'jungle_sapling', 'acacia_sapling', 'dark_oak_sapling', 'cherry_sapling'];
    const haveSapling = () => bot.inventory.items().find((i) => SAPLINGS.includes(i.name));
    if (!haveSapling()) {
      for (let i = 0; i < 5 && !haveSapling(); i++) {
        if (state.cancel) break;
        const leaf = bot.findBlock({ matching: (b) => b && b.name.endsWith('_leaves'), maxDistance: 16 });
        if (!leaf) break;
        try {
          await bot.pathfinder.goto(new goals.GoalGetToBlock(leaf.position.x, leaf.position.y, leaf.position.z));
          await bot.dig(leaf);
          try { await bot.pathfinder.goto(new goals.GoalNear(leaf.position.x, leaf.position.y, leaf.position.z, 0)); } catch (e) { /* grab drop */ }
        } catch (e) { break; }
      }
    }
    let sap = haveSapling();
    if (!sap) return 'no saplings to plant';
    const ground = bot.findBlocks({ matching: (b) => b && ['grass_block', 'dirt', 'podzol', 'coarse_dirt', 'rooted_dirt'].includes(b.name), maxDistance: 16, count: 24 });
    let planted = 0;
    for (const pos of ground) {
      if (planted >= max || state.cancel) break;
      const above = bot.blockAt(pos.offset(0, 1, 0));
      if (!above || above.boundingBox !== 'empty') continue;
      try {
        await bot.pathfinder.goto(new goals.GoalNear(pos.x, pos.y + 1, pos.z, 2));
        await bot.equip(sap, 'hand');
        await bot.placeBlock(bot.blockAt(pos), new Vec3(0, 1, 0));
        planted++;
        sap = haveSapling();
        if (!sap) break;
      } catch (e) { /* next spot */ }
    }
    return planted ? null : 'couldnt plant saplings';
  }

  // Build a protective wall around the base: a perimeter at `radius` from the base, `height` tall,
  // with a doorway + a door. Gathers blocks as it goes. Slow + best-effort. Returns null when done.
  async function buildWall(radius = 6, height = 5) {
    const base = memory.getBase();
    if (!base) return 'no base';
    const cx = base.x; const cy = base.y; const cz = base.z;

    // perimeter cells, bottom-up, with a 2-tall doorway on the -z side at x = cx.
    const targets = [];
    for (let y = 0; y < height; y++) {
      for (let x = -radius; x <= radius; x++) {
        for (let z = -radius; z <= radius; z++) {
          if (Math.abs(x) !== radius && Math.abs(z) !== radius) continue; // perimeter only
          if (x === 0 && z === -radius && (y === 0 || y === 1)) continue; // doorway
          targets.push(new Vec3(cx + x, cy + y, cz + z));
        }
      }
    }

    say('walling off the base (this takes a while)');
    let placed = 0; let failed = 0; let gatherTries = 0;
    for (const pos of targets) {
      if (state.cancel) return null;
      if (!placeableItem(BUILD_BLOCKS)) {
        if (gatherTries++ > 25) break;
        await mineOre('stone', 16);
        if (!placeableItem(BUILD_BLOCKS)) await collect('dirt', 16);
        if (!placeableItem(BUILD_BLOCKS)) break; // can't get blocks here
      }
      const e = await placeBlockAt(pos);
      if (e) failed++; else placed++;
    }

    // a door in the doorway
    try {
      if (!bot.inventory.items().some((i) => i.name.endsWith('_door'))) {
        await ensureCraftingTable();
        await craftPlanksFromLogs();
        await craft('oak_door', 1);
      }
      await placeItemAt('oak_door', new Vec3(cx, cy, cz - radius));
    } catch (e) { /* no door, leave the gap */ }

    if (placed < Math.max(8, targets.length * 0.4)) {
      return `couldn't wall here (placed ${placed}/${targets.length}) — set the base on clear, flat ground`;
    }
    say(`base walled — ${placed} blocks${failed ? `, missed ${failed}` : ''}`);
    return null;
  }

  // Place a specific item (e.g. a chest) at a world position, pathing into reach first.
  async function placeItemAt(itemName, pos) {
    const have = () => bot.inventory.items().find((i) => i.name === itemName);
    if (!have()) return false;
    const existing = bot.blockAt(pos);
    if (existing && existing.boundingBox === 'block') return existing.name === itemName;
    try { await bot.pathfinder.goto(new goals.GoalPlaceBlock(pos.clone(), bot.world, { range: 4 })); } catch (e) { /* */ }
    try { bot.pathfinder.setGoal(null); } catch (e) { /* */ }
    for (const d of PLACE_DIRS) {
      const ref = bot.blockAt(pos.plus(d));
      if (ref && ref.boundingBox === 'block') {
        try {
          await bot.equip(have(), 'hand');
          await bot.lookAt(pos.offset(0.5, 0.5, 0.5), true);
          await bot.placeBlock(ref, new Vec3(-d.x, -d.y, -d.z));
          return true;
        } catch (e) { /* try next face */ }
      }
    }
    return false;
  }

  // Build the supply chest at base: gather wood -> craft a double chest -> place it beside the
  // base -> register it as the supply chest. (The first chest built is the default supply chest.)
  async function buildSupplyChest() {
    const base = memory.getBase();
    if (!base) return 'no base set';
    const countName = (n) => bot.inventory.items().filter((i) => i.name === n).reduce((a, b) => a + b.count, 0);

    if (countName('chest') < 2) {
      if (countLogs() < 2 && !bot.inventory.items().some((i) => i.name.endsWith('_planks'))) {
        const e = await collect('wood', 3);
        if (e) return e;
      }
      await craftPlanksFromLogs();
      await ensureCraftingTable();
      await craft('chest', 2 - countName('chest'));
    }
    if (countName('chest') < 1) return 'need wood to build the supply chest';

    try { await bot.pathfinder.goto(new goals.GoalNear(base.x, base.y, base.z, 2)); } catch (e) { /* */ }
    // Try a couple of spots beside the base for a double chest.
    for (const dir of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const p1 = new Vec3(base.x + dir[0], base.y, base.z + dir[1]);
      if (await placeItemAt('chest', p1)) {
        memory.setSupply(p1);
        const p2 = new Vec3(base.x + dir[0] * 2, base.y, base.z + dir[1] * 2);
        await placeItemAt('chest', p2); // second half -> double chest (best effort)
        return null;
      }
    }
    return 'couldn\'t place the supply chest';
  }

  // Adopt an existing supply chest if there is one nearby (signed "supply", or already holding
  // tools). Returns true if it set one as the supply chest. Use BEFORE building a new one.
  async function adoptSupplyChest() {
    if (memory.getSupply()) return true;
    const chests = scanChests(32);
    if (!chests.length) return false;
    // 1) a chest with a supply-ish sign
    let pick = chests.find((c) => /supply|tools|gear|items/.test(c.label));
    // 2) else a chest that already contains tools
    if (!pick) {
      for (const c of chests) {
        if (state.cancel) break;
        try {
          await bot.pathfinder.goto(new goals.GoalGetToBlock(c.pos.x, c.pos.y, c.pos.z));
          const chest = await bot.openContainer(bot.blockAt(c.pos));
          const hasTools = chest.containerItems().some((it) => /_(pickaxe|axe|sword|shovel|hoe)$/.test(it.name));
          try { chest.close(); } catch (e) { /* */ }
          if (hasTools) { pick = c; break; }
        } catch (e) { /* */ }
      }
    }
    if (!pick) return false;
    memory.setSupply(pick.pos);
    return true;
  }

  // A short summary of the gear/supplies the worker is carrying (for status).
  function gearSummary() {
    const mcData = require('minecraft-data')(bot.version);
    const counts = {};
    for (const it of bot.inventory.items()) {
      if (!isGear(it.name, mcData)) continue;
      counts[it.name] = (counts[it.name] || 0) + it.count;
    }
    const parts = Object.entries(counts).map(([n, c]) => `${c} ${n}`);
    return parts.length ? parts.join(', ') : 'none';
  }

  // ---- building -------------------------------------------------------------

  function placeableItem(preferred) {
    const items = bot.inventory.items();
    const mcData = require('minecraft-data')(bot.version);
    for (const name of preferred) {
      const it = items.find((i) => i.name === name);
      if (it) return it;
    }
    for (const it of items) {
      if (mcData.blocksByName[it.name]) return it; // any item that is also a placeable block
    }
    return null;
  }

  const PLACE_DIRS = [
    new Vec3(0, -1, 0), new Vec3(0, 1, 0), new Vec3(1, 0, 0),
    new Vec3(-1, 0, 0), new Vec3(0, 0, 1), new Vec3(0, 0, -1),
  ];

  // Place a block at an exact world position. KEY: pathfind into reach of the target first
  // (GoalPlaceBlock), then place against a solid neighbour. This is what makes building work.
  async function placeBlockAt(targetPos, preferred = BUILD_BLOCKS) {
    const existing = bot.blockAt(targetPos);
    if (existing && existing.boundingBox === 'block') return null; // already solid
    const item = placeableItem(preferred);
    if (!item) return 'no blocks to place';

    // Move somewhere we can actually reach this spot.
    try {
      await bot.pathfinder.goto(new goals.GoalPlaceBlock(targetPos.clone(), bot.world, { range: 4 }));
    } catch (e) {
      /* maybe already in range; fall through and try to place */
    }
    bot.pathfinder.setGoal(null);

    for (const d of PLACE_DIRS) {
      const ref = bot.blockAt(targetPos.plus(d));
      if (ref && ref.boundingBox === 'block') {
        try {
          await bot.equip(item, 'hand');
          await bot.lookAt(targetPos.offset(0.5, 0.5, 0.5), true);
          await bot.placeBlock(ref, new Vec3(-d.x, -d.y, -d.z)); // face points back to target
          return null;
        } catch (e) {
          /* try next neighbour */
        }
      }
    }
    return 'couldn\'t place there';
  }

  // Box the pal in with a quick 1x1 shelter (walls + roof) — emergency survival.
  async function shelter() {
    const base = bot.entity.position.floored();
    const cells = [
      [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1],
      [1, 1, 0], [-1, 1, 0], [0, 1, 1], [0, 1, -1],
      [0, 2, 0],
    ];
    let placed = 0;
    for (const c of cells) {
      const err = await placeBlockAt(base.offset(c[0], c[1], c[2]));
      if (!err) placed++;
    }
    return placed > 0 ? null : 'i have no blocks to build a shelter';
  }

  // Light up the area with a torch if the pal has any.
  async function torchArea() {
    const torch = bot.inventory.items().find((i) => i.name === 'torch');
    if (!torch) return "i don't have any torches";
    await bot.equip(torch, 'hand');
    const base = bot.entity.position.floored();
    for (const s of [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]]) {
      const ref = bot.blockAt(base.offset(s[0], -1, s[2]));
      if (ref && ref.boundingBox === 'block') {
        try {
          await bot.placeBlock(ref, new Vec3(0, 1, 0));
          return null;
        } catch (e) {
          /* try next spot */
        }
      }
    }
    return "couldn't place a torch here";
  }

  // Tower straight up N blocks (jump + place under self). Best-effort.
  async function pillarUp(height = 3) {
    const item = placeableItem(BUILD_BLOCKS);
    if (!item) return 'no blocks to pillar with';
    for (let i = 0; i < Math.min(height | 0 || 3, 16); i++) {
      try {
        await bot.equip(item, 'hand');
        bot.setControlState('jump', true);
        await new Promise((r) => setTimeout(r, 160));
        const ref = bot.blockAt(bot.entity.position.offset(0, -1, 0));
        await bot.placeBlock(ref, new Vec3(0, 1, 0));
      } catch (e) {
        /* keep trying the rest */
      } finally {
        bot.setControlState('jump', false);
      }
    }
    return null;
  }

  // Dispatcher so the LLM has one "build" action with a target.
  async function build(what) {
    const w = String(what || 'shelter').toLowerCase().trim();
    if (w.includes('torch') || w.includes('light')) return torchArea();
    if (w.includes('pillar') || w.includes('tower')) return pillarUp(4);
    return shelter();
  }

  // ---- multi-step task: get wood and craft a full set of wooden tools --------

  function countLogs() {
    return bot.inventory.items().filter((i) => LOG_TO_PLANK[i.name]).reduce((a, b) => a + b.count, 0);
  }

  async function craftPlanksFromLogs() {
    const logs = bot.inventory.items().filter((i) => LOG_TO_PLANK[i.name]);
    for (const l of logs) {
      await craft(LOG_TO_PLANK[l.name], l.count);
    }
  }

  // Use a crafting table within reach if one exists; only craft + place a NEW one if there's
  // none nearby (stops the "too many crafting tables" spam — reuses the base table).
  async function ensureCraftingTable() {
    const mcData = require('minecraft-data')(bot.version);
    const tableId = mcData.blocksByName.crafting_table.id;
    if (bot.findBlock({ matching: tableId, maxDistance: 32 })) return null; // reuse existing
    if (!bot.inventory.items().some((i) => i.name === 'crafting_table')) {
      const e = await craft('crafting_table', 1);
      if (e) return e;
    }
    return placeCraftingTable();
  }

  async function placeCraftingTable() {
    const item = bot.inventory.items().find((i) => i.name === 'crafting_table');
    if (!item) return "couldn't make a crafting table";
    await bot.equip(item, 'hand');
    const base = bot.entity.position.floored();
    for (const s of [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]]) {
      const ref = bot.blockAt(base.offset(s[0], -1, s[2]));
      const target = bot.blockAt(base.offset(s[0], 0, s[2]));
      if (ref && ref.boundingBox === 'block' && target && target.boundingBox === 'empty') {
        try {
          await bot.placeBlock(ref, new Vec3(0, 1, 0));
          return null;
        } catch (e) {
          /* try next spot */
        }
      }
    }
    return "couldn't find a spot for the crafting table";
  }

  async function getTools() {
    if (countLogs() < 3) {
      say('grabbing some wood first');
      const err = await collect('wood', 3 - countLogs());
      if (err) return err;
    }
    if (state.cancel) return null;
    say('crafting planks + a table');
    await craftPlanksFromLogs();
    const tableErr = await ensureCraftingTable();
    if (tableErr) return tableErr;
    await craft('stick', 1);
    await craftPlanksFromLogs(); // top up planks for the tools

    const made = [];
    for (const tool of ['wooden_pickaxe', 'wooden_axe', 'wooden_sword']) {
      const err = await craft(tool, 1);
      if (!err) made.push(tool.replace('wooden_', ''));
    }
    if (!made.length) return "got the wood but ran short on planks/sticks for the tools";
    say(`made: ${made.join(', ')}`);
    return null;
  }

  // ---- ranged combat, mining, survival --------------------------------------

  // Shoot the nearest hostile with a bow (falls back to melee if no bow/arrows).
  async function rangedAttackNearest() {
    const target = bot.nearestEntity((e) => e.type === 'mob' && HOSTILES.has(e.name));
    if (!target) return 'nothing to shoot at';
    const bow = bot.inventory.items().find((i) => i.name === 'bow');
    const arrows = bot.inventory.items().find((i) => i.name === 'arrow');
    if (!bow || !arrows) {
      equipBestWeapon();
      bot.pvp.attack(target);
      return null;
    }
    try {
      await bot.equip(bow, 'hand');
      const aim = () => bot.lookAt(target.position.offset(0, (target.height || 1.6) * 0.5, 0), true);
      await aim();
      bot.activateItem(); // draw the bow
      await new Promise((r) => setTimeout(r, 1100));
      await aim();
      bot.deactivateItem(); // release
    } catch (e) {
      /* shot interrupted */
    }
    return null;
  }

  async function ensurePickaxe() {
    const pick = bot.inventory.items().find((i) => i.name.endsWith('_pickaxe'));
    if (pick) {
      try { await bot.equip(pick, 'hand'); } catch (e) { /* ignore */ }
      return true;
    }
    return false;
  }

  function forwardCardinal() {
    const yaw = bot.entity.yaw;
    let dx = Math.round(-Math.sin(yaw));
    let dz = Math.round(-Math.cos(yaw));
    if (dx === 0 && dz === 0) dx = 1; // facing a diagonal — pick one axis
    return { dx, dz };
  }

  // Dig a 1x2 corridor straight ahead, advancing one block at a time.
  async function tunnelForward(steps = 8) {
    const { dx, dz } = forwardCardinal();
    for (let i = 0; i < steps; i++) {
      if (state.cancel) return; // interrupted by a command
      const base = bot.entity.position.floored();
      for (const dy of [0, 1]) {
        const b = bot.blockAt(base.offset(dx, dy, dz));
        if (b && b.boundingBox === 'block' && b.name !== 'bedrock') {
          try { if (bot.canDigBlock(b)) await bot.dig(b); } catch (e) { /* skip */ }
        }
      }
      try {
        await bot.pathfinder.goto(new goals.GoalNear(base.x + dx, base.y, base.z + dz, 0));
      } catch (e) {
        break;
      }
    }
  }

  // Mine a target ore: grab it if it's in range, otherwise tunnel to expose more ground.
  async function mineOre(oreName, count = 1) {
    if (!(await ensurePickaxe())) {
      say('no pickaxe yet, making one first');
      const e = await getTools(); // make a wooden pickaxe first
      if (!(await ensurePickaxe())) return e || "i couldn't make a pickaxe (need trees/wood nearby)";
    }
    const mcData = require('minecraft-data')(bot.version);
    const ids = resolveBlockNames(oreName)
      .map((n) => mcData.blocksByName[n] && mcData.blocksByName[n].id)
      .filter((x) => x != null);
    if (!ids.length) return `i don't know the ore "${oreName}"`;

    const want = Math.max(1, Math.min(count | 0 || 1, 16));
    say(`mining ${want} ${oreName}`);
    let got = 0;
    for (let cycle = 0; cycle < 14 && got < want; cycle++) {
      if (state.cancel) return null; // interrupted by a command
      const r = await gatherOne(ids, oreName, 48);
      if (r === 'ok') { got++; continue; }
      if (r === 'cancel') return null;
      if (r === 'cantbreak') return `i can't break ${oreName} — i need a better pickaxe`;
      await tunnelForward(6); // none in view / blocked -> expose more ground
    }
    if (!got) return `couldn't reach any ${oreName} (tried tunnelling)`;
    return null;
  }

  // Retreat when badly hurt: stop fighting, run to the owner, or flee from the threat.
  function panicTick() {
    if (bot.health > 6) {
      if (state.panicking) {
        state.panicking = false;
        if (state.mode === 'follow') followOwner();
      }
      return;
    }
    if (!state.panicking) {
      state.panicking = true;
      say('im low, falling back!');
    }
    if (bot.pvp && bot.pvp.target) bot.pvp.stop();

    const owner = findOwner();
    if (owner) {
      bot.pathfinder.setGoal(new goals.GoalFollow(owner, 2), true);
      return;
    }
    const threat = bot.nearestEntity((e) => e.type === 'mob' && HOSTILES.has(e.name));
    if (threat && bot.entity.position.distanceTo(threat.position) < 16) {
      const away = bot.entity.position.minus(threat.position);
      if (away.norm() > 0.1) {
        const dest = bot.entity.position.plus(away.normalize().scaled(8));
        bot.pathfinder.setGoal(new goals.GoalNear(dest.x, dest.y, dest.z, 1));
      }
    }
  }

  // ---- foraging, housing, exploring, teleport -------------------------------

  const PREY = new Set(['cow', 'pig', 'chicken', 'sheep', 'rabbit', 'mooshroom']);

  function isNight() {
    const t = (bot.time && bot.time.timeOfDay) || 0;
    return t > 13000 && t < 23000;
  }

  // Hunt the nearest passive animal for food, then step onto the drops.
  async function hunt() {
    const prey = bot.nearestEntity(
      (e) => PREY.has(e.name) && e.position && e.position.distanceTo(bot.entity.position) < 32
    );
    if (!prey) return 'no animals around to hunt';
    const at = prey.position.clone();
    equipBestWeapon();
    bot.pvp.attack(prey);
    for (let i = 0; i < 40 && prey.isValid; i++) await new Promise((r) => setTimeout(r, 300));
    if (bot.pvp) bot.pvp.stop();
    try { await bot.pathfinder.goto(new goals.GoalNear(at.x, at.y, at.z, 0)); } catch (e) { /* drop pickup */ }
    return null;
  }

  // Build a small enclosed house (5x5, 3 high, doorway + roof + a torch). Built a few blocks
  // IN FRONT of the pal so it doesn't wall itself in, bottom-up so each layer has support.
  async function buildHouse() {
    const names = ['cobblestone', 'dirt', 'stone', 'andesite', 'diorite', 'granite', 'cobbled_deepslate'];
    const have = () => bot.inventory.items().filter((i) => names.includes(i.name)).reduce((a, b) => a + b.count, 0);

    // Gather materials over a few rounds (bail if there's nothing to gather here).
    let tries = 0;
    while (have() < 70 && tries < 6) {
      if (state.cancel) return null;
      const before = have();
      say('gathering blocks for a house');
      await mineOre('stone', 16);
      if (have() < 70) await collect('dirt', 16);
      if (have() === before) break;
      tries++;
    }
    if (have() < 16) return "couldn't get blocks for a house (need stone/dirt nearby)";

    say('building us a house, stand back');
    const { dx, dz } = forwardCardinal();
    const c = bot.entity.position.floored().offset(dx * 3, 0, dz * 3);
    const r = 2;
    const h = 3;

    // Collect target positions: walls bottom-up (with a doorway), then the roof.
    const targets = [];
    for (let y = 0; y < h; y++) {
      for (let x = -r; x <= r; x++) {
        for (let z = -r; z <= r; z++) {
          if (Math.abs(x) !== r && Math.abs(z) !== r) continue; // perimeter walls only
          if (z === -r && x === 0 && (y === 0 || y === 1)) continue; // doorway
          targets.push(c.offset(x, y, z));
        }
      }
    }
    for (let x = -r; x <= r; x++) for (let z = -r; z <= r; z++) targets.push(c.offset(x, h, z)); // roof

    let placed = 0;
    let failed = 0;
    for (const pos of targets) {
      if (state.cancel) return null;
      if (!placeableItem(BUILD_BLOCKS)) { failed++; continue; } // out of blocks
      const err = await placeBlockAt(pos);
      if (err) failed++; else placed++;
    }

    // a torch inside for light
    try {
      const torch = bot.inventory.items().find((i) => i.name === 'torch');
      if (torch) {
        await bot.equip(torch, 'hand');
        const ref = bot.blockAt(c.offset(0, -1, 0));
        if (ref && ref.boundingBox === 'block') await bot.placeBlock(ref, new Vec3(0, 1, 0));
      }
    } catch (e) { /* no torch yet */ }

    say(`house done — placed ${placed} blocks${failed ? `, couldn't reach ${failed}` : ''}`);
    return null;
  }

  // Travel in the direction the OWNER is facing (in ~20-block hops) to look for trees.
  // mineflayer can't path 1000 blocks at once, so we hop + scan; stops when trees are in range.
  async function scout() {
    const owner = findOwner();
    const yaw = owner ? owner.yaw : bot.entity.yaw;
    const dx = -Math.sin(yaw);
    const dz = -Math.cos(yaw);
    const mcData = require('minecraft-data')(bot.version);
    const logIds = resolveBlockNames('wood')
      .map((n) => mcData.blocksByName[n] && mcData.blocksByName[n].id)
      .filter((x) => x != null);

    for (let step = 0; step < 12; step++) {
      if (state.cancel) return null;
      if (bot.findBlock({ matching: logIds, maxDistance: 64 })) {
        say('found trees! chopping now');
        return null; // autonomy / a follow-up will harvest
      }
      const p = bot.entity.position;
      const tx = Math.round(p.x + dx * 20);
      const tz = Math.round(p.z + dz * 20);
      try {
        await bot.pathfinder.goto(new goals.GoalNearXZ(tx, tz, 3));
      } catch (e) {
        break; // blocked / unreachable
      }
    }
    return "walked a good way but no forest in this direction — point me again or tp me";
  }

  // Wander to a random nearby spot to explore / search for resources.
  async function wander(distance = 18) {
    const p = bot.entity.position;
    const ang = Math.random() * Math.PI * 2;
    const dx = Math.round(Math.cos(ang) * distance);
    const dz = Math.round(Math.sin(ang) * distance);
    try { await bot.pathfinder.goto(new goals.GoalNear(p.x + dx, p.y, p.z + dz, 2)); } catch (e) { /* blocked */ }
    return null;
  }

  // Teleport via server command (needs the world's cheats on + the pal /op'd).
  function tpToOwner() {
    bot.chat(`/tp ${bot.username} ${config.owner}`);
    return null;
  }
  function tpOwnerHere() {
    bot.chat(`/tp ${config.owner} ${bot.username}`);
    return null;
  }

  return {
    findOwner,
    inventorySummary,
    perceive,
    setMovements,
    followOwner,
    stop,
    come,
    collect,
    gotoCoord,
    attackNearest,
    equipBestWeapon,
    defendTick,
    doorTick,
    eatTick,
    craft,
    giveToOwner,
    placeBlockAt,
    shelter,
    torchArea,
    pillarUp,
    build,
    getTools,
    rangedAttackNearest,
    mineOre,
    tunnelForward,
    panicTick,
    isNight,
    hunt,
    buildHouse,
    scout,
    wander,
    drop,
    depositToChest,
    depositLoot,
    depositLabeled,
    depositIntoChestAt,
    chestBlockNear,
    restockFromSupply,
    supplyCounts,
    stockSupply,
    makeToolset,
    withdrawFromBase,
    placeItemAt,
    buildSupplyChest,
    adoptSupplyChest,
    buildWall,
    ensureTool,
    plantTrees,
    gearSummary,
    scanChests,
    tpTo,
    farm,
    tpToOwner,
    tpOwnerHere,
    HOSTILES,
  };
}

module.exports = { makeSkills, HOSTILES, resolveBlockNames };
