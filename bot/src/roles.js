'use strict';
// Preset worker roles + a simple free-text job interpreter.
// A worker's "job" is either a preset role name or a free-text description. interpret() turns
// it into a structured plan the worker loop runs on repeat.

const PRESETS = {
  guard: 'follow and protect the owner',
  lumberjack: 'chop wood and put it in the nearest chest',
  miner: 'mine iron and put it in the nearest chest',
  digger: 'collect dirt and put it in the nearest chest',
  miner_stone: 'mine stone and put it in the nearest chest',
  hunter: 'hunt animals for food',
  survivor: 'survive on your own — wood, tools, food, a house',
  idle: 'wait for orders',
};

function rolesList() {
  return Object.entries(PRESETS).map(([k, v]) => `${k}: ${v}`);
}

function isPreset(word) {
  return Object.prototype.hasOwnProperty.call(PRESETS, word);
}

// Effective job text for a worker def (preset name -> its description, else the free text).
function jobText(def) {
  if (def.role && PRESETS[def.role]) return PRESETS[def.role];
  return def.job || PRESETS.idle;
}

// Map natural words -> a canonical resource our skills understand.
const RES = {
  wood: 'wood', woods: 'wood', logs: 'wood', log: 'wood', trees: 'wood', tree: 'wood', timber: 'wood',
  dirt: 'dirt', stone: 'stone', cobblestone: 'stone', cobble: 'stone',
  coal: 'coal', iron: 'iron', gold: 'gold', diamond: 'diamond', diamonds: 'diamond', sand: 'sand',
};

// Parse a job string into a plan: {kind:'guard'|'hunt'|'survive'|'gather'|'idle'|'unknown', ...}
function interpret(job) {
  const j = String(job || '').toLowerCase();
  if (!j.trim() || /\bidle|wait\b/.test(j)) return { kind: 'idle' };
  if (/\b(guard|protect|defend|follow|escort|bodyguard)\b/.test(j)) return { kind: 'guard' };
  if (/\b(hunt|hunting|kill animals|get food|find food)\b/.test(j)) return { kind: 'hunt' };
  if (/\b(survive|survival|on (your|his|its) own|thrive|fend for)\b/.test(j)) return { kind: 'survive' };

  let resource = null;
  for (const w of Object.keys(RES)) {
    if (new RegExp(`\\b${w}\\b`).test(j)) { resource = RES[w]; break; }
  }
  if (resource) {
    const verb = /\b(mine|dig|dig up)\b/.test(j) && resource !== 'wood' ? 'mine' : 'collect';
    let sink = 'hold';
    if (/\b(chest|barrel|deposit|store|fill|stash)\b/.test(j)) sink = 'chest';
    else if (/\b(drop|toss|dump|throw)\b/.test(j)) sink = 'drop';
    else if (/\b(give|bring|hand|deliver)\b/.test(j)) sink = 'give';
    return { kind: 'gather', verb, resource, sink };
  }
  return { kind: 'unknown' }; // hand off to the LLM
}

module.exports = { PRESETS, rolesList, isPreset, jobText, interpret };
