# Ninja Pal

An AI Pal mod for Minecraft (Fabric). **Phase 1**: a `/spawn` command that teleports the player to
the world spawn point. AI integration arrives in Phase 2.

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
    ├── java/com/marg/ninjapal/NinjaPal.java   # ModInitializer + /spawn command
    └── resources/fabric.mod.json              # mod metadata + entrypoint
```

- Command via Fabric `CommandRegistrationCallback` (Brigadier) → `ServerPlayerEntity.teleport()` to `ServerWorld.getSpawnPos()`.
- Depends on **fabric-api** (command API) — must be present at runtime.
