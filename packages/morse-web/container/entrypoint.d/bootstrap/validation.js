// validation.js — fail fast on a misconfigured container. Mirrors the
// postgresql container's validation module: every refusal names the variable
// to set, so the fix is in the quadlet, not in the logs.
const { log } = require("ezx");
const {
	MORSE_MULTIUSER,
	MORSE_PG_HOST,
	MORSE_PG_USER,
	MORSE_PG_PASSWORD,
	MORSE_PG_DATABASE,
	MORSE_PORT,
	MORSE_OPENCODE_BIN,
} = require("./env");
const { env } = require("ezx");

function validateEnvironment() {
	const port = Number.parseInt(MORSE_PORT, 10);
	if (!Number.isInteger(port) || port < 1 || port > 65535) {
		log.error(`MORSE_PORT must be a port number, got ${JSON.stringify(MORSE_PORT)}.`);
		return false;
	}
	if (!MORSE_MULTIUSER) {
		log.warn("MORSE_MULTIUSER is off: every browser shares one session index.");
		return true;
	}
	if (!env.get("MORSE_OPENCODE_PASSWORD", "")) {
		log.error("The OpenCode sidecar needs MORSE_OPENCODE_PASSWORD (its loopback Basic secret).");
		return false;
	}
	if (!MORSE_OPENCODE_BIN) {
		log.error("MORSE_OPENCODE_BIN is not set: the sidecar has no binary to run.");
		return false;
	}
	const missing = [];
	if (!MORSE_PG_HOST) missing.push("MORSE_PG_HOST");
	if (!MORSE_PG_USER) missing.push("MORSE_PG_USER");
	if (!MORSE_PG_PASSWORD) missing.push("MORSE_PG_PASSWORD");
	if (!MORSE_PG_DATABASE) missing.push("MORSE_PG_DATABASE");
	if (missing.length > 0) {
		log.error(`Multi-user mode needs PostgreSQL: ${missing.join(", ")} not set.`);
		return false;
	}
	return true;
}

module.exports = { validateEnvironment };
