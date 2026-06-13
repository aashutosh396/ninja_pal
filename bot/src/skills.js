'use strict';
// Action primitives the pal can perform in the world: movement, combat, mining.
// Everything here drives the live mineflayer bot. State (mode, autoDefend) is shared
// with index.js so the chat handler and the defense loop see the same flags.

const { goals, Movements } = require('mineflayer-pathfinder');

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

  return {
    findOwner,
    inventorySummary,
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
    HOSTILES,
  };
}

module.exports = { makeSkills, HOSTILES, resolveBlockNames };
