import net from 'node:net';

const LISTEN_HOST = process.env.MUY_DB_PROXY_HOST || '127.0.0.1';
const LISTEN_PORT = Number(process.env.MUY_DB_PROXY_PORT || 15432);
const TARGET_HOST = process.env.MUY_DB_TARGET_HOST || '172.19.0.3';
const TARGET_PORT = Number(process.env.MUY_DB_TARGET_PORT || 5432);

const server = net.createServer((client) => {
  const upstream = net.connect({ host: TARGET_HOST, port: TARGET_PORT });
  client.pipe(upstream);
  upstream.pipe(client);
  const close = () => { client.destroy(); upstream.destroy(); };
  client.on('error', close);
  upstream.on('error', close);
});

server.listen(LISTEN_PORT, LISTEN_HOST, () => {
  console.log(`Muy DB proxy listening on ${LISTEN_HOST}:${LISTEN_PORT} -> ${TARGET_HOST}:${TARGET_PORT}`);
});
