'use strict';
// Autonomy: the pal plays the game by itself, following the standard Minecraft beginner
// survival ladder (minecraft.net "tips for beginners"):
//   wood -> tools -> stone + stone tools -> food -> a house before night -> torches/coal -> iron
// Each call to step() advances ONE goal (the highest-priority thing not yet satisfied), so the
// owner is free to go play independently. Survival reflexes (eat, defend, flee) run separately.

function makeAutonomy(bot, skills, state, memory) {
  const inv = () => bot.inventory.items();
  const countName = (n) => inv().filter((i) => i.name === n).reduce((a, b) => a + b.count, 0);
  const countSuffix = (s) => inv().filter((i) => i.name.endsWith(s)).reduce((a, b) => a + b.count, 0);
  const hasSuffix = (s) => inv().some((i) => i.name.endsWith(s));
  const countAny = (names) => inv().filter((i) => names.includes(i.name)).reduce((a, b) => a + b.count, 0);

  // Advance one rung of the survival ladder. Returns a short label of what it's doing.
  async function step() {
    const logs = countSuffix('_log');
    const planks = countSuffix('_planks');
    const hasPick = hasSuffix('_pickaxe');
    const cobble = countName('cobblestone');
    const hasStonePick = inv().some((i) => i.name === 'stone_pickaxe');
    const torches = countName('torch');
    const coal = countName('coal');
    const iron = countAny(['iron_ingot', 'raw_iron']);
    const hasFood = inv().some((i) => {
      const mcData = require('minecraft-data')(bot.version);
      return mcData.foodsByName[i.name];
    });
    const home = memory.getHome();

    // 1) wood
    if (logs < 3 && planks < 4 && !hasPick) {
      await skills.collect('wood', 4);
      return 'chopping wood';
    }
    // 2) basic wooden tools
    if (!hasPick) {
      await skills.getTools();
      return 'crafting tools';
    }
    // 3) stone, then stone tools
    if (cobble < 12) {
      await skills.mineOre('stone', 12);
      return 'mining stone';
    }
    if (!hasStonePick && cobble >= 3) {
      await skills.craft('stone_pickaxe', 1);
      await skills.craft('stone_sword', 1);
      await skills.craft('stone_axe', 1);
      return 'upgrading to stone tools';
    }
    // 4) food
    if (bot.food < 15 && !hasFood) {
      await skills.hunt();
      return 'hunting for food';
    }
    // 5) a house (do it before night ideally; build once, remember it as home)
    if (!home) {
      const err = await skills.buildHouse();
      if (!err) memory.setHome(bot.entity.position);
      return 'building a house';
    }
    // 6) torches (mine coal first if needed)
    if (torches < 4) {
      if (coal < 2) {
        await skills.mineOre('coal', 3);
        return 'mining coal';
      }
      await skills.craft('torch', 4);
      return 'making torches';
    }
    // 7) iron
    if (iron < 3) {
      await skills.mineOre('iron', 3);
      return 'mining iron';
    }
    // 8) settled: light up at night near home, otherwise explore
    if (skills.isNight()) {
      await skills.build('torch');
      return 'lighting up the area';
    }
    await skills.wander();
    return 'exploring';
  }

  return { step };
}

module.exports = { makeAutonomy };
