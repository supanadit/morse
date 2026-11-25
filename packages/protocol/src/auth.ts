/**
 * Login for multi-user Morse, shared by the NestJS host and the browser
 * frontend so the two agree without a round trip.
 *
 * The host closes an unauthenticated WebSocket upgrade with this code (not
 * 1008: that means "bad credentials" and the frontend must not retry it as a
 * drop). The frontend answers by showing login instead of reconnecting.
 */
export const LOGIN_REQUIRED_CLOSE_CODE = 4401;
