package com.marg.ninjapal;

import com.mojang.brigadier.arguments.StringArgumentType;
import com.mojang.brigadier.context.CommandContext;
import net.fabricmc.api.ModInitializer;
import net.fabricmc.fabric.api.command.v2.CommandRegistrationCallback;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.command.CommandManager;
import net.minecraft.server.command.ServerCommandSource;
import net.minecraft.server.network.ServerPlayerEntity;
import net.minecraft.server.world.ServerWorld;
import net.minecraft.text.Text;
import net.minecraft.util.Formatting;
import net.minecraft.util.math.BlockPos;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * Ninja Pal.
 *  - Phase 1: {@code /spawn} teleports the player to world spawn.
 *  - Phase 2: {@code /pal <message>} talks to an AI companion that replies in chat.
 *    The AI backend is configured in {@code .minecraft/config/ninja_pal.json}.
 */
public class NinjaPal implements ModInitializer {
	public static final String MOD_ID = "ninja_pal";
	public static final Logger LOGGER = LoggerFactory.getLogger(MOD_ID);

	public static NinjaPalConfig CONFIG;

	@Override
	public void onInitialize() {
		CONFIG = NinjaPalConfig.load();

		CommandRegistrationCallback.EVENT.register((dispatcher, registryAccess, environment) -> {
			dispatcher.register(CommandManager.literal("spawn").executes(NinjaPal::runSpawn));
			dispatcher.register(CommandManager.literal("pal")
				.then(CommandManager.argument("message", StringArgumentType.greedyString())
					.executes(NinjaPal::runPal)));
		});

		LOGGER.info("[Ninja Pal] initialized — /spawn and /pal registered (pal '{}', key {}).",
			CONFIG.palName, CONFIG.hasKey() ? "set" : "MISSING");
	}

	/** Teleport the command source (a player) to the overworld spawn point. */
	private static int runSpawn(CommandContext<ServerCommandSource> ctx) {
		ServerCommandSource source = ctx.getSource();
		ServerPlayerEntity player = source.getPlayer();
		if (player == null) {
			source.sendError(Text.literal("Only a player can use /spawn."));
			return 0;
		}

		ServerWorld overworld = source.getServer().getOverworld();
		BlockPos spawn = overworld.getSpawnPos();

		player.teleport(
			overworld,
			spawn.getX() + 0.5,
			spawn.getY(),
			spawn.getZ() + 0.5,
			player.getYaw(),
			player.getPitch()
		);

		source.sendFeedback(() -> Text.literal("✦ Teleported to world spawn."), false);
		return 1;
	}

	/** Send the player's message to the AI pal and broadcast its reply in chat. */
	private static int runPal(CommandContext<ServerCommandSource> ctx) {
		ServerCommandSource source = ctx.getSource();
		MinecraftServer server = source.getServer();
		String message = StringArgumentType.getString(ctx, "message");
		String palName = CONFIG.palName;

		// Echo what the player said, so the exchange reads like a conversation in chat.
		String speaker = source.getName();
		server.getPlayerManager().broadcast(
			Text.literal("<" + speaker + " → " + palName + "> " + message)
				.formatted(Formatting.GRAY), false);
		server.getPlayerManager().broadcast(
			Text.literal(palName + " is thinking...").formatted(Formatting.DARK_GRAY), false);

		// Async — the HTTP call never blocks the server thread; reply is posted back on it.
		AiClient.chat(CONFIG, message).thenAccept(reply ->
			server.execute(() ->
				server.getPlayerManager().broadcast(
					Text.literal("<" + palName + "> ").formatted(Formatting.AQUA)
						.append(Text.literal(reply).formatted(Formatting.WHITE)),
					false)));
		return 1;
	}
}
