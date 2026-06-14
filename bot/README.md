# Ninja Pal — bot (Phase 2)

An AI companion that joins your Minecraft world as a **real second player** (Mineflayer + an
LLM brain). It shows up in the player list, has a body, and plays alongside you:

- **plans multi-step goals** — the brain returns an ordered plan, so "make me a base" becomes
  gather wood → craft tools → build a shelter → light it, run in sequence
- **senses the world** — it reasons over its position, time of day (night!), nearby threats and
  their distances, players around, its health/food, and what it's carrying
- **follows** you, **comes** / **stops** on command
- **defends** you — auto-attacks hostile mobs near you, auto-equips its best weapon first
- **gathers** blocks on request (`collect wood`, `mine iron`, …)
- **crafts** items (`craft oak_planks`, uses a nearby crafting table when needed)
- **gets tools** — one command chops wood and crafts a full set of wooden tools
- **builds** — `shelter` (box itself in), `torch` (light the area), `pillar` (tower up)
- **hands you loot** — walks over and drops items (`give wood`, `give all`)
- **self-sustains** — auto-eats when hungry so it doesn't starve / heals via regen
- **chats** via the LLM with a real teammate personality

> **Smarter pal = stronger model.** The pal's intelligence comes from `config.model`. Default is
> `gpt-4o`; a top-tier model plans better. Point `apiUrl`/`model` at OpenRouter to use Claude, etc.

> This is separate from the Fabric mod at the repo root (that one adds `/spawn`). The bot is a
> standalone program you run next to Minecraft.

## Requirements

- **Node.js 18+** (uses built-in `fetch`).
- Your world **Open to LAN** (singleplayer) or a Minecraft server. Works with TLauncher via
  offline mode.
- **Minecraft version:** any from **1.20.x through 1.21.x** (incl. 1.21.11). Leave
  `"version": "auto"` and the bot negotiates the server's version automatically; or pin an
  exact version string if you prefer. (The Fabric `/spawn` mod at the repo root is separate and
  is built for 1.20.4 only.)
- A **brain** (see below). The default is your **local Claude Max** login — no API key, no
  per-token cost.

## Brain backend

Set `"backend"` in `config.json`:

- **`"claude"` (default)** — shells out to your locally logged-in `claude` CLI (Claude Max),
  exactly like discord-autoreply. **No API key, no per-token cost.** Make sure `claude` works in
  your terminal (run `claude -p "hi"` once). Pick the model with `"claudeModel"` (e.g.
  `claude-sonnet-4-6` for fast/cheap, `claude-opus-4-8` for the smartest pal).
- **`"openai"`** — any OpenAI-compatible HTTP endpoint. Set `"apiKey"`, `"apiUrl"`, `"model"`.
  Works with OpenAI, OpenRouter (use Claude/any model through it), or a local server.

If `"backend"` is omitted: a present `apiKey` → openai, otherwise → claude.

Without any working brain the pal still does the direct commands (follow/stop/come/defend/get
tools/shelter/home), just no free-form chat or planning.

## Setup

```bash
cd bot
npm install
cp config.example.json config.json
```

Edit `config.json`:

| field | what |
|---|---|
| `owner` | **your** in-game username — the bot only obeys you |
| `palName` | the bot's username (shows in the player list) |
| `host` / `port` | `localhost` + the port Minecraft prints when you **Open to LAN** |
| `backend` | `claude` (local Claude Max, default) or `openai` |
| `claudeModel` | which Claude model when backend=claude (`claude-sonnet-4-6` / `claude-opus-4-8`) |
| `apiKey` / `apiUrl` / `model` | only for backend=openai |
| `systemPrompt` | the pal's personality |

With the default `claude` backend you only need to set **`owner`** and **`port`** — no API key.

## Run

1. In Minecraft: open your world → **Esc → Open to LAN** → note the port (e.g. `55916`), set it
   in `config.json`.
2. Start the pal:

   ```bash
   npm start
   ```

3. It logs in as a second player and says hi. In chat, try:

   ```
   follow me
   stop  /  come  /  defend
   collect wood 3
   get tools                  ← chops wood + crafts a full tool set
   shelter                    ← boxes itself in (great at night)
   set home  /  go home       ← remembers a spot across sessions
   give me the wood
   mine me some iron          ← free-form: it makes a pickaxe + tunnels to ore
   make us a base             ← free-form: plans collect -> tools -> shelter -> torch
   it's getting dark, what do we do?   ← free-form chat + it may act on its own
   ```

## How it works

```
bot/
├── src/index.js    # connect, wire plugins, chat handler, defense loop
├── src/skills.js   # action primitives: follow / come / stop / collect / attack / goto
└── src/brain.js    # LLM call (OpenAI-compatible) -> {say, action}
```

- Movement/pathfinding via **mineflayer-pathfinder**, combat via **mineflayer-pvp**, mining via
  **mineflayer-collectblock**.
- Direct keywords (follow/stop/come/defend) skip the LLM for instant response; anything else is
  sent to the brain, which replies in character and may pick one action to perform.
- Auto-defense runs on a 1 s loop independent of the LLM, so the pal reacts to mobs instantly.
- Your API key lives only in `config.json`, which is gitignored — never committed.

## Crew — named workers (multi-bot)

Spawn a crew of named worker bots, each doing a job on repeat. Commands are typed in **normal
chat (no slash)**:

```
worker create Digger collect dirt and fill the nearest chest
worker create Bob mine iron and put it in the chest
worker create Max guard            (a preset role)
worker list                        who's in the crew + their jobs
worker roles                       list the preset roles
worker remove Bob                  dismiss a worker
```

Command them:
```
Bob come              one worker
Bob deposit dirt
all follow me         the whole crew
<command>             (no name) goes to the first worker
```

- A worker's **job** is free text ("collect wood and fill the chest") or a **preset role**
  (`guard`, `lumberjack`, `miner`, `digger`, `miner_stone`, `hunter`, `survivor`, `idle`).
- Simple gather jobs run reliably (gather → open the nearest chest → deposit → repeat).
  Open-ended jobs fall back to the Claude brain.
- The crew is saved to `workers.json` and **respawns automatically** on restart.
- Cap with `maxWorkers` in config (default 5) — more bots = more lag + more brain calls.
- First run with no `workers.json` spawns one `survivor` named after `palName`.

## Memory & home

The pal remembers across restarts (in `memory.json`, gitignored):

- `set home` — saves its current spot; `go home` walks back there later
- tell it things ("we're building a castle by the lake") and it saves them; you'll see it act on
  them in future sessions

## Roadmap

Done: follow / come / stop · auto-defend + best-weapon · collect · craft · give-to-owner ·
auto-eat / self-heal · multi-step planning · world perception · get-tools routine ·
building (shelter / torch / pillar) · **bow combat** · **flee when low health** ·
**mine-to-ore / strip-mine** · **cross-session memory + home** · teammate personality.

Next:
- bridge across gaps + smarter multi-block structures
- smelting / furnaces / auto-restock gear
- proactive idle behaviour (it acts without being asked)
