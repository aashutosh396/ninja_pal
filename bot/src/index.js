'use strict';
// Ninja Pal — crew manager. Spawns one or more named worker bots (each in src/worker.js),
// persists the crew in ../workers.json, and routes the owner's chat to the right worker(s).
//
// Owner commands (type in normal chat, NO leading slash):
//   worker create <name> <job…>   spawn a worker that does <job> on repeat (or a preset role)
//   worker list                   show the crew + their jobs
//   worker roles                  list the preset roles
//   worker remove <name>          dismiss a worker
//   <name> <command>              command one worker (e.g. "Bob come", "Bob deposit dirt")
//   all <command>                 command the whole crew (e.g. "all follow me")
//   <command>                     goes to the first worker

const fs = require('fs');
const path = require('path');
const { createWorker } = require('./worker');
const { rolesList, isPreset } = require('./roles');
const memory = require('./memory');

const cfgPath = path.join(__dirname, '..', 'config.json');
if (!fs.existsSync(cfgPath)) {
  console.error('[Ninja Pal] No config.json found.');
  console.error('  cp config.example.json config.json   then edit "owner" + "port".');
  process.exit(1);
}
const config = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
const MAX = config.maxWorkers || 5;
// Per-game crew file: workers-<game>.json (from config.game). Without a manual game name it
// becomes workers-w<world>.json once the world is detected (see onWorldKnown).
const GAME_TAG = config.game ? '-' + String(config.game).replace(/[^a-z0-9_-]/gi, '') : '';
let WORKERS_FILE = path.join(__dirname, '..', `workers${GAME_TAG}.json`);

let defs = loadDefs();
const workers = new Map(); // lowercased name -> worker handle (insertion order = spawn order)

function loadDefs() {
  try {
    const d = JSON.parse(fs.readFileSync(WORKERS_FILE, 'utf8'));
    return Array.isArray(d) ? d : [];
  } catch (e) {
    return [];
  }
}
function saveDefs() {
  try { fs.writeFileSync(WORKERS_FILE, JSON.stringify(defs, null, 2)); } catch (e) { /* */ }
}

let worldSet = false;
const manager = {
  onChat,
  onWhisper,
  persist: () => saveDefs(),
  tellAll: (cmd) => { for (const w of workers.values()) w.handle(cmd); },
  // First worker to spawn reports the world spawn point -> key BOTH memory and the crew file to
  // this world, then load + spawn this world's saved crew.
  onWorldKnown: (sp) => {
    if (worldSet || !sp) return;
    worldSet = true;
    const id = `${Math.round(sp.x)}_${Math.round(sp.z)}`;
    memory.setWorld(id);
    if (!GAME_TAG) WORKERS_FILE = path.join(__dirname, '..', `workers-w${id}.json`);
    console.log(`[Crew] world ${id} -> memory-w${id}.json / ${path.basename(WORKERS_FILE)}`);
    defs = loadDefs();
    if (!defs.some((d) => d.name.toLowerCase() === 'tool_guy')) defs.push({ name: 'tool_guy', role: 'logistics' });
    saveDefs();
    for (const d of defs.slice(0, MAX)) {
      if (!workers.has(d.name.toLowerCase())) spawnWorker(d);
    }
  },
};

function spawnWorker(def) {
  workers.set(def.name.toLowerCase(), createWorker(config, def, manager));
}

function primary() {
  return workers.values().next().value || null;
}
function say(msg) {
  const p = primary();
  if (p) p.say(msg);
}

// All worker bots receive the same chat — process each message only once.
const seen = new Map();
function isDup(u, m) {
  const k = `${u}|${m}`;
  const now = Date.now();
  const last = seen.get(k) || 0;
  seen.set(k, now);
  if (seen.size > 200) seen.clear();
  return now - last < 1200;
}

