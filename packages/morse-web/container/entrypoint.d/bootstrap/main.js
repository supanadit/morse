// main.js — ezx bootstrap entrypoint for the Morse container.
//
// Two supervised nodes on a flat DAG: the OpenCode sidecar first, then the
// Morse host attached to it (see `MORSE_OPENCODE_URL`). pi needs no server —
// the host spawns one process per session. ezx stays PID 1 and never exec's
// away. No shell entrypoints — this file is the entrypoint.
const { fs, chain, log, process, env } = require("ezx");
const {
	MORSE_HOME,
	MORSE_LOGS,
	MORSE_RUN,
	MORSE_BACKUP,
	MORSE_PORT,
	MORSE_WORKSPACE_ROOT,
	MORSE_MULTIUSER,
	MORSE_OS_USERS,
	MORSE_SSH_PORT,
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
	// login, but the root itself belongs to the image contract. `0711` lets a
	// login traverse to their own directory without listing anyone else's.
	// Non-recursive on purpose: every home inside is `<user>:<user>` (the
	// server hands it over at login), and a recursive chown here would hand
	// them all back to the service account — locking each login out of its
	// own tree, SSH included — on every restart.
	if (MORSE_MULTIUSER && MORSE_WORKSPACE_ROOT) {
		fs.ensureDir(MORSE_WORKSPACE_ROOT, { mode: 0o711 });
		fs.chown(MORSE_WORKSPACE_ROOT, owner);
		fs.chmod(MORSE_WORKSPACE_ROOT, 0o711);
	}
	// sshd's privilege-separation directory: tmpfs, so it is recreated every boot.
	if (MORSE_OS_USERS) {
		fs.ensureDir("/run/sshd", { mode: 0o755 });
	}
}

/**
 * Replay the snapshotted login users before anything needs them: `/etc` is
 * container-local, so a recreate would otherwise wipe every login and
 * password while the homes survive (and fresh uid numbering would show other
 * members' names on your files). Best-effort by design — a failure only logs,
 * and the server still recreates a missing user on next web login.
 */
function restoreOsUsers() {
	if (!MORSE_OS_USERS) {
		return;
	}
	try {
		process.run({
			process: {
				binaryPath: "/opt/node/bin/node",
				arguments: ["/opt/morse/entrypoint.d/bootstrap/restore-os-users.js"],
			},
			timeout: 60e9,
			check: true,
		});
	} catch (error) {
		log.warn(`Could not replay OS users: ${error instanceof Error ? error.message : String(error)}`);
	}
}

/** The sidecar's Basic-auth secret, single-sourced: the operator's
 * `MORSE_OPENCODE_PASSWORD` feeds both the sidecar (`OPENCODE_SERVER_PASSWORD`)
 * and the host attaching to it, so the two can never disagree. 1.x ignored
 * server passwords entirely, which is why a missing link went unnoticed;
 * 2.x enforces it and rejects a host holding any other value. */
function sidecarSecret() {
	return env.get("MORSE_OPENCODE_PASSWORD", "");
}

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
		process: {
			binaryPath: MORSE_OPENCODE_BIN,
			arguments: ["serve", "--hostname", "127.0.0.1", "--port", String(OPENCODE_PORT)],
			user: APP_USER,
			group: APP_GROUP,
			// Explicit, not inherited: the quadlet only sets the Morse-side
			// secret, so without this the sidecar enforces whatever the
			// image (or a minted default) gave it instead.
			environment: ["OPENCODE_SERVER_PASSWORD=" + sidecarSecret()],
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

function sshNode() {
	// Direct SSH into your own workspace: one Linux user per Morse login,
	// homed at `/home/<username>`, password synced from Morse. Starts after
	// the server is ready so the host key it generates on boot exists.
	// Runs as root the way sshd must (it drops privileges per connection).
	const node = {
		name: "sshd",
		process: {
			binaryPath: "/usr/sbin/sshd",
			arguments: [
				"-D",
				"-p",
				String(MORSE_SSH_PORT),
				"-E",
				`${MORSE_LOGS}/sshd.log`,
				"-h",
				`${MORSE_HOME}/ssh/ssh_host_ed25519_key`,
				"-o",
				"PasswordAuthentication=yes",
				"-o",
				"PubkeyAuthentication=yes",
				// Homes are intentionally group-writable (2750 + default ACL: the
				// private group shares write under umask 002) and key files are
				// written by uid `morse` (the server), so stock StrictModes would
				// refuse every key and silently fall back to password. Off: the
				// fence itself is the protection StrictModes stands in for — a
				// private group per user, `0711` root, no cross-home writes.
				"-o",
				"StrictModes=no",
				"-o",
				"PermitRootLogin=no",
				"-o",
				"ChallengeResponseAuthentication=no",
				"-o",
				"X11Forwarding=no",
			],
		},
		files: [],
		forwardSignals: ["SIGTERM", "SIGINT"],
		shutdown: { timeout: 10e9, forceKill: true },
		dependsOnEdges: [{ name: "morse", waitFor: "ready" }],
	};
	node.readiness = {
		type: "exec",
		exec: [
			"/opt/node/bin/node",
			"-e",
			`require("net").connect(${JSON.stringify(Number(MORSE_SSH_PORT))}, "127.0.0.1").on("connect", function () { this.end(); process.exit(0); }).on("error", function () { process.exit(1); })`,
		],
		interval: 2e9,
		timeout: 5e9,
		maxAttempts: 60,
	};
	node.health = { readyProbe: node.readiness };
	return node;
}

function main() {
	if (!validateEnvironment()) {
		throw new Error("Invalid container environment");
	}
	setupDirectories();
	restoreOsUsers();
	const nodes = [opencodeNode(), morseNode()];
	if (MORSE_OS_USERS) {
		nodes.push(sshNode());
	}
	chain.run({ nodes });
	log.info("Entrypoint complete");
}

main();
