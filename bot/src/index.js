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
const WORKERS_FILE = path.join(__dirname, '..', 'workers.json');

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

const manager = { onChat, onWhisper, persist: () => saveDefs() };

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

  // --- crew management ---
  if (/^worker\s+roles\b/.test(lm)) { say(`roles → ${rolesList().join('  |  ')}`); return; }
  if (/^worker\s+list\b/.test(lm)) {
    const list = [...workers.values()].map((w) => `${w.name} (${w.def.role || w.def.job || 'idle'})`).join(', ');
    say(`crew (${workers.size}/${MAX}): ${list || 'empty'}`);
    return;
  }
  if ((mm = lm.match(/^worker\s+remove\s+(\S+)/))) { removeWorker(mm[1]); return; }
  if ((mm = m.match(/^worker\s+create\s+(\S+)\s+(.+)/i))) { createWorkerCmd(mm[1], mm[2]); return; }
  if (/^worker\b/.test(lm)) {
    say('usage: worker create <name> <job> | worker list | worker roles | worker remove <name>');
    return;
  }

  // --- base / spawn / op ---
  if (/^(set base|base here|set depot)\b/.test(lm)) { setBaseAtOwner(); return; }
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

// Base/depot = where workers bring loot (does NOT touch world spawn).
function setBaseAtOwner() {
  const p = ownerSpot();
  if (!p) { say("can't see you to set the base — get near a worker and try again"); return; }
  memory.setBase(p);
  const b = memory.getBase();
  say(`base set at ${b.x},${b.y},${b.z} — put chests there (sign a chest "supply", others "deposit"/"iron"/etc). i'll walk loot here when full`);
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
  if (!defs.length) {
    // first run: a single worker named from config, surviving on its own
    defs = [{ name: config.palName || 'Ninja', role: 'survivor' }];
    saveDefs();
  }
  defs.slice(0, MAX).forEach(spawnWorker);
  console.log(`[Crew] brain=${require('./brain').resolveBackend(config)} | spawning ${workers.size} worker(s): ${[...workers.keys()].join(', ')}`);
  console.log('[Crew] commands: worker create <name> <job> | worker list | worker roles | worker remove <name> | <name> <cmd> | all <cmd>');
}

// Keep the crew alive through unexpected errors.
process.on('unhandledRejection', (e) => console.error('[Crew] unhandledRejection:', e && e.message));
process.on('uncaughtException', (e) => console.error('[Crew] uncaughtException:', e && e.message));

start();
