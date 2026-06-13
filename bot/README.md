# Ninja Pal — bot (Phase 2)

An AI companion that joins your Minecraft world as a **real second player** (Mineflayer + an
LLM brain). It shows up in the player list, has a body, and plays alongside you:

- **follows** you, **comes** / **stops** on command
- **defends** you — auto-attacks hostile mobs near you, auto-equips its best weapon first
- **gathers** blocks on request (`collect wood`, `mine iron`, …)
- **crafts** items (`craft oak_planks`, uses a nearby crafting table when needed)
- **hands you loot** — walks over and drops items (`give wood`, `give all`)
- **self-sustains** — auto-eats when hungry so it doesn't starve / heals via regen
- **chats** with you via the LLM (with a real buddy personality), which also knows what it's
  carrying and can trigger any action above

> This is separate from the Fabric mod at the repo root (that one adds `/spawn`). The bot is a
> standalone program you run next to Minecraft.

## Requirements

- **Node.js 18+** (uses built-in `fetch`).
- Your world **Open to LAN** (singleplayer) or a Minecraft server. Works with TLauncher via
  offline mode.
- An OpenAI-compatible API key for the chat brain (optional — without it the pal still does
  follow/stop/come/defend, just no free-form chat).

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
| `apiKey` | your OpenAI-compatible key (leave blank to skip chat) |
| `apiUrl` / `model` | defaults to OpenAI; point at OpenRouter / a local server if you like |
| `systemPrompt` | the pal's personality |

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
   stop
   come
   collect wood 3
   defend
   craft me some planks       ← free-form, the brain picks the craft action
   give me the wood
   what should we build?      ← free-form chat
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

## Roadmap

Done: follow / come / stop · auto-defend + best-weapon · collect · **craft** · **give to owner**
· **auto-eat / self-heal** · inventory-aware chat + buddy personality.

Next:
- build simple structures (place blocks: shelter, bridge, torch the area)
- multi-step tasks ("get wood then craft tools", "strip-mine to bedrock")
- ranged combat (bow) + smarter retreat when low health
- longer memory across sessions
