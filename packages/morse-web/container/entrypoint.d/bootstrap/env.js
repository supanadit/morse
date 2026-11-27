// env.js — shared environment defaults for the Morse container.
// Reads the container environment once and exports the constants used across
// the bootstrap modules. Single source of truth: change a default here, not
// in every file. Every knob is also settable from the quadlet / compose file.
const { env } = require("ezx");

// Directories (volumes in the quadlet).
const MORSE_HOME = env.get("MORSE_HOME", "/opt/containers/data");
const MORSE_CONFIG = env.get("MORSE_CONFIG", "/opt/containers/config");
const MORSE_LOGS = env.get("MORSE_LOGS", "/opt/containers/logs");
const MORSE_RUN = env.get("MORSE_RUN", "/opt/containers/run");
const MORSE_BACKUP = env.get("MORSE_BACKUP", "/opt/containers/backup");

// Server bind.
const MORSE_HOST = env.get("MORSE_HOST", "0.0.0.0");
const MORSE_PORT = env.get("MORSE_PORT", "4399");

// Multi-user (the container's reason to exist): on by default here, unlike the
// npm install where single-user is the default. The login gate, per-user
// session index and admin surface all follow this one flag.
const MORSE_MULTIUSER = env.bool("MORSE_MULTIUSER", true);

// Per-user workspace fence: each login user works under
// `<MORSE_WORKSPACE_ROOT>/<username>`. Unset disables fencing (one shared
// workspace, like the host install).
const MORSE_WORKSPACE_ROOT = env.get("MORSE_WORKSPACE_ROOT", "/workspaces");

// Postgres session index (the shared `postgresql` container on the same
// podman network answers at `postgresql:5432`).
const MORSE_PG_HOST = env.get("MORSE_PG_HOST", "postgresql");
const MORSE_PG_PORT = env.get("MORSE_PG_PORT", "5432");
const MORSE_PG_USER = env.get("MORSE_PG_USER", "postgres");
const MORSE_PG_PASSWORD = env.get("MORSE_PG_PASSWORD");
const MORSE_PG_DATABASE = env.get("MORSE_PG_DATABASE", "morse");

// Engines (baked into the image; overridable for testing).
const MORSE_PI_PATH = env.get("MORSE_PI_PATH", "/opt/engines/bin/pi");
const MORSE_OPENCODE_BIN = env.get("MORSE_OPENCODE_BIN", "/opt/engines/opencode/opencode");
const MORSE_ENGINE = env.get("MORSE_ENGINE", "");

// Real OS users for every login (`useradd` + SSH): on in this image, off on
// host installs. Each login becomes a Linux user homed at
// `/home/<username>` (a symlink into the workspaces volume) with the Morse
// password, provisioned by the server on first login.
const MORSE_OS_USERS = env.bool("MORSE_OS_USERS", true);

// SSH into your own workspace: loopback-only in the quadlet, like `:4399`.
const MORSE_SSH_PORT = env.get("MORSE_SSH_PORT", "2222");

// The application user the server (and every engine it spawns) runs as. ezx
// stays PID 1; this is the privilege drop, mirroring the postgres container's
// `process.user`/`process.group` nodes.
const APP_USER = env.get("MORSE_USER", "morse");
const APP_GROUP = env.get("MORSE_GROUP", "morse");

module.exports = {
	MORSE_HOME,
	MORSE_CONFIG,
	MORSE_LOGS,
	MORSE_RUN,
	MORSE_BACKUP,
	MORSE_HOST,
	MORSE_PORT,
	MORSE_MULTIUSER,
	MORSE_OS_USERS,
	MORSE_SSH_PORT,
	MORSE_WORKSPACE_ROOT,
	MORSE_PG_HOST,
	MORSE_PG_PORT,
	MORSE_PG_USER,
	MORSE_PG_PASSWORD,
	MORSE_PG_DATABASE,
	MORSE_PI_PATH,
	MORSE_OPENCODE_BIN,
	MORSE_ENGINE,
	APP_USER,
	APP_GROUP,
};
