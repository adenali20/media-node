const mediasoup = require('mediasoup');
const express = require('express');
const { Server } = require('socket.io');
const http = require('http');
const { log } = require('console');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

let worker;
const rooms = new Map(); 
const consumers = new Map();

const mediaCodecs = [
  { kind: 'audio', mimeType: 'audio/opus', clockRate: 48000, channels: 2 },
  { kind: 'video', mimeType: 'video/VP8', clockRate: 90000 }
];

(async () => {
  worker = await mediasoup.createWorker({
    rtcMinPort: 40000,
    rtcMaxPort: 49999,
  });
  console.log('Mediasoup Worker Ready');
})();

io.on('connection', (socket) => {
  socket.on('joinRoom', async ({ roomId }, callback) => {
    const room = await getOrCreateRoom(roomId);
    socket.join(roomId);
    socket.roomId = roomId;
    const existingProducers = room.producers.map(p => p.id);
    callback({ rtpCapabilities: room.router.rtpCapabilities, existingProducers });
  });

  socket.on('createWebRtcTransport', async ({ sender }, callback) => {
    const room = rooms.get(socket.roomId);
    const transport = await room.router.createWebRtcTransport({
      listenIps: [{ ip: '0.0.0.0', announcedIp: '192.168.0.105' }], 
      enableUdp: true, enableTcp: true, preferUdp: true,
    });

    socket.transports = socket.transports || new Map();
    socket.transports.set(transport.id, transport);

    callback({
      params: {
        id: transport.id,
        iceParameters: transport.iceParameters,
        iceCandidates: transport.iceCandidates,
        dtlsParameters: transport.dtlsParameters,
      }
    });
  });

  socket.on('connectTransport', async ({ transportId, dtlsParameters }, callback) => {
    const transport = socket.transports?.get(transportId);
    if (transport) await transport.connect({ dtlsParameters });
    callback();
  });

  socket.on('produce', async ({ transportId, kind, rtpParameters }, callback) => {
    const transport = socket.transports.get(transportId);
    const producer = await transport.produce({ kind, rtpParameters });
    const room = rooms.get(socket.roomId);

    room.producers.push({ id: producer.id, socketId: socket.id });
    socket.to(socket.roomId).emit('newProducer', { producerId: producer.id });
    
    callback({ id: producer.id });
  });

  socket.on('consume', async ({ rtpCapabilities, remoteProducerId, transportId }, callback) => {
    const room = rooms.get(socket.roomId);
    const transport = socket.transports.get(transportId);

    if (room.router.canConsume({ producerId: remoteProducerId, rtpCapabilities })) {
      const consumer = await transport.consume({
        producerId: remoteProducerId,
        rtpCapabilities,
        paused: true,
      });

      consumers.set(consumer.id, consumer);
      callback({
        params: {
          id: consumer.id,
          producerId: remoteProducerId,
          kind: consumer.kind,
          rtpParameters: consumer.rtpParameters,
        }
      });
    }
  });

  socket.on('consumerResume', async ({ consumerId }) => {
    log('Resuming consumer', consumerId);
    const consumer = consumers.get(consumerId);
    if (consumer) await consumer.resume();
  });

  socket.on('disconnect', () => {
    if (socket.roomId && rooms.has(socket.roomId)) {
        const room = rooms.get(socket.roomId);
        room.producers = room.producers.filter(p => p.socketId !== socket.id);
    }
  });
});

async function getOrCreateRoom(roomId) {
  if (!rooms.has(roomId)) {
    const router = await worker.createRouter({ mediaCodecs });
    rooms.set(roomId, { router, producers: [] });
  }
  return rooms.get(roomId);
}

server.listen(3002, () => console.log('Media Node running on port 3002'));
