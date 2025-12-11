// Path: src/app.ts
// ─────────────────────────────────────────────────────────────────────────────
// Thin bootstrap file
// - Delegates all heavy lifting to AppServer (HTTP + Socket + Routes)
// - Keeps entrypoint simple and focused
// ─────────────────────────────────────────────────────────────────────────────

import { AppServer } from './core/app-server.core';

const server: AppServer = new AppServer();

// Port resolution is handled inside AppServer.listen()
// (uses APP_PORT from env or falls back to 3000)
server.listen();
