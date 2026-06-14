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

  // Gear the worker should NEVER deposit on a loot run (so it can keep working).
  function isGear(name, mcData) {
    if (/_(pickaxe|axe|sword|shovel|hoe)$/.test(name)) return true;
    if (['bucket', 'water_bucket', 'lava_bucket', 'bow', 'crossbow', 'arrow', 'shield',
      'flint_and_steel', 'torch', 'crafting_table', 'furnace', 'shears'].includes(name)) return true;
    if (mcData.foodsByName && mcData.foodsByName[name]) return true;
    return false;
  }

  // Teleport to a coordinate via server command (needs cheats + the worker /op'd).
  function tpTo(x, y, z) {
    bot.chat(`/tp ${bot.username} ${Math.round(x)} ${Math.round(y)} ${Math.round(z)}`);
    return null;
  }

  // Dump LOOT into the nearest chest but keep tools/weapons/food so the worker can keep going.
  async function depositLoot() {
    const mcData = require('minecraft-data')(bot.version);
    const chestIds = ['chest', 'trapped_chest', 'barrel']
      .map((n) => mcData.blocksByName[n] && mcData.blocksByName[n].id)
      .filter((x) => x != null);
    const chestBlock = bot.findBlock({ matching: chestIds, maxDistance: 16 });
    if (!chestBlock) return 'no chest at base';
    try {
      await bot.pathfinder.goto(new goals.GoalGetToBlock(chestBlock.position.x, chestBlock.position.y, chestBlock.position.z));
    } catch (e) { /* try anyway */ }
    let chest;
    try { chest = await bot.openContainer(chestBlock); } catch (e) { return "couldn't open base chest"; }
    for (const it of bot.inventory.items()) {
      if (isGear(it.name, mcData)) continue;
      try { await chest.deposit(it.type, null, it.count); } catch (e) { /* full/mismatch */ }
    }
    try { chest.close(); } catch (e) { /* */ }
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
  async function depositLabeled() {
    const mcData = require('minecraft-data')(bot.version);
    const chests = scanChests(24);
    if (!chests.length) return 'no chests at base';
    const supply = chests.find((c) => /supply|tools|gear|items/.test(c.label));
    const drops = chests.filter((c) => c !== supply);
    if (!drops.length) return 'no deposit chest at base';

    const isGeneric = (c) => !c.label || /deposit|loot|drop|store|misc|junk/.test(c.label);
    const lootLeft = () => bot.inventory.items().filter((it) => !isGear(it.name, mcData));
    // resource-labeled chests first, then generic, then unlabeled.
    const ordered = [
      ...drops.filter((c) => c.label && !isGeneric(c)),
      ...drops.filter((c) => isGeneric(c) && c.label),
      ...drops.filter((c) => !c.label),
    ];

    // Pass 1: put each resource in its matching chest; generic chests accept anything.
    for (const c of ordered) {
      if (state.cancel || !lootLeft().length) break;
      try {
        await bot.pathfinder.goto(new goals.GoalGetToBlock(c.pos.x, c.pos.y, c.pos.z));
        const chest = await bot.openContainer(bot.blockAt(c.pos));
        for (const it of bot.inventory.items()) {
          if (isGear(it.name, mcData)) continue;
          const res = resourceOf(it.name);
          const wrongLabel = c.label && !isGeneric(c) && !(c.label.includes(res) || res.includes(c.label));
          if (wrongLabel) continue; // don't put wood in the "iron" chest on the first pass
          try { await chest.deposit(it.type, null, it.count); } catch (e) { /* full / no fit */ }
        }
        try { chest.close(); } catch (e) { /* */ }
      } catch (e) { /* */ }
    }

    // Pass 2 (overflow): anything still on us goes into ANY chest with space, labels ignored.
    if (lootLeft().length) {
      for (const c of ordered) {
        if (state.cancel || !lootLeft().length) break;
        try {
          await bot.pathfinder.goto(new goals.GoalGetToBlock(c.pos.x, c.pos.y, c.pos.z));
          const chest = await bot.openContainer(bot.blockAt(c.pos));
          for (const it of bot.inventory.items()) {
            if (isGear(it.name, mcData)) continue;
            try { await chest.deposit(it.type, null, it.count); } catch (e) { /* */ }
          }
          try { chest.close(); } catch (e) { /* */ }
        } catch (e) { /* */ }
      }
    }
    return null;
  }

  // Withdraw missing tools (and a little food/torches) from the supply chest (sign: supply/tools).
  async function restockFromSupply() {
    const chests = scanChests(24);
    const supply = chests.find((c) => /supply|tools|gear|items/.test(c.label));
    if (!supply) return false;
    const mcData = require('minecraft-data')(bot.version);
    const lacksTool = (kind) => !bot.inventory.items().some((i) => i.name.endsWith(`_${kind}`));
    try {
      await bot.pathfinder.goto(new goals.GoalGetToBlock(supply.pos.x, supply.pos.y, supply.pos.z));
      const chest = await bot.openContainer(bot.blockAt(supply.pos));
      for (const item of chest.containerItems()) {
        const toolKind = (item.name.match(/_(pickaxe|axe|sword|shovel|hoe)$/) || [])[1];
        const isFood = mcData.foodsByName && mcData.foodsByName[item.name];
        if (toolKind && lacksTool(toolKind)) {
          try { await chest.withdraw(item.type, null, 1); } catch (e) { /* */ }
        } else if (isFood && bot.food < 16) {
          try { await chest.withdraw(item.type, null, Math.min(8, item.count)); } catch (e) { /* */ }
        } else if (item.name === 'torch' && !bot.inventory.items().some((i) => i.name === 'torch')) {
          try { await chest.withdraw(item.type, null, Math.min(16, item.count)); } catch (e) { /* */ }
        }
      }
      try { chest.close(); } catch (e) { /* */ }
    } catch (e) { return false; }
    return true;
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
    restockFromSupply,
    scanChests,
    tpTo,
    farm,
    tpToOwner,
    tpOwnerHere,
    HOSTILES,
  };
}

module.exports = { makeSkills, HOSTILES, resolveBlockNames };
