const net = require('net');

const server = net.createServer((socket) => {
  const target = net.connect(5432, '192.168.87.241');
  socket.pipe(target).pipe(socket);
  socket.on('error', () => target.destroy());
  target.on('error', () => socket.destroy());
});

server.listen(5432, '127.0.0.1', () => {
  console.log('Postgres TCP proxy listening on 127.0.0.1:5432 -> 192.168.87.241:5432');
});
