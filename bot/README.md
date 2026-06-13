# Ninja Pal — bot (Phase 2)

An AI companion that joins your Minecraft world as a **real second player** (Mineflayer + an
LLM brain). It shows up in the player list, has a body, and plays alongside you:

- **follows** you, **comes** / **stops** on command
- **defends** you — auto-attacks hostile mobs near you
- **gathers** blocks on request (`collect wood`, `mine iron`, …)
- **chats** with you via the LLM, which can also trigger the actions above

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
   what should we build?      ← free-form, goes to the LLM brain
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

## Roadmap (next)

- gather → **craft** → build simple structures
- ranged combat + auto-eat / self-heal
- multi-step tasks ("build a shelter", "strip-mine to bedrock")
- longer memory of the world and your sessions
