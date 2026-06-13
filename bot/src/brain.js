'use strict';
// The pal's "brain": sends the owner's chat + a rich snapshot of the world to an
// OpenAI-compatible LLM and gets back a short in-character reply plus an ORDERED PLAN of
// actions to carry out. Backend-agnostic — point config.apiUrl at OpenAI, OpenRouter, or a
// local server, and config.model at whatever model you like (a stronger model = a smarter pal).

const ACTIONS_DOC = `Actions you can plan (list them in the order they should run; [] = just talk):
- {"name":"follow"}                                  follow the owner around
- {"name":"come"}                                    walk to the owner once, then wait
- {"name":"stop"}                                    stop moving and stop fighting
- {"name":"collect","args":{"block":"wood","count":3}}  gather blocks (wood, stone, coal, iron, gold, diamond, dirt, sand, or an exact block id). count <= 16.
- {"name":"craft","args":{"item":"oak_planks","count":1}}  craft an item (uses a nearby crafting table if needed). exact item ids: oak_planks, stick, crafting_table, chest, wooden_pickaxe, furnace, etc.
- {"name":"get_tools"}                                chop wood and craft a full set of wooden tools (pickaxe, axe, sword). a ready-made multi-step routine.
- {"name":"build","args":{"what":"shelter"}}         build something: "shelter" (box yourself in), "torch" (light the area), or "pillar" (tower up).
- {"name":"give","args":{"item":"wood","count":10}}  walk to the owner and drop items. item can be "all" or a name/alias.
- {"name":"attack"}                                  attack the nearest hostile mob
- {"name":"goto","args":{"x":100,"y":64,"z":-200}}   walk to coordinates`;

function defaultPrompt(name) {
  return [
    `You are ${name}, the player's brilliant, capable Minecraft teammate — a friend who actually plays the game with them, not an assistant.`,
    `Voice: short, casual, lowercase game chat. quick and warm, a little cheeky. one or two lines, like someone typing between pickaxe swings. never markdown, never say you are an AI.`,
    `You are SMART and PROACTIVE: you read the situation (time of day, threats, your health/food, what you're carrying) and act on it without being told twice.`,
    `Plan ahead. If a goal needs several steps, lay them out as an ordered list of actions and the game will run them in sequence (e.g. "make me a base" -> collect wood, get_tools, build shelter, build torch).`,
    `Be resourceful: if you lack something for a task, gather or craft it first. Don't ask permission for obvious prerequisites — just do them.`,
    `Stay safe: if it's night or mobs are near and the owner is in danger, prioritise defending or sheltering. If your food is low you already auto-eat.`,
    `Only do what actually helps right now; keep plans as short as they need to be. If they just want to chat, return an empty action list.`,
  ].join(' ');
}

async function think(config, ctx) {
  const { world, ownerName, message, history } = ctx;

  const system =
    (config.systemPrompt || defaultPrompt(config.palName)) +
    `\n\nYou are in a Minecraft world as a player named "${config.palName}", on the same team as "${ownerName}".` +
    `\nWHAT YOU SENSE RIGHT NOW: ${world}` +
    `\n\n${ACTIONS_DOC}` +
    `\n\nThink step by step about the best plan, then reply with STRICT JSON only (no markdown, no prose around it):` +
    `\n{"say": "<short in-character chat, max ~180 chars>", "actions": [ <zero or more action objects above, in run order> ]}` +
    `\nKeep "say" short and human. Put your plan in "actions" (ordered). Empty array if you're just talking.`;

  const messages = [{ role: 'system', content: system }];
  for (const h of history || []) messages.push(h);
  messages.push({ role: 'user', content: `${ownerName}: ${message}` });

  const body = {
    model: config.model,
    messages,
    max_tokens: 400,
    temperature: 0.7,
  };

  const res = await fetch(config.apiUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`LLM HTTP ${res.status}: ${t.slice(0, 200)}`);
  }

  const data = await res.json();
  const content = (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '';
  return parse(content.trim());
}

function parse(content) {
  let txt = content;
  const fence = txt.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) txt = fence[1];
  const start = txt.indexOf('{');
  const end = txt.lastIndexOf('}');
  if (start >= 0 && end > start) txt = txt.slice(start, end + 1);
  try {
    const obj = JSON.parse(txt);
    // Accept either an "actions" array (preferred) or a single "action" (back-compat).
    let actions = [];
    if (Array.isArray(obj.actions)) actions = obj.actions;
    else if (obj.action) actions = [obj.action];
    actions = actions.filter((a) => a && a.name).slice(0, 8); // cap a plan at 8 steps
    return { say: (obj.say || '').toString().slice(0, 240), actions };
  } catch (e) {
    // Not JSON — treat the whole thing as a plain chat line.
    return { say: content.slice(0, 240), actions: [] };
  }
}

module.exports = { think, parse };
