// Smoke test: drive the NestJS host exactly like the Angular frontend does.
import { WebSocket } from 'ws';
import { PROTOCOL_VERSION } from '@morse/protocol';

const url = process.argv[2] ?? 'ws://127.0.0.1:4399/ws';
const socket = new WebSocket(url);

const send = (message) => socket.send(JSON.stringify(message));

socket.on('open', () => {
  console.log('socket open ->', url);
  send({
    type: 'client/ready',
    payload: { protocolVersion: PROTOCOL_VERSION, frontend: { name: 'ws-smoke', version: '1.0.0' } },
  });
  send({ type: 'session/list', payload: {} });
});

socket.on('message', (data) => {
  const message = JSON.parse(data.toString());
  switch (message.type) {
    case 'host/ready':
      console.log(
        'host/ready agentReady=%s agentError=%s models=%d thinkingLevels=%s workspace=%s',
        message.payload.state.agentReady,
        message.payload.state.agentError ?? '-',
        message.payload.state.availableModels.length,
        message.payload.state.availableThinkingLevels.join('/'),
        message.payload.state.workspace.cwd,
      );
      break;
    case 'session/state':
      console.log(
        'session/state ready=%s streaming=%s model=%s',
        message.payload.agentReady,
        message.payload.streaming,
        message.payload.model ? `${message.payload.model.provider}/${message.payload.model.id}` : '-',
      );
      break;
    case 'session/list':
      console.log('session/list count=%d', message.payload.sessions.length);
      break;
    case 'transcript/append':
      console.log('item.%s %s', message.payload.kind, preview(message.payload));
      break;
    case 'transcript/delta':
      break;
    case 'notice':
    case 'error':
      console.log('%s: %s', message.type, message.payload.text ?? message.payload.message);
      break;
    default:
      console.log('<-', message.type);
  }
});

socket.on('close', () => console.log('socket closed'));

setTimeout(() => {
  socket.close();
  process.exit(0);
}, Number(process.env.SMOKE_MS ?? 9000));

function preview(item) {
  const text = item.text ?? item.title ?? '';
  return JSON.stringify(text.slice(0, 90));
}
