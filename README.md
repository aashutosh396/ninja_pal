# Ninja Pal

An AI companion for Minecraft — **a real second player that joins your world and plays
alongside you** — plus a small in-world utility mod.

Two parts:

| Part | What | Where |
|---|---|---|
| **Bot** (the AI pal) | Logs into your world as a real second player (Mineflayer + LLM). Follows you, defends you, gathers blocks, chats. | [`bot/`](bot/) — see [bot/README.md](bot/README.md) |
| **Mod** (utility) | Fabric mod adding `/spawn` (teleport to world spawn). | repo root |

- **Minecraft:** 1.20.4 · **Loader:** Fabric · **Java:** 17+ (mod) · **Node:** 18+ (bot)

---

## The AI pal → see [`bot/README.md`](bot/README.md)

Quick version:

```bash
cd bot
npm install
cp config.example.json config.json   # set "owner" (your username) + "apiKey"
npm start                              # after you Open your world to LAN
```

Then in game: `follow me`, `stop`, `come`, `collect wood 3`, `defend`, or just talk to it.

---

## The mod (`/spawn`)

### Install & test (TLauncher or any Fabric setup)

1. In **TLauncher**, install a **Fabric 1.20.4** profile and run it once.
2. Put **two** jars into your `.minecraft/mods/` folder:
   - `ninja_pal-1.0.0.jar` (this mod — from `build/libs/`)
   - **Fabric API** `fabric-api-0.97.0+1.20.4.jar` — from
     https://modrinth.com/mod/fabric-api/versions (the 1.20.4 file). *Required.*
3. Launch Minecraft (Fabric 1.20.4) → start a world.
4. Type **`/spawn`** → you teleport to the world spawn point.

> macOS mods folder: `~/Library/Application Support/minecraft/mods/`

### Build from source

```bash
export JAVA_HOME=/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home
./gradlew build
# output: build/libs/ninja_pal-1.0.0.jar
```

### Structure

```
ninja_pal/
├── build.gradle              # Fabric Loom 1.6, Java 17, Yarn mappings
├── gradle.properties         # MC 1.20.4, loader 0.15.7, fabric-api 0.97.0+1.20.4
├── src/main/
│   ├── java/com/marg/ninjapal/NinjaPal.java   # ModInitializer + /spawn command
│   └── resources/fabric.mod.json              # mod metadata + entrypoint
└── bot/                       # the AI companion (Mineflayer + LLM) — separate Node project
```

- `/spawn` via Fabric `CommandRegistrationCallback` (Brigadier) →
  `ServerPlayerEntity.teleport()` to `ServerWorld.getSpawnPos()`.
- Depends on **fabric-api** (command API) — must be present at runtime.
