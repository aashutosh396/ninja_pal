'use strict';
// Cross-session memory — survives restarts in ../memory.json (gitignored, world-specific).
// Holds short free-text notes (things the owner told the pal) and a saved "home" position.

const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'memory.json');

function load() {
  try {
    const m = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    return { notes: Array.isArray(m.notes) ? m.notes : [], home: m.home || null };
  } catch (e) {
    return { notes: [], home: null };
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

function summary() {
  const parts = [];
  if (mem.home) parts.push(`home=(${mem.home.x},${mem.home.y},${mem.home.z})`);
  if (mem.notes.length) parts.push('notes: ' + mem.notes.slice(-8).join('; '));
  return parts.join(' | ') || 'nothing remembered yet';
}

module.exports = { add, setHome, getHome, summary, all: () => mem };
