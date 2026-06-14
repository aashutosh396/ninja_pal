'use strict';
// Cross-session memory — survives restarts in ../memory.json (gitignored, world-specific).
// Holds short free-text notes (things the owner told the pal) and a saved "home" position.

const fs = require('fs');
const path = require('path');

// Per-game file. If config.game is set it wins (manual). Otherwise the file is auto-keyed to the
// world's spawn point (set via setWorld on first spawn) -> memory-w<x>_<z>.json. So each world
// keeps its own base/supply/notes automatically and a new world starts clean.
function gameTag() {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config.json'), 'utf8'));
    const g = cfg.game ? String(cfg.game).replace(/[^a-z0-9_-]/gi, '') : '';
    return g ? `-${g}` : '';
  } catch (e) { return ''; }
}
let FILE = path.join(__dirname, '..', `memory${gameTag()}.json`);

// Auto-switch to a world-specific file (no-op if config.game is set, or already on it).
function setWorld(id) {
  if (gameTag()) return; // manual game name takes precedence
  const f = path.join(__dirname, '..', `memory-w${id}.json`);
  if (f === FILE) return;
  FILE = f;
  mem = load();
}

function load() {
  try {
    const m = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    return { notes: Array.isArray(m.notes) ? m.notes : [], home: m.home || null, base: m.base || null, spawn: m.spawn || null, supply: m.supply || null, walled: !!m.walled };
  } catch (e) {
    return { notes: [], home: null, base: null, spawn: null, supply: null, walled: false };
  }
}

let mem = load();

function save() {
  try {
    fs.writeFileSync(FILE, JSON.stringify(mem, null, 2));
  } catch (e) {
    /* non-fatal — memory just won't persist this time */
  }
}

function add(note) {
  if (!note) return;
  mem.notes.push(String(note).slice(0, 200));
  mem.notes = mem.notes.slice(-50); // keep the last 50
  save();
}

function setHome(pos) {
  mem.home = { x: Math.round(pos.x), y: Math.round(pos.y), z: Math.round(pos.z) };
  save();
}

function getHome() {
  return mem.home;
}

// Shared crew base/depot (where the chests are). Workers do loot runs here.
function setBase(pos) {
  mem.base = { x: Math.round(pos.x), y: Math.round(pos.y), z: Math.round(pos.z) };
  mem.walled = false; // new base -> needs a new wall
  save();
}

function setWalled(v) { mem.walled = !!v; save(); }
function getWalled() { return mem.walled; }

function getBase() {
  return mem.base;
}

function setSpawn(pos) {
  mem.spawn = { x: Math.round(pos.x), y: Math.round(pos.y), z: Math.round(pos.z) };
  save();
}

function getSpawn() {
  return mem.spawn;
}

// The shared supply chest (workers take tools/food from it; loot is never deposited into it).
function setSupply(pos) {
  mem.supply = { x: Math.round(pos.x), y: Math.round(pos.y), z: Math.round(pos.z) };
  save();
}

function getSupply() {
  return mem.supply;
}

function clearBase() { mem.base = null; mem.walled = false; save(); }
function clearSupply() { mem.supply = null; save(); }

function summary() {
  const parts = [];
  if (mem.home) parts.push(`home=(${mem.home.x},${mem.home.y},${mem.home.z})`);
  if (mem.notes.length) parts.push('notes: ' + mem.notes.slice(-8).join('; '));
  return parts.join(' | ') || 'nothing remembered yet';
}

module.exports = { add, setHome, getHome, setBase, getBase, clearBase, setWalled, getWalled, setSpawn, getSpawn, setSupply, getSupply, clearSupply, setWorld, summary, all: () => mem };
