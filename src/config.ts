import 'dotenv/config';
import { z } from 'zod';
import { games } from './games.js';

const schema = z.object({
  DISCORD_TOKEN: z.string().min(1, 'DISCORD_TOKEN is required'),
  DISCORD_CLIENT_ID: z.string().min(1, 'DISCORD_CLIENT_ID is required'),
  /** If set, slash commands are registered to this guild only (instant updates, good for dev). */
  DISCORD_GUILD_ID: z.string().optional(),
  DOCKER_SOCKET: z.string().default('/var/run/docker.sock'),
  /** Public hostname/IP of the VPS, shown to players in connect info. */
  PUBLIC_HOST: z.string().optional(),
  /**
   * Warm pool sizes as "game=count" pairs, e.g. "minecraft=1,valheim=1".
   * Warm servers are kept booted and handed over instantly on /server create.
   * Each one holds its full RAM footprint, so size this to your VPS.
   */
  WARM_POOL: z.string().default(''),
  /** Auto-stop servers whose CPU stays below IDLE_CPU_PERCENT for this many minutes. 0 disables. */
  IDLE_MINUTES: z.coerce.number().int().min(0).default(30),
  IDLE_CPU_PERCENT: z.coerce.number().min(0).max(100).default(5),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error('Invalid configuration:');
  for (const issue of parsed.error.issues) {
    console.error(`  ${issue.path.join('.')}: ${issue.message}`);
  }
  process.exit(1);
}

export const config = parsed.data;

export const warmPoolSizes: Record<string, number> = {};
for (const entry of config.WARM_POOL.split(',').map((s) => s.trim()).filter(Boolean)) {
  const [game, count] = entry.split('=');
  const size = Number(count);
  if (!game || !(game in games) || !Number.isInteger(size) || size < 0) {
    console.error(
      `Invalid WARM_POOL entry "${entry}" — expected <game>=<count> with game one of: ${Object.keys(games).join(', ')}`,
    );
    process.exit(1);
  }
  warmPoolSizes[game] = size;
}
