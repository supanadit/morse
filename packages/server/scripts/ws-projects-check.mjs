// Verifies multi-project / multi-session behaviour against a running host:
// opens a session in a second project, then switches back — both sessions stay
// hot at once, and switching reuses the existing process.
//
//   node packages/server/scripts/ws-projects-check.mjs [ws://127.0.0.1:4399/ws]
import { WebSocket } from 'ws';
import { PROTOCOL_VERSION } from '@morse/protocol';

const url = process.argv[2] ?? 'ws://127.0.0.1:4399/ws';

const client = await open();
const ready = await client.next('host/ready');
console.log('host/ready  protocol=%d workspace=%s', ready.payload.protocolVersion, ready.payload.state.workspace.cwd);

const projects = await client.next('project/list');
console.log('projects: %d', projects.payload.projects.length);
for (const project of projects.payload.projects.slice(0, 6)) {
  console.log('  %s  (%d sessions)', project.path, project.sessionCount);
}

const first = await client.stateWhen((state) => state.agentReady === true);
console.log('session #1  %s  (%s)', short(first.sessionId), first.workspace.cwd);

const target = projects.payload.projects.find(
  (project) => project.path !== first.workspace.cwd && project.sessionCount > 0,
);
if (!target) {
  console.error('need at least one other project with sessions to test with');
  process.exit(2);
}

client.send({ type: 'project/open', payload: { path: target.path } });
const second = await client.stateWhen(
  (state) => state.agentReady === true && state.workspace.cwd === target.path,
);
console.log('session #2  %s  (%s)', short(second.sessionId), second.workspace.cwd);

client.send({
  type: 'session/activate',
  payload: { sessionId: first.sessionId, cwd: first.workspace.cwd },
});
const backAgain = await client.stateWhen((state) => state.sessionId === first.sessionId);
console.log('switched back to %s', short(backAgain.sessionId));

const distinct = second.sessionId !== first.sessionId;
console.log(distinct ? 'OK: two sessions in two projects' : 'FAIL: both projects share a session');
console.log(
  backAgain.sessionId === first.sessionId
    ? 'OK: switching reused the earlier session'
    : 'FAIL: switching did not return to the earlier session',
);

client.close();
process.exit(distinct && backAgain.sessionId === first.sessionId ? 0 : 1);

function short(id) {
  if (!id) {
    return '(none)';
  }
  const parts = id.split('/');
  return parts.at(-1) ?? id;
}

async function open() {
  const socket = new WebSocket(url);
  const inbox = [];
  const waiters = [];
  let lastState;

  socket.on('message', (data) => {
    const message = JSON.parse(data.toString());
    if (message.type === 'host/ready') {
      lastState = message.payload.state;
    } else if (message.type === 'session/state') {
      lastState = message.payload;
    }
    inbox.push(message);
    for (const waiter of [...waiters]) {
      if (waiter.match(message)) {
        waiters.splice(waiters.indexOf(waiter), 1);
        waiter.resolve(message);
      }
    }
  });

  await new Promise((resolve, reject) => {
    socket.on('open', resolve);
    socket.on('error', reject);
  });
  socket.send(
    JSON.stringify({
      type: 'client/ready',
      payload: { protocolVersion: PROTOCOL_VERSION, frontend: { name: 'projects-check', version: '1' } },
    }),
  );

  const next = (type) => {
    const existing = inbox.find((message) => message.type === type);
    if (existing) {
      return Promise.resolve(existing);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout waiting for ${type}`)), 30_000);
      waiters.push({
        match: (message) => message.type === type,
        resolve: (message) => {
          clearTimeout(timer);
          resolve(message);
        },
      });
    });
  };

  const stateWhen = (predicate) => {
    if (lastState && predicate(lastState)) {
      return Promise.resolve(lastState);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timeout waiting for state')), 60_000);
      waiters.push({
        match: (message) =>
          (message.type === 'session/state' || message.type === 'host/ready') &&
          predicate(message.type === 'host/ready' ? message.payload.state : message.payload),
        resolve: (message) => {
          clearTimeout(timer);
          resolve(message.type === 'host/ready' ? message.payload.state : message.payload);
        },
      });
    });
  };

  return { send: (message) => socket.send(JSON.stringify(message)), next, stateWhen, close: () => socket.close() };
}
