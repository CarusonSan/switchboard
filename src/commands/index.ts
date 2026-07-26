import { Collection } from 'discord.js';
import { server } from './server.js';
import type { Command } from './types.js';

export const commands = new Collection<string, Command>([[server.data.name, server]]);