// Route a command. `fallback` is the worker that gets a bare (unaddressed) command — the first
// worker for public chat, or the whispered-to worker for a /msg.
function route(m, fallback) {
  const lm = m.toLowerCase();
  let mm;

  // --- crew management (multi-line output for readability) ---
  if (/^worker\s+roles\b/.test(lm) || /^roles$/.test(lm)) {
    say('roles:');
    for (const r of rolesList()) say(`- ${r}`);
    return;
  }
  if (/^worker\s+list\b/.test(lm) || /^crew$/.test(lm)) {
    say(`crew (${workers.size}/${MAX}):`);
    if (!workers.size) say('- (empty) — worker create <name> <job>');
    for (const w of workers.values()) {
      const job = w.def.role || w.def.job || 'idle';
      const chest = w.def.chest ? ` @ chest ${w.def.chest.x},${w.def.chest.y},${w.def.chest.z}` : '';
      say(`- ${w.name}: ${job}${chest}`);
    }
    return;
  }
  if ((mm = lm.match(/^worker\s+remove\s+(\S+)/))) { removeWorker(mm[1]); return; }
  if ((mm = m.match(/^worker\s+create\s+(\S+)\s+(.+)/i))) { createWorkerCmd(mm[1], mm[2]); return; }
  if (/^(worker|help|commands)\b/.test(lm)) {
    say('commands:');
    say('- worker create <name> <job>   (job = free text or a role)');
    say('- worker list | worker roles | worker remove <name>');
    say('- set base | set supply | set spawn | set op <name>');
    say('- <name> <cmd>  |  all <cmd>  |  /msg <name> <cmd>');
    say('- per worker: come/stop/follow/deposit/restock/this is your chest/clear chest/status');
    say('- crew: "supplies are ready" | "everyone come deposit"');
    return;
  }

  // --- base / spawn / op ---
  if ((mm = m.match(/^new game\s+(\S+)/i))) {
    const g = mm[1].replace(/[^a-z0-9_-]/gi, '');
    try {
      const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
      cfg.game = g;
      fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + '\n');
      say(`new game "${g}" set — restart me (Ctrl+C, npm start) to play it with its own fresh base + crew files`);
    } catch (e) { say("couldn't switch game"); }
    return;
  }
  if (/^(clear base|forget base|reset base)\b/.test(lm)) { memory.clearBase(); say('base cleared — the crew will stick near you until you "set base" again'); return; }
  if (/^(clear supply|forget supply|reset supply)\b/.test(lm)) { memory.clearSupply(); say('supply chest cleared — tool_guy will set up a new one'); return; }
  if (/^(reset (crew )?base|reset memory|fresh start)\b/.test(lm)) { memory.clearBase(); memory.clearSupply(); say('base + supply cleared — say "set base" to start fresh'); return; }
  if (/^(set base|base here|set depot)\b/.test(lm)) { setBaseAtOwner(); return; }
  if (/^(set supply|supply chest here|this is the supply chest|supply here|set supply chest)\b/.test(lm)) { setSupplyAtOwner(); return; }
  if (/^(set spawn|spawn here|set world ?spawn)\b/.test(lm)) { setSpawnAtOwner(); return; }
  if ((mm = lm.match(/^set op\s+(\S+)/))) {
    say(`/op ${mm[1]}`);
    say(`tried to op ${mm[1]} — only works if i'm already an operator`);
    return;
  }
  if (/^(base|where('?s| is)? (the )?base|depot)\b/.test(lm)) {
    const b = memory.getBase();
    say(b ? `base at ${b.x},${b.y},${b.z} — workers bring loot here when full` : 'no base set — stand by your chest and say "set base"');
    return;
  }

  // --- crew-wide natural phrases ---
  if (/supplies?\s*(are\s*)?ready|come get supplies|(everyone|all)\s+restock|restock (everyone|all)/.test(lm)) {
    for (const w of workers.values()) w.handle('restock');
    say('crew: supplies are ready — come grab tools/food');
    return;
  }
  if (/(everyone|all)\b.*\b(deposit|unload|come|return|to base)\b|come to base|drop everything/.test(lm)) {
    for (const w of workers.values()) w.handle('unload');
    say('crew: everyone to base to drop off');
    return;
  }

  // --- crew-wide: "all <command>" ---
  if ((mm = m.match(/^all\s+(.+)/i))) {
    for (const w of workers.values()) w.handle(mm[1]);
    return;
  }

  // --- addressed to one worker by name: "<name> <command>" ---
  const first = lm.split(/\s+/)[0];
  if (workers.has(first)) {
    workers.get(first).handle(m.slice(m.indexOf(' ') + 1));
    return;
  }

  // --- bare command -> the fallback worker ---
  if (fallback) fallback.handle(m);
}

// Public chat: bare commands go to the first worker.
function onChat(username, message) {
  if (config.owner && username !== config.owner) return; // only the owner commands the crew
  if (isDup(username, message)) return;
  route(String(message).trim(), primary());
}

// Whisper (/msg <worker> ...): only that worker's bot receives it, so a bare command goes to
// THAT worker. (Management + "name"/"all" prefixes still work.) No dedup — only one bot got it.
function onWhisper(username, message, selfName) {
  if (config.owner && username !== config.owner) return;
  route(String(message).trim(), workers.get(selfName.toLowerCase()));
}

// The owner's current position, from any worker that can see them.
function ownerSpot() {
  for (const w of workers.values()) {
    const p = w.ownerPos && w.ownerPos();
    if (p) return p;
  }
  return null;
}

// Owner position + the chest block next to them (if any), via a worker that can see them.
function ownerChestInfo() {
  for (const w of workers.values()) {
    const p = w.ownerPos && w.ownerPos();
    if (!p) continue;
    return { owner: p, chest: w.chestNear ? w.chestNear(p) : null };
  }
  return null;
}

// Base/depot = where workers bring loot (does NOT touch world spawn).
function setBaseAtOwner() {
  const p = ownerSpot();
  if (!p) { say("can't see you to set the base — get near a worker and try again"); return; }
  memory.setBase(p);
  const b = memory.getBase();
  say(`/setblock ${b.x} ${b.y - 1} ${b.z} minecraft:emerald_block`); // emerald marker under the base
  say(`/kill @e[type=minecraft:text_display,x=${b.x - 1},y=${b.y - 2},z=${b.z - 1},dx=2,dy=5,dz=2]`); // clear old holograms at this spot
  // sit just above the emerald block, light-green text (1.21 component format)
  say(`/summon minecraft:text_display ${b.x + 0.5} ${b.y + 0.6} ${b.z + 0.5} {text:{text:"Base",color:"green"},billboard:"center",Tags:["npbase"]}`);
  say(`base set at ${b.x},${b.y},${b.z} — emerald block + a floating green "Base" label`);

  // The game "begins" at set base: auto-spawn a logistics tool_guy if the crew doesn't have one.
  const hasLogi = [...workers.values()].some((w) => /logistics|foreman/.test(w.def.role || ''));
  if (!hasLogi && workers.size < MAX) {
    createWorkerCmd('tool_guy', 'logistics');
  }
}

// Supply chest = where workers TAKE tools/food; loot is never deposited here.
function setSupplyAtOwner() {
  const info = ownerChestInfo();
  if (!info) { say("can't see you to set the supply chest — get near a worker"); return; }
  // Anchor to the actual chest block if there's one beside you, else where you stood.
  const spot = info.chest || info.owner;
  memory.setSupply(spot);
  const s = memory.getSupply();
  // Hologram sits just above the chest top (chest block y + ~1.2), light-green text.
  const hy = (info.chest ? info.chest.y + 1.2 : s.y + 0.3);
  say(`/kill @e[type=minecraft:text_display,x=${s.x - 1},y=${s.y - 2},z=${s.z - 1},dx=2,dy=5,dz=2]`);
  say(`/summon minecraft:text_display ${s.x + 0.5} ${hy} ${s.z + 0.5} {text:{text:"Supply",color:"green"},billboard:"center",Tags:["npsupply"]}`);
  say(`supply chest set at ${s.x},${s.y},${s.z} — floating green "Supply" label just above it`);
}

// Spawn = the world spawn point (separate from base). Needs a worker op'd.
function setSpawnAtOwner() {
  const p = ownerSpot();
  if (!p) { say("can't see you to set spawn — get near a worker and try again"); return; }
  memory.setSpawn(p);
  const s = memory.getSpawn();
  say(`/setworldspawn ${s.x} ${s.y} ${s.z}`);
  say(`world spawn set at ${s.x},${s.y},${s.z} (needs me op'd)`);
}

function createWorkerCmd(rawName, jobStr) {
  const name = rawName.trim();
  const key = name.toLowerCase();
  if (key === 'all' || key === 'worker') { say(`"${name}" is reserved, pick another name`); return; }
  if (workers.has(key)) { say(`already have a worker named ${name}`); return; }
  if (workers.size >= MAX) { say(`crew is full (max ${MAX}) — remove one first`); return; }

  const preset = jobStr.trim().toLowerCase();
  const def = isPreset(preset) ? { name, role: preset } : { name, job: jobStr.trim() };
  defs.push(def);
  saveDefs();
  spawnWorker(def);
  say(`spawning ${name} — ${def.role || def.job}`);
}

function removeWorker(rawName) {
  const key = rawName.toLowerCase();
  const w = workers.get(key);
  if (!w) { say(`no worker named ${rawName}`); return; }
  try { w.disconnect(); } catch (e) { /* */ }
  workers.delete(key);
  defs = defs.filter((d) => d.name.toLowerCase() !== key);
  saveDefs();
  say(`dismissed ${w.name}`);
}

function start() {
  console.log(`[Crew] brain=${require('./brain').resolveBackend(config)} | booting lead worker to detect the world...`);
  console.log('[Crew] commands: worker create <name> <job> | worker list | worker roles | set base | help');
  // Spawn the lead worker (tool_guy). On its spawn it detects the world, then onWorldKnown
  // loads this world's saved crew and spawns the rest.
  spawnWorker({ name: 'tool_guy', role: 'logistics' });
}

// Keep the crew alive through unexpected errors.
process.on('unhandledRejection', (e) => console.error('[Crew] unhandledRejection:', e && e.message));
process.on('uncaughtException', (e) => console.error('[Crew] uncaughtException:', e && e.message));

start();
