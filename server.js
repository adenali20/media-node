const mediasoup = require('mediasoup');
const express = require('express');
const { Server } = require('socket.io');
const http = require('http');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

let worker;
const rooms = new Map(); 
const consumers = new Map();

const mediaCodecs = [
  { kind: 'audio', mimeType: 'audio/opus', clockRate: 48000, channels: 2 },
  { 
    kind: 'video', 
    mimeType: 'video/VP8', 
    clockRate: 90000, 
    parameters: { 'x-google-start-bitrate': 1000 } 
  }
];

(async () => {
  worker = await mediasoup.createWorker({
    rtcMinPort: 40000,
    rtcMaxPort: 49999,
  });
  console.log('Mediasoup Worker Ready');
})();

io.on('connection', (socket) => {
  socket.on('joinRoom', async ({ roomId, username }, callback) => {
    const room = await getOrCreateRoom(roomId);
    socket.join(roomId);
    socket.roomId = roomId;
    socket.username = username;
    const existingProducers = room.producers.map(p => ({ id: p.id, username: p.username }));
    callback({ rtpCapabilities: room.router.rtpCapabilities, existingProducers });
  });

  socket.on('createWebRtcTransport', async ({ sender }, callback) => {
    const room = rooms.get(socket.roomId);
    const transport = await room.router.createWebRtcTransport({
      listenIps: [{ ip: '0.0.0.0', announcedIp: '142.93.204.148' }],
      enableUdp: true,
      enableTcp: true,
      preferUdp: true,
    });

    socket.transports = socket.transports || new Map();
    socket.transports.set(transport.id, transport);
    callback({ params: { id: transport.id, iceParameters: transport.iceParameters, iceCandidates: transport.iceCandidates, dtlsParameters: transport.dtlsParameters } });
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

    if (kind === 'audio') {
        room.audioLevelObserver.addProducer({ producerId: producer.id });
    }

    room.producers.push({ id: producer.id, producer, socketId: socket.id, username: socket.username });
    socket.to(socket.roomId).emit('newProducer', { producerId: producer.id, username: socket.username });
    callback({ id: producer.id });
  });

  // NEW: Handle Mute/Unmute and Video Hide/Show broadcasts
  socket.on('toggleMedia', ({ kind, isPaused }) => {
    console.log(`User ${socket.username} toggled ${kind}. Paused: ${isPaused}`);
    // Broadcast to everyone else in the room to update their UI
    socket.to(socket.roomId).emit('peerLayerUpdate', { 
        username: socket.username, 
        kind, 
        isPaused 
    });
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
      callback({ params: { id: consumer.id, producerId: remoteProducerId, kind: consumer.kind, rtpParameters: consumer.rtpParameters } });
    }
  });

  socket.on('consumerResume', async ({ consumerId }) => {
    const consumer = consumers.get(consumerId);
    if (consumer) await consumer.resume();
  });

  socket.on('disconnect', () => {
    if (socket.roomId && rooms.has(socket.roomId)) {
      const room = rooms.get(socket.roomId);
      const userProducers = room.producers.filter(p => p.socketId === socket.id);
      userProducers.forEach(p => {
        p.producer.close();
        socket.to(socket.roomId).emit('producerClosed', { producerId: p.id });
      });
      room.producers = room.producers.filter(p => p.socketId !== socket.id);
    }
  });
});

async function getOrCreateRoom(roomId) {
  if (!rooms.has(roomId)) {
    const router = await worker.createRouter({ mediaCodecs });
    const audioLevelObserver = await router.createAudioLevelObserver({ interval: 400, threshold: -70 });
    
    audioLevelObserver.on('volumes', (volumes) => {
        const { producer } = volumes[0]; 
        io.to(roomId).emit('activeSpeaker', { producerId: producer.id });
    });

    audioLevelObserver.on('silence', () => {
        io.to(roomId).emit('activeSpeaker', { producerId: null });
    });

    rooms.set(roomId, { router, producers: [], audioLevelObserver });
  }
  return rooms.get(roomId);
}

server.listen(3002, () => console.log('Media Node running on port 3002'));
