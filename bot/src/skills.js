'use strict';
// Action primitives the pal can perform in the world: movement, combat, mining.
// Everything here drives the live mineflayer bot. State (mode, autoDefend) is shared
// with index.js so the chat handler and the defense loop see the same flags.

const { goals, Movements } = require('mineflayer-pathfinder');
const { Vec3 } = require('vec3');

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
    const m = new Movements(bot);
    m.allowSprinting = true;
    m.canDig = true;
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

  async function collect(blockName, count = 1) {
    const mcData = require('minecraft-data')(bot.version);
    const ids = resolveBlockNames(blockName)
      .map((n) => mcData.blocksByName[n] && mcData.blocksByName[n].id)
      .filter((x) => x != null);
    if (!ids.length) return `i don't know how to collect "${blockName}"`;

    const want = Math.max(1, Math.min(count | 0 || 1, 16));
    let got = 0;
    for (let i = 0; i < want; i++) {
      const block = bot.findBlock({ matching: ids, maxDistance: 64 });
      if (!block) break;
      try {
        await bot.collectBlock.collect(block);
        got++;
      } catch (e) {
        break;
      }
    }
    if (got === 0) return `couldn't find any ${blockName} nearby`;
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
    if (!state.autoDefend) return;
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

  // Auto-eat when hungry so the pal doesn't starve (and natural regen keeps health up).
  async function eatTick() {
    if (eating || bot.food >= 18) return;
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

  // Place a block at an exact world position, finding a solid neighbour to place against.
  async function placeBlockAt(targetPos, preferred = BUILD_BLOCKS) {
    const existing = bot.blockAt(targetPos);
    if (existing && existing.boundingBox === 'block') return null; // already solid
    const item = placeableItem(preferred);
    if (!item) return 'no blocks to place';
    try {
      await bot.equip(item, 'hand');
    } catch (e) {
      return 'couldn\'t hold a block';
    }
    const dirs = [
      new Vec3(0, -1, 0), new Vec3(0, 1, 0), new Vec3(1, 0, 0),
      new Vec3(-1, 0, 0), new Vec3(0, 0, 1), new Vec3(0, 0, -1),
    ];
    for (const d of dirs) {
      const refPos = targetPos.plus(d);
      const ref = bot.blockAt(refPos);
      if (ref && ref.boundingBox === 'block') {
        try {
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
      bot.chat('grabbing some wood first');
      const err = await collect('wood', 3 - countLogs());
      if (err) return err;
    }
    bot.chat('crafting planks + a table');
    await craftPlanksFromLogs();
    await craft('crafting_table', 1);
    const tableErr = await placeCraftingTable();
    if (tableErr) return tableErr;
    await craft('stick', 1);
    await craftPlanksFromLogs(); // top up planks for the tools

    const made = [];
    for (const tool of ['wooden_pickaxe', 'wooden_axe', 'wooden_sword']) {
      const err = await craft(tool, 1);
      if (!err) made.push(tool.replace('wooden_', ''));
    }
    if (!made.length) return "got the wood but ran short on planks/sticks for the tools";
    bot.chat(`made: ${made.join(', ')}`);
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
    eatTick,
    craft,
    giveToOwner,
    placeBlockAt,
    shelter,
    torchArea,
    pillarUp,
    build,
    getTools,
    HOSTILES,
  };
}

module.exports = { makeSkills, HOSTILES, resolveBlockNames };
