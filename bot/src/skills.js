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

function makeSkills(bot, config, state) {
  function findOwner() {
    return (bot.players[config.owner] && bot.players[config.owner].entity) || null;
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
    if (target && !bot.pvp.target) bot.pvp.attack(target);
  }

  return {
    findOwner,
    setMovements,
    followOwner,
    stop,
    come,
    collect,
    gotoCoord,
    attackNearest,
    defendTick,
    HOSTILES,
  };
}

module.exports = { makeSkills, HOSTILES, resolveBlockNames };
