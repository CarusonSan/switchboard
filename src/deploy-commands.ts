import { REST, Routes } from 'discord.js';
import { commands } from './commands/index.js';
import { config } from './config.js';

const body = commands.map((command) => command.data.toJSON());
const rest = new REST().setToken(config.DISCORD_TOKEN);

const route = config.DISCORD_GUILD_ID
  ? Routes.applicationGuildCommands(config.DISCORD_CLIENT_ID, config.DISCORD_GUILD_ID)
  : Routes.applicationCommands(config.DISCORD_CLIENT_ID);

console.log(
  config.DISCORD_GUILD_ID
    ? `Registering ${body.length} command(s) to guild ${config.DISCORD_GUILD_ID}...`
    : `Registering ${body.length} command(s) globally (may take up to an hour to propagate)...`,
);

await rest.put(route, { body });
console.log('Done.');
