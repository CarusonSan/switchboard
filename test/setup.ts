// config.ts validates env at import time and exits the process on failure, so
// every test file needs these set before it imports anything from src/.
process.env.DISCORD_TOKEN ??= "test-token";
process.env.DISCORD_CLIENT_ID ??= "test-client-id";
process.env.WARM_POOL ??= "";
// Force-set (a developer .env must not change test behavior — dotenv never
// overrides variables that are already set).
process.env.IDLE_MINUTES = "3";
process.env.IDLE_CPU_PERCENT = "5";
