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

  // Throttled chat — suppresses the SAME line if repeated within 30s (kills autonomy spam).
  function say(msg) {
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

  // Find one matching block, path right up to it, equip the right tool, and dig it.
  // Returns 'ok' | 'none' (nothing in view) | 'cantbreak' (wrong tool) | 'fail' (path/dig error).
  async function digNearest(ids, label, maxDistance = 64) {
    const block = bot.findBlock({ matching: ids, maxDistance });
    if (!block) return 'none';
    // Up to 2 attempts — "Digging aborted" / "goal changed" are usually transient interrupts.
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await bot.pathfinder.goto(new goals.GoalGetToBlock(block.position.x, block.position.y, block.position.z));
        bot.pathfinder.setGoal(null); // stop moving so the dig isn't aborted by residual pathing
        await equipForBlock(block);
        if (!bot.canDigBlock(block)) return 'cantbreak';
        await bot.dig(block);
        try {
          await bot.pathfinder.goto(new goals.GoalNear(block.position.x, block.position.y, block.position.z, 0));
        } catch (e) { /* scoop the drop */ }
        return 'ok';
      } catch (e) {
        const transient = /aborted|goal was changed|changed before/i.test(e.message || '');
        if (transient && attempt === 0) continue; // retry once
        logOnce(`[Ninja Pal] dig fail (${label}): ${e.message}`);
        return 'fail';
      }
    }
    return 'fail';
  }

  async function collect(blockName, count = 1) {
    const mcData = require('minecraft-data')(bot.version);
    const ids = resolveBlockNames(blockName)
      .map((n) => mcData.blocksByName[n] && mcData.blocksByName[n].id)
      .filter((x) => x != null);
    if (!ids.length) return `i don't know how to collect "${blockName}"`;
    const want = Math.max(1, Math.min(count | 0 || 1, 16));
    say(`getting  `);
    let got = 0;
    let miss = 0;
    while (got < want && miss < 3) {
      const r = await digNearest(ids, blockName);
      if (r === 'ok') { got++; continue; }
      if (r === 'cantbreak') return `i can't break ${blockName} with my tools`;
      miss++;
    }
    return got > 0 ? null : `couldn't find any ${blockName} nearby`;
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
      say('grabbing some wood first');
      const err = await collect('wood', 3 - countLogs());
      if (err) return err;
    }
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
    say(`made: `);
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
    say(`mining  `);
    let got = 0;
    for (let cycle = 0; cycle < 14 && got < want; cycle++) {
      const r = await digNearest(ids, oreName, 48);
      if (r === 'ok') { got++; continue; }
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

  // Build a small enclosed house (5x5, 3 high, doorway + roof + a torch inside).
  async function buildHouse() {
    const names = ['cobblestone', 'dirt', 'stone', 'andesite', 'diorite', 'granite', 'cobbled_deepslate'];
    const have = () => bot.inventory.items().filter((i) => names.includes(i.name)).reduce((a, b) => a + b.count, 0);
    if (have() < 50) {
      say('gathering blocks for a house');
      await mineOre('stone', 16);
      if (have() < 40) await collect('dirt', 16);
    }
    if (have() < 20) return "couldn't get enough blocks for a house";

    say('building us a house');
    const c = bot.entity.position.floored();
    const r = 2;
    const h = 3;
    for (let y = 0; y < h; y++) {
      for (let x = -r; x <= r; x++) {
        for (let z = -r; z <= r; z++) {
          if (Math.abs(x) !== r && Math.abs(z) !== r) continue; // perimeter walls only
          if (z === -r && x === 0 && (y === 0 || y === 1)) continue; // leave a doorway
          await placeBlockAt(c.offset(x, y, z));
        }
      }
    }
    for (let x = -r; x <= r; x++) {
      for (let z = -r; z <= r; z++) {
        await placeBlockAt(c.offset(x, h, z)); // roof
      }
    }
    try {
      const torch = bot.inventory.items().find((i) => i.name === 'torch');
      if (torch) {
        await bot.equip(torch, 'hand');
        const ref = bot.blockAt(c.offset(1, -1, 1));
        if (ref && ref.boundingBox === 'block') await bot.placeBlock(ref, new Vec3(0, 1, 0));
      }
    } catch (e) { /* no torch yet */ }
    return null;
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
    wander,
    tpToOwner,
    tpOwnerHere,
    HOSTILES,
  };
}

module.exports = { makeSkills, HOSTILES, resolveBlockNames };
