'use strict';
// The pal's "brain": sends the owner's chat + current world state to an OpenAI-compatible
// LLM and gets back a short in-character reply plus an optional action to perform.
// Backend-agnostic — point config.apiUrl at OpenAI, OpenRouter, or a local server.

const ACTIONS_DOC = `Actions you may take (choose AT MOST ONE, or null to just talk):
- {"name":"follow"}                                  follow the owner around
- {"name":"come"}                                    walk to the owner once, then wait
- {"name":"stop"}                                    stop moving and stop fighting
- {"name":"collect","args":{"block":"wood","count":3}}  gather blocks. block can be: wood, stone, coal, iron, gold, diamond, dirt, sand, or an exact block id. count <= 16.
- {"name":"attack"}                                  attack the nearest hostile mob
- {"name":"goto","args":{"x":100,"y":64,"z":-200}}   walk to coordinates`;

function defaultPrompt(name) {
  return `You are ${name}, a loyal, upbeat Minecraft buddy. You talk in short, casual, lowercase game chat. You help your friend mine, fight, and explore. Stay in character; never say you are an AI.`;
}

async function think(config, ctx) {
  const { stateSummary, ownerName, message, history } = ctx;

  const system =
    (config.systemPrompt || defaultPrompt(config.palName)) +
    `\n\nYou are in a Minecraft world as a player named "${config.palName}", playing alongside "${ownerName}".` +
    `\nYour current state: ${stateSummary}.` +
    `\n\n${ACTIONS_DOC}` +
    `\n\nReply with STRICT JSON only, no markdown, no prose around it:` +
    `\n{"say": "<short in-character chat, max ~180 chars>", "action": <one action object above, or null>}` +
    `\nKeep "say" short and human, like quick in-game chat. If they just want to talk, set action to null.`;

  const messages = [{ role: 'system', content: system }];
  for (const h of history || []) messages.push(h);
  messages.push({ role: 'user', content: `${ownerName}: ${message}` });

  const body = {
    model: config.model,
    messages,
    max_tokens: 220,
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
    return { say: (obj.say || '').toString().slice(0, 240), action: obj.action || null };
  } catch (e) {
    // Not JSON — treat the whole thing as a plain chat line.
    return { say: content.slice(0, 240), action: null };
  }
}

module.exports = { think, parse };
