# Ninja Pal

An AI Pal mod for Minecraft (Fabric).

- **Phase 1:** `/spawn` — teleports the player to the world spawn point.
- **Phase 2:** `/pal <message>` — talk to an AI companion that replies in chat.

- **Minecraft:** 1.20.4 · **Loader:** Fabric · **Java:** 17+

## Install & test (TLauncher or any Fabric setup)

1. In **TLauncher**, install a **Fabric 1.20.4** profile (TLauncher → version list → Fabric 1.20.4) and run it once.
2. Put **two** jars into your `.minecraft/mods/` folder:
   - `ninja_pal-1.0.0.jar` (this mod — from `build/libs/`)
   - **Fabric API** `fabric-api-0.97.0+1.20.4.jar` — download from
     https://modrinth.com/mod/fabric-api/versions (pick the 1.20.4 file). *Required.*
3. Launch Minecraft (Fabric 1.20.4) via TLauncher → start a world.
4. Type **`/spawn`** in chat → you teleport to the world spawn point and see *"✦ Teleported to world spawn."*

> macOS mods folder: `~/Library/Application Support/minecraft/mods/`

## Phase 2 — the AI pal (`/pal`)

On first run the mod writes a config at `.minecraft/config/ninja_pal.json` (macOS:
`~/Library/Application Support/minecraft/config/ninja_pal.json`). Open it and set your key:

```json
{
  "enabled": true,
  "apiUrl": "https://api.openai.com/v1/chat/completions",
  "apiKey": "sk-...your key here...",
  "model": "gpt-4o-mini",
  "palName": "Ninja",
  "systemPrompt": "You are Ninja, a friendly companion ...",
  "maxTokens": 200,
  "temperature": 0.8
}
```

Then in-game:

```
/pal hey, what should I build next?
```

The pal answers in chat as `<Ninja> ...`.

- **OpenAI-compatible** — works with OpenAI, OpenRouter (point `apiUrl` at
  `https://openrouter.ai/api/v1/chat/completions` and use any model, incl. Claude), or a
  local server (LM Studio / Ollama's OpenAI endpoint). Just change `apiUrl` + `model`.
- Edit `palName` / `systemPrompt` to give the pal any personality you like.
- No key set? `/pal` politely reminds you to add one. The HTTP call is fully async, so the
  server never freezes while the pal "thinks."
- The key lives only in your local config file — it is **not** committed to git.

## Build from source

```bash
export JAVA_HOME=/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home
./gradlew build
# output: build/libs/ninja_pal-1.0.0.jar
```

## Structure / dependencies

```
ninja_pal/
├── build.gradle              # Fabric Loom 1.6, Java 17, Yarn mappings
├── gradle.properties         # MC 1.20.4, loader 0.15.7, fabric-api 0.97.0+1.20.4
├── settings.gradle
└── src/main/
    ├── java/com/marg/ninjapal/
    │   ├── NinjaPal.java         # ModInitializer + /spawn and /pal commands
    │   ├── NinjaPalConfig.java   # config/ninja_pal.json load/save (Gson)
    │   └── AiClient.java         # async OpenAI-compatible chat client
    └── resources/fabric.mod.json # mod metadata + entrypoint
```

- Commands via Fabric `CommandRegistrationCallback` (Brigadier). `/spawn` →
  `ServerPlayerEntity.teleport()` to `ServerWorld.getSpawnPos()`.
- `/pal` → `AiClient` posts to an OpenAI-compatible endpoint with `java.net.http.HttpClient`
  (async) and parses the reply with Gson — both ship with Minecraft, so no extra deps.
- Depends on **fabric-api** (command API) — must be present at runtime.
