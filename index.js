// LOAD ENV VARIABLES
require("dotenv").config();

// node libraries
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");
const cookieParser = require("cookie-parser");



// app modules
const connectDB = require("./db-init");
connectDB();

const app = express();
app.use(cors({
    origin: process.env.FRONTEND_URL, // frontend origin
    credentials: true, // allow cookies / credentials
}));

app.use(cookieParser());

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.set('trust proxy', true);

// Routes
app.use('/api/auth', require('./routes/auth'));


const server = http.createServer(app);

//  PORT CONFIGURATION
const SERVER_PORT = process.env.SERVER_PORT || 5000;
const FRONTEND_URL = process.env.FRONTEND_URL || `http://localhost:3000`;

const io = new Server(server, {
    cors: { origin: FRONTEND_URL },
});

io.on("connection", (socket) => {
    console.log("User connected:", socket.id);

    socket.on("join_room", (data) => {
        socket.join(data.roomId);
        console.log(`${socket.id} joined room ${data.roomId}`);
    });

    socket.on("send_message", (data) => {
        io.to(data.roomId).emit("receive_message", data);
    });

    socket.on("disconnect", () => {
        console.log("User disconnected:", socket.id);
    });
});

server.listen(SERVER_PORT, () => console.log(`Server running on port ${SERVER_PORT}`));