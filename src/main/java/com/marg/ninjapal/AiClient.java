package com.marg.ninjapal;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.concurrent.CompletableFuture;

/**
 * Talks to an OpenAI-compatible chat-completions endpoint, fully async (never blocks the
 * server thread). Returns a player-friendly string even on error — never throws into the game.
 */
public final class AiClient {
	private static final HttpClient HTTP = HttpClient.newBuilder()
			.connectTimeout(Duration.ofSeconds(15))
			.build();

	private AiClient() {
	}

	public static CompletableFuture<String> chat(NinjaPalConfig cfg, String userMessage) {
		if (!cfg.enabled) {
			return CompletableFuture.completedFuture("(i'm switched off in the config right now)");
		}
		if (!cfg.hasKey()) {
			return CompletableFuture.completedFuture(
					"(add your API key in config/ninja_pal.json so i can talk back!)");
		}

		JsonObject sys = new JsonObject();
		sys.addProperty("role", "system");
		sys.addProperty("content", cfg.systemPrompt);
		JsonObject usr = new JsonObject();
		usr.addProperty("role", "user");
		usr.addProperty("content", userMessage);
		JsonArray messages = new JsonArray();
		messages.add(sys);
		messages.add(usr);

		JsonObject body = new JsonObject();
		body.addProperty("model", cfg.model);
		body.add("messages", messages);
		body.addProperty("max_tokens", cfg.maxTokens);
		body.addProperty("temperature", cfg.temperature);

		HttpRequest req = HttpRequest.newBuilder(URI.create(cfg.apiUrl))
				.timeout(Duration.ofSeconds(30))
				.header("Content-Type", "application/json")
				.header("Authorization", "Bearer " + cfg.apiKey)
				.POST(HttpRequest.BodyPublishers.ofString(body.toString()))
				.build();

		return HTTP.sendAsync(req, HttpResponse.BodyHandlers.ofString())
				.thenApply(AiClient::parse)
				.exceptionally(e -> {
					NinjaPal.LOGGER.error("[Ninja Pal] AI request failed", e);
					return "(couldn't reach my brain — check the network / apiUrl in config)";
				});
	}

	private static String parse(HttpResponse<String> resp) {
		try {
			if (resp.statusCode() / 100 != 2) {
				NinjaPal.LOGGER.warn("[Ninja Pal] AI HTTP {} : {}", resp.statusCode(), resp.body());
				return "(my brain returned an error — HTTP " + resp.statusCode() + ", check your key/model)";
			}
			JsonObject json = JsonParser.parseString(resp.body()).getAsJsonObject();
			String content = json.getAsJsonArray("choices").get(0).getAsJsonObject()
					.getAsJsonObject("message").get("content").getAsString();
			return content.strip();
		} catch (Exception e) {
			NinjaPal.LOGGER.error("[Ninja Pal] failed to parse AI response", e);
			return "(i couldn't think of a reply, sorry)";
		}
	}
}
