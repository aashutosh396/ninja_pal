package com.marg.ninjapal;

import com.mojang.brigadier.context.CommandContext;
import net.fabricmc.api.ModInitializer;
import net.fabricmc.fabric.api.command.v2.CommandRegistrationCallback;
import net.minecraft.server.command.CommandManager;
import net.minecraft.server.command.ServerCommandSource;
import net.minecraft.server.network.ServerPlayerEntity;
import net.minecraft.server.world.ServerWorld;
import net.minecraft.text.Text;
import net.minecraft.util.math.BlockPos;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * Ninja Pal — Phase 1.
 * Registers a {@code /spawn} command that teleports the executing player to the
 * overworld (world) spawn point. AI integration comes later in Phase 2.
 */
public class NinjaPal implements ModInitializer {
	public static final String MOD_ID = "ninja_pal";
	public static final Logger LOGGER = LoggerFactory.getLogger(MOD_ID);

	@Override
	public void onInitialize() {
		CommandRegistrationCallback.EVENT.register((dispatcher, registryAccess, environment) ->
			dispatcher.register(CommandManager.literal("spawn").executes(NinjaPal::runSpawn))
		);
		LOGGER.info("[Ninja Pal] initialized — /spawn command registered.");
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
}
