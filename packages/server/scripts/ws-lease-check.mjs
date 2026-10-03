// Verifies the NestJS session lease: a client that reconnects within
// MORSE_SESSION_GRACE_MS must reattach to the same pi session (and get its
// transcript back) instead of spawning a new `pi` process.
//
//   node packages/server/scripts/ws-lease-check.mjs [ws://127.0.0.1:4399/ws]
//   LEASE_PAUSE_MS=12000 node ...   # must report a NEW session (grace expired)
import { WebSocket } from 'ws';
import { PROTOCOL_VERSION } from '@morse/protocol';

const url = process.argv[2] ?? 'ws://127.0.0.1:4399/ws';
const pauseMs = Number(process.env.LEASE_PAUSE_MS ?? 1500);

const first = await handshake({ seedTranscript: true });
console.log(
  'connection #1 -> sessionId=%s model=%s items=%d',
  first.sessionId ?? '-',
  first.model ?? '-',
  first.items,
);

await new Promise((resolve) => setTimeout(resolve, pauseMs));
console.log('disconnected, waited %dms…', pauseMs);

const second = await handshake();
console.log(
  'connection #2 -> sessionId=%s model=%s items=%d',
  second.sessionId ?? '-',
  second.model ?? '-',
  second.items,
);

const reused = Boolean(first.sessionId) && first.sessionId === second.sessionId;
console.log(reused ? 'REUSED: same agent session' : 'NEW: a fresh agent session was spawned');
console.log(
  second.items > 0
    ? `TRANSCRIPT KEPT: ${second.items} item(s) replayed to the reconnected client`
    : 'TRANSCRIPT EMPTY: nothing replayed (expected when the session was retired)',
);

process.exit(reused && second.items > 0 ? 0 : 1);

function handshake({ seedTranscript = false } = {}) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    let state;
    let items = 0;
    let seeded = false;
    let settled = false;

    const timer = setTimeout(() => {
      socket.close();
      reject(new Error('timed out waiting for a ready agent with a transcript'));
    }, 30_000);

    const ready = () =>
      state?.agentReady === true && (!seedTranscript || items > 0);

    const finish = () => {
      if (settled || !ready()) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      const { sessionId, model } = state;
      socket.close();
      resolve({
        sessionId,
        model: model ? `${model.provider}/${model.id}` : undefined,
        items,
      });
    };

    socket.on('open', () => {
      socket.send(
        JSON.stringify({
          type: 'client/ready',
          payload: { protocolVersion: PROTOCOL_VERSION, frontend: { name: 'lease-check', version: '1' } },
        }),
      );
    });

    socket.on('message', (data) => {
      const message = JSON.parse(data.toString());

      // `host/ready` now arrives immediately (agentStarting: true), so the state
      // that carries the session comes from `session/state`.
      if (message.type === 'host/ready') {
        state = message.payload.state;
      } else if (message.type === 'session/state') {
        state = message.payload;
      } else if (message.type === 'transcript/replace') {
        items = message.payload.items.length;
      } else if (message.type === 'transcript/append') {
        items += 1;
      }

      // Setting a bogus model makes the host record an error notice in the
      // transcript: a model-free way to prove that a reconnecting client gets
      // its history replayed.
      if (seedTranscript && !seeded && state?.agentReady === true) {
        seeded = true;
        socket.send(
          JSON.stringify({
            type: 'model/set',
            payload: { provider: 'morse-lease-check', id: 'does-not-exist' },
          }),
        );
      }

      finish();
    });

    socket.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}
