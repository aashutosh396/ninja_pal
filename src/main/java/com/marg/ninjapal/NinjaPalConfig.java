package com.marg.ninjapal;

import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import net.fabricmc.loader.api.FabricLoader;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;

/**
 * Config for the AI pal, stored at {@code .minecraft/config/ninja_pal.json}.
 * Auto-created with defaults on first run; the player edits it to add their API key.
 * OpenAI-compatible by default, so it also works with OpenRouter, local servers, etc.
 */
public class NinjaPalConfig {
	private static final Gson GSON = new GsonBuilder().setPrettyPrinting().create();
	private static final Path PATH = FabricLoader.getInstance().getConfigDir().resolve("ninja_pal.json");

	public boolean enabled = true;
	public String apiUrl = "https://api.openai.com/v1/chat/completions";
	public String apiKey = "";              // <-- put your OpenAI-compatible API key here
	public String model = "gpt-4o-mini";
	public String palName = "Ninja";
	public String systemPrompt = "You are Ninja, a friendly companion who lives inside the player's "
			+ "Minecraft world. Keep replies short (1-3 sentences), warm, a little playful, and "
			+ "practical. You can give Minecraft tips. Stay in character; never mention being an AI.";
	public int maxTokens = 200;
	public double temperature = 0.8;

	public static NinjaPalConfig load() {
		try {
			if (Files.exists(PATH)) {
				NinjaPalConfig cfg = GSON.fromJson(Files.readString(PATH), NinjaPalConfig.class);
				if (cfg != null) {
					return cfg;
				}
			}
		} catch (Exception e) {
			NinjaPal.LOGGER.error("[Ninja Pal] failed to read config, using defaults", e);
		}
		NinjaPalConfig cfg = new NinjaPalConfig();
		cfg.save();   // write a template config the player can edit
		return cfg;
	}

	public void save() {
		try {
			Files.createDirectories(PATH.getParent());
			Files.writeString(PATH, GSON.toJson(this));
		} catch (IOException e) {
			NinjaPal.LOGGER.error("[Ninja Pal] failed to write config", e);
		}
	}

	public boolean hasKey() {
		return apiKey != null && !apiKey.isBlank();
	}
}
