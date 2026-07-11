const { Server } = require("socket.io");
const authenticateSocket = require("./authenticateSocket");
const registerRoomHandlers = require("./roomHandlers");
function initSocket(server) {
  const io = new Server(server, {
    // same-origin so cookies flow automatically; adjust if frontend is separate
    cors: { origin: true, credentials: true },
  });
  io.use(authenticateSocket);
  io.on("connection", (socket) => {
    registerRoomHandlers(io, socket);
  });
  return io;
}
module.exports = initSocket;