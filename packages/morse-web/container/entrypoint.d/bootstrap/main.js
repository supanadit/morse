// main.js — ezx bootstrap entrypoint for the Morse container.
//
// Two supervised nodes on a flat DAG: the OpenCode sidecar first, then the
// Morse host attached to it (see `MORSE_OPENCODE_URL`). pi needs no server —
// the host spawns one process per session. ezx stays PID 1 and never exec's
// away. No shell entrypoints — this file is the entrypoint.
const { fs, chain, log } = require("ezx");
const {
	MORSE_HOME,
	MORSE_LOGS,
	MORSE_RUN,
	MORSE_BACKUP,
	MORSE_PORT,
	MORSE_WORKSPACE_ROOT,
	MORSE_MULTIUSER,
	MORSE_OPENCODE_BIN,
	APP_USER,
	APP_GROUP,
} = require("./env");
const { validateEnvironment } = require("./validation");

const OPENCODE_PORT = 4096;
const OPENCODE_URL = `http://127.0.0.1:${OPENCODE_PORT}`;

function setupDirectories() {
	const owner = APP_USER + ":" + APP_GROUP;
	// Volume mounts land root-owned on first use; the image bakes the same
	// paths, so this only repairs fresh volumes (mirrors the postgres
	// container's 01-directories step).
	for (const dir of [MORSE_HOME, MORSE_LOGS, MORSE_RUN, MORSE_BACKUP]) {
		fs.ensureDir(dir, { mode: 0o755 });
		fs.chmod(dir, 0o755);
		fs.chownRecursive(dir, owner);
	}
	// Per-user workspace fence: the host creates `<root>/<username>` on first
	// login, but the root itself belongs to the image contract.
	if (MORSE_MULTIUSER && MORSE_WORKSPACE_ROOT) {
		fs.ensureDir(MORSE_WORKSPACE_ROOT, { mode: 0o755 });
		fs.chownRecursive(MORSE_WORKSPACE_ROOT, owner);
	}
}

/** The sidecar's Basic-auth secret: operator-set, or minted per boot. Nodes
 * inherit the bootstrap's environment (like every ezx process tree), so this
 * one assignment feeds both the sidecar and the host attaching to it. Only
 * `require("ezx")` modules exist here (no node: builtins), so the mint is
 * Math-based: it only guards the container-loopback sidecar. */


function probe(url, maxAttempts) {
	return {
		type: "exec",
		exec: [
			"/opt/node/bin/node",
			"-e",
			`fetch('${url}').then((r) => { if (!r.ok) process.exit(1); }).catch(() => process.exit(1))`,
		],
		interval: 2e9,
		timeout: 5e9,
		maxAttempts,
	};
}

function opencodeNode() {
	const node = {
		name: "opencode",
		// OPENCODE_SERVER_PASSWORD is inherited from the container environment
		// (required — see validation): same value the host attaches with.
		process: {
			binaryPath: MORSE_OPENCODE_BIN,
			arguments: ["serve", "--hostname", "127.0.0.1", "--port", String(OPENCODE_PORT)],
			user: APP_USER,
			group: APP_GROUP,
		},
		files: [],
		forwardSignals: ["SIGTERM", "SIGINT"],
		shutdown: { timeout: 10e9, forceKill: true },
	};
	node.readiness = probe(`${OPENCODE_URL}/doc`, 60);
	node.health = { readyProbe: node.readiness };
	return node;
}

function morseNode() {
	const node = {
		name: "morse",
		// MORSE_OPENCODE_URL/_PASSWORD are inherited from the container
		// environment: attach mode, no owned-mode announcement parsing.
		process: {
			binaryPath: "/opt/node/bin/node",
			arguments: ["/opt/morse/server.mjs"],
			user: APP_USER,
			group: APP_GROUP,
		},
		files: [],
		forwardSignals: ["SIGTERM", "SIGINT"],
		// Give live pi processes a grace period before the host is killed.
		shutdown: { timeout: 30e9, forceKill: true },
		dependsOnEdges: [{ name: "opencode", waitFor: "ready" }],
	};
	// Readiness gates dependents the way pg_isready gates the postgres DAG:
	// the HTTP probe the quadlet healthcheck also curls.
	node.readiness = probe(`http://127.0.0.1:${MORSE_PORT}/api/health`, 60);
	node.health = { readyProbe: node.readiness };
	return node;
}

function main() {
	if (!validateEnvironment()) {
		throw new Error("Invalid container environment");
	}
	setupDirectories();
	chain.run({ nodes: [opencodeNode(), morseNode()] });
	log.info("Entrypoint complete");
}

main();
