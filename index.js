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
app.use('/api/rooms', require('./routes/rooms'));

const path = require("path");
const PUBLIC_DIR = path.join(__dirname, "public");
app.use(express.static(PUBLIC_DIR));
const page = (file) => (req, res) =>
    res.sendFile(path.join(PUBLIC_DIR, file));

// Pages
app.get("/",       page("index.html"));
app.get("/auth",   page("auth.html"));
// Redirect shortcuts (replaces your Next.js redirect 'pages')
app.get("/login",           (req, res) => res.redirect("/auth?mode=login"));
app.get("/register",        (req, res) => res.redirect("/auth?mode=register"));
app.get("/forgot-password", (req, res) => res.redirect("/auth?mode=forgotPassword"));
// Reset password — same HTML serves both; the page JS detects a missing
// token and shows the "please use the link from your email" message.
app.get(["/reset-password", "/reset-password/:token"], page("reset-password.html"));
app.get("/verify-email", page("verify-email.html"));
app.get('/dashboard', /* requireAuth, */ (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});
app.get('/room/:roomId', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'room.html'));
});

// Socket.IO setup
const server = http.createServer(app);       // <-- wrap express
const initSocket = require("./socket");       // our socket bootstrap
initSocket(server);


//  PORT CONFIGURATION
const SERVER_PORT = process.env.SERVER_PORT || 5000;
const FRONTEND_URL = process.env.FRONTEND_URL || `http://localhost:3000`;

server.listen(SERVER_PORT, () => console.log(`Server running on port ${SERVER_PORT}`));
