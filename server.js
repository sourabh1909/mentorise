require("dotenv").config();
const crypto = require("crypto");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const express = require("express");
const path = require("path");
const http = require("http");
const socketIO = require("socket.io");
const cookieParser = require("cookie-parser");

const { connectDB, Mentor, Mentee, Session, Chat, Message, Review, GroupSession, ActiveChat } = require("./db");
const { signupUser, loginUser } = require("./auth");
const { sendSessionAcceptedToMentee, sendSessionRejectedToMentee } = require("./mailer");

const app = express();
const port = process.env.PORT || 3000;
const server = http.createServer(app);
const io = socketIO(server);

connectDB();

// ─── Middleware ───────────────────────────────────────────────────────────────
app.set("views", path.join(__dirname, "views"));
app.set("view engine", "ejs");
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, "public")));

server.listen(port, () => {
  console.log("Server started on port " + port);
});

// ─── Health Check (keeps Render free tier alive via UptimeRobot) ──────────────
app.get("/health", (req, res) => {
  res.status(200).json({ status: "ok", uptime: process.uptime() });
});

// ─── Socket.IO ────────────────────────────────────────────────────────────────
io.on("connection", (socket) => {
  console.log("User connected:", socket.id);

  socket.on("join-chat", ({ roomId, userName }) => {
    socket.join(roomId);
    console.log(`${userName} joined room: ${roomId}`);
  });

  socket.on("send-message", async ({ roomId, message, sender, senderName, senderType }) => {
    try {
      const saved = await Message.create({
        chatId: roomId,
        senderId: sender,
        senderName,
        senderType: senderType || "mentee",
        content: message,
      });

      const unreadIncrement = {};
      if (senderType === "mentor") {
        unreadIncrement.unreadCountMentee = 1;
      } else {
        unreadIncrement.unreadCountMentor = 1;
      }

      await Chat.findOneAndUpdate(
        { chatId: roomId },
        {
          lastMessage: { content: message, senderId: sender, senderName, sentAt: saved.createdAt },
          lastActivity: new Date(),
          $inc: unreadIncrement,
        }
      );

      // Keep ActiveChat in sync with latest message & unread counts
      await ActiveChat.findOneAndUpdate(
        { chatId: roomId },
        {
          lastMessage: { content: message, senderId: sender, senderName, sentAt: saved.createdAt },
          lastActivity: new Date(),
          $inc: unreadIncrement,
        }
      );

      io.to(roomId).emit("receive-message", {
        _id: saved._id.toString(),
        message, sender, senderName,
        timestamp: saved.createdAt.toISOString(),
      });
    } catch (err) {
      console.error("send-message error:", err.message);
    }
  });

  socket.on("mark-read", async ({ roomId, readerId, readerType }) => {
    try {
      await Message.updateMany(
        { chatId: roomId, senderId: { $ne: readerId }, read: false },
        { read: true, readAt: new Date() }
      );
      const counterField = readerType === "mentor" ? "unreadCountMentor" : "unreadCountMentee";
      await Chat.findOneAndUpdate({ chatId: roomId }, { [counterField]: 0 });
      socket.to(roomId).emit("messages-read", { readerId });
    } catch (err) {
      console.error("mark-read error:", err.message);
    }
  });

  socket.on("join-video-room", ({ room, userId, userName }) => {
    socket.join(room);
    socket.data.videoRoom  = room;
    socket.data.videoUserId = userId;
    // Tell every OTHER socket in the room that a new peer arrived
    socket.to(room).emit("video-user-joined", { userId, userName, socketId: socket.id });
    // Tell the new joiner which peers are already in the room
    const roomSockets = io.sockets.adapter.rooms.get(room);
    const existingPeers = [];
    if (roomSockets) {
      for (const sid of roomSockets) {
        if (sid !== socket.id) {
          const peer = io.sockets.sockets.get(sid);
          if (peer) existingPeers.push({ socketId: sid, userId: peer.data.videoUserId, userName: peer.data.videoUserName });
        }
      }
    }
    socket.emit("video-room-peers", { peers: existingPeers });
    socket.data.videoUserName = userName;
  });

  // Route signals to a specific socket (targetSocketId) for full mesh
  socket.on("video-signal", ({ room, to, toSocketId, from, fromSocketId, type, sdp, candidate }) => {
    if (toSocketId) {
      // Group call: signal directly to the target socket
      io.to(toSocketId).emit("video-signal", { from, fromSocketId: socket.id, type, sdp, candidate });
    } else {
      // 1-on-1 fallback: broadcast to room
      socket.to(room).emit("video-signal", { from, fromSocketId: socket.id, type, sdp, candidate });
    }
  });

  socket.on("video-leave", ({ room, userId, socketId: leavingSocketId }) => {
    socket.to(room).emit("video-user-left", { userId, socketId: leavingSocketId || socket.id });
    socket.leave(room);
    socket.data.videoRoom = null;
  });

  socket.on("video-chat-msg", ({ room, sender, message }) => {
    socket.to(room).emit("video-chat-msg", { sender, message });
  });

  socket.on("disconnect", () => {
    if (socket.data.videoRoom) {
      socket.to(socket.data.videoRoom).emit("video-user-left", {
        userId: socket.data.videoUserId,
        socketId: socket.id,
      });
    }
    console.log("User disconnected:", socket.id);
  });
});

// ─── Page Routes ──────────────────────────────────────────────────────────────
app.get("/", (req, res) => res.redirect("/home"));
app.get("/home", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));
app.get("/login", (req, res) => res.sendFile(path.join(__dirname, "public", "Login.html")));
app.get("/signup", (req, res) => res.sendFile(path.join(__dirname, "public", "signup.html")));

// ─── Auth Routes ──────────────────────────────────────────────────────────────
app.post("/signup", async (req, res) => {
  const result = await signupUser(req.body);

  if (!result.success) {
    return res.status(400).send(result.message);
  }

  const { userId, userType } = result;
  const jwt = require("jsonwebtoken");
  const token = jwt.sign(
    { userId, userType },
    process.env.JWT_SECRET || "change_this_secret",
    { expiresIn: "7d" }
  );
  res.cookie("token", token, { httpOnly: true, maxAge: 7 * 24 * 60 * 60 * 1000 });

  return res.redirect(userType === "mentor" ? `/mentor-home/${userId}` : `/mentee-home/${userId}`);
});

app.post("/login", async (req, res) => {
  const { email, password } = req.body;
  const result = await loginUser(email, password);

  if (!result.success) {
    return res.status(400).send(result.message);
  }

  res.cookie("token", result.token, { httpOnly: true, maxAge: 7 * 24 * 60 * 60 * 1000 });
  return res.redirect(result.userType === "mentor" ? `/mentor-home/${result.userId}` : `/mentee-home/${result.userId}`);
});

app.post("/logout", (req, res) => {
  res.clearCookie("token");
  res.redirect("/login");
});

// ─── Forgot / Reset Password ──────────────────────────────────────────────────
app.post("/forgot-password", async (req, res) => {
  res.status(503).json({
    success: false,
    message: "Password reset via email is temporarily unavailable. Please contact support."
  });
});

app.get("/reset-password", (req, res) => res.redirect("/login"));
app.post("/reset-password", (req, res) => res.redirect("/login"));

// ─── Profile Routes ───────────────────────────────────────────────────────────
app.get("/mentor-profile/:id", async (req, res) => {
  try {
    const mentor = await Mentor.findById(req.params.id).lean();
    if (!mentor) return res.status(404).send("Mentor not found!");
    delete mentor.password;
    res.render("mentor-profile", { user: mentor, userId: req.params.id });
  } catch (error) {
    res.status(500).send("Server error");
  }
});

app.get("/mentee-profile/:id", async (req, res) => {
  try {
    const mentee = await Mentee.findById(req.params.id).lean();
    if (!mentee) return res.status(404).send("Mentee not found!");
    delete mentee.password;
    res.render("mentee-profile", { user: mentee, userId: req.params.id });
  } catch (error) {
    res.status(500).send("Server error");
  }
});

// ─── Home Routes ──────────────────────────────────────────────────────────────
app.get("/mentee-home/:id", async (req, res) => {
  try {
    const mentee = await Mentee.findById(req.params.id).lean();
    if (!mentee) return res.status(404).send("Mentee not found!");
    delete mentee.password;
    res.render("mentee-home", { user: mentee, userId: req.params.id });
  } catch (error) {
    res.status(500).send("Server error");
  }
});

app.get("/mentor-home/:id", async (req, res) => {
  try {
    const mentor = await Mentor.findById(req.params.id).lean();
    if (!mentor) return res.status(404).send("Mentor not found!");
    delete mentor.password;
    res.render("mentor-home", { user: mentor, userId: req.params.id });
  } catch (error) {
    res.status(500).send("Server error");
  }
});

// ─── Mentor Directory ─────────────────────────────────────────────────────────
app.get("/mentor-directory", async (req, res) => {
  try {
    const menteeId = typeof req.query.menteeId === "string" ? req.query.menteeId.trim() : "";
    const mentors = await Mentor.find({}, { password: 0 }).lean();
    const mentorsWithId = mentors.map((m) => ({ ...m, id: m._id.toString() }));
    res.render("mentor-directory", { mentors: mentorsWithId, menteeId });
  } catch (error) {
    res.status(500).send("Error loading mentors");
  }
});

// ─── Session Routes ───────────────────────────────────────────────────────────
app.post("/book-session", async (req, res) => {
  try {
    const { mentorId, menteeId, date, time, message } = req.body;
    const mentor = await Mentor.findById(mentorId).lean();
    const mentee = await Mentee.findById(menteeId).lean();
    if (!mentor || !mentee) return res.status(404).json({ success: false, message: "User not found" });

    const session = await Session.create({
      mentorId, menteeId,
      mentorName: `${mentor.firstName} ${mentor.lastName}`,
      menteeName: `${mentee.firstName} ${mentee.lastName}`,
      date, time, message: message || "", status: "pending",
    });

    res.json({ success: true, message: "Session request sent successfully!", sessionId: session._id.toString() });
  } catch (error) {
    res.status(500).json({ success: false, message: "Failed to book session" });
  }
});

app.get("/mentor-sessions/:mentorId", async (req, res) => {
  try {
    const sessions = await Session.find({ mentorId: req.params.mentorId }).lean();
    res.json({ success: true, sessions: sessions.map((s) => ({ ...s, id: s._id.toString() })) });
  } catch (error) {
    res.status(500).json({ success: false, message: "Failed to fetch sessions" });
  }
});

app.get("/mentee-sessions/:menteeId", async (req, res) => {
  try {
    const sessions = await Session.find({ menteeId: req.params.menteeId }).lean();
    res.json({ success: true, sessions: sessions.map((s) => ({ ...s, id: s._id.toString() })) });
  } catch (error) {
    res.status(500).json({ success: false, message: "Failed to fetch sessions" });
  }
});

// ── Update session: accepted/rejected — sends email to mentee ─────────────────
app.post("/update-session", async (req, res) => {
  try {
    const { sessionId, status } = req.body;
    const updateData = { status };
    if (status === "accepted") updateData.acceptedAt = new Date();
    if (status === "rejected") updateData.rejectedAt = new Date();

    await Session.findByIdAndUpdate(sessionId, updateData);
    const session = await Session.findById(sessionId).lean();
    const mentee  = await Mentee.findById(session.menteeId).lean();

    if (mentee && session) {
      if (status === "accepted") {
        await sendSessionAcceptedToMentee({
          menteeEmail: mentee.email,
          menteeName:  `${mentee.firstName} ${mentee.lastName}`,
          mentorName:  session.mentorName,
          date: session.date, time: session.time, sessionId,
        });
      } else if (status === "rejected") {
        await sendSessionRejectedToMentee({
          menteeEmail: mentee.email,
          menteeName:  `${mentee.firstName} ${mentee.lastName}`,
          mentorName:  session.mentorName,
          date: session.date, time: session.time,
        });
      }
    }

    // Notify mentee in real-time so their booking page updates without a refresh
    io.emit(`session-update-${session.menteeId.toString()}`, {
      sessionId,
      status,
      mentorName: session.mentorName,
    });
    // Also notify mentor's other tabs/windows
    io.emit(`session-update-${session.mentorId.toString()}`, {
      sessionId,
      status,
    });

    res.json({ success: true, message: `Session ${status} successfully!` });
  } catch (error) {
    console.error("Error updating session:", error);
    res.status(500).json({ success: false, message: "Failed to update session" });
  }
});

// ─── Booking Page Routes ──────────────────────────────────────────────────────
app.get("/my-bookings/:menteeId", async (req, res) => {
  try {
    const mentee = await Mentee.findById(req.params.menteeId).lean();
    if (!mentee) return res.status(404).send("Mentee not found!");
    res.render("my-bookings", { menteeId: req.params.menteeId });
  } catch (error) { res.status(500).send("Server error"); }
});

app.get("/view-requests/:mentorId", async (req, res) => {
  try {
    const mentor = await Mentor.findById(req.params.mentorId).lean();
    if (!mentor) return res.status(404).send("Mentor not found!");
    res.render("view-requests", { mentorId: req.params.mentorId });
  } catch (error) { res.status(500).send("Server error"); }
});

app.get("/mentor-bookings/:mentorId", async (req, res) => {
  try {
    const mentor = await Mentor.findById(req.params.mentorId).lean();
    if (!mentor) return res.status(404).send("Mentor not found!");
    res.render("mentor-bookings", { mentorId: req.params.mentorId });
  } catch (error) { res.status(500).send("Server error"); }
});

// ─── Chat Routes ──────────────────────────────────────────────────────────────
app.get("/chat/:currentUserId/:otherUserId", async (req, res) => {
  try {
    const { currentUserId, otherUserId } = req.params;
    const currentMentor = await Mentor.findById(currentUserId).lean();
    const currentMentee = await Mentee.findById(currentUserId).lean();
    const otherMentor   = await Mentor.findById(otherUserId).lean();
    const otherMentee   = await Mentee.findById(otherUserId).lean();
    const currentUserData = currentMentor || currentMentee;
    const otherUserData   = otherMentor   || otherMentee;
    if (!currentUserData || !otherUserData) return res.status(404).send("User not found!");

    const mentorData = currentMentor || otherMentor;
    const menteeData = currentMentee || otherMentee;
    const mentorId   = mentorData._id.toString();
    const menteeId   = menteeData._id.toString();
    const chatId     = `${mentorId}_${menteeId}`;

    await Chat.findOneAndUpdate(
      { chatId },
      {
        chatId, users: [mentorId, menteeId],
        mentor: { id: mentorId, name: `${mentorData.firstName} ${mentorData.lastName}` },
        mentee: { id: menteeId, name: `${menteeData.firstName} ${menteeData.lastName}` },
        lastActivity: new Date(),
      },
      { upsert: true, new: true }
    );

    // ── Keep ActiveChat in sync ──────────────────────────────────────────────
    await ActiveChat.findOneAndUpdate(
      { chatId },
      {
        chatId,
        mentorId, menteeId,
        mentorName: `${mentorData.firstName} ${mentorData.lastName}`,
        menteeName: `${menteeData.firstName} ${menteeData.lastName}`,
        mentorImg:  mentorData.img  || "",
        menteeImg:  menteeData.img  || "",
        isActive:   true,
        lastActivity: new Date(),
      },
      { upsert: true, new: true }
    );

    res.render("chat", {
      currentUserId,
      currentUserName: `${currentUserData.firstName} ${currentUserData.lastName}`,
      otherUserId,
      otherUserName: `${otherUserData.firstName} ${otherUserData.lastName}`,
      chatId,
    });
  } catch (error) {
    res.status(500).send("Server error");
  }
});

app.get("/chat-history/:chatId", async (req, res) => {
  try {
    const { chatId } = req.params;
    const page  = Math.max(1, parseInt(req.query.page) || 1);
    const limit = 50;
    const skip  = (page - 1) * limit;
    const messages = await Message.find({ chatId }).sort({ createdAt: 1 }).skip(skip).limit(limit).lean();
    const total = await Message.countDocuments({ chatId });
    res.json({
      success: true,
      messages: messages.map((m) => ({
        _id: m._id.toString(), senderId: m.senderId, senderName: m.senderName,
        senderType: m.senderType, content: m.content, read: m.read,
        timestamp: m.createdAt.toISOString(),
      })),
      page, totalPages: Math.ceil(total / limit), total,
    });
  } catch (error) {
    res.status(500).json({ success: false, message: "Failed to fetch chat history" });
  }
});

app.get("/mentor-chat-contacts/:mentorId", async (req, res) => {
  try {
    const chats = await Chat.find({ "mentor.id": req.params.mentorId }).sort({ lastActivity: -1 }).lean();
    res.json({ success: true, contacts: chats.map((c) => ({ id: c.mentee.id, name: c.mentee.name, chatId: c.chatId, lastMessage: c.lastMessage, unreadCount: c.unreadCountMentor })) });
  } catch (error) {
    res.status(500).json({ success: false, message: "Failed to fetch contacts" });
  }
});

app.get("/mentee-chat-contacts/:menteeId", async (req, res) => {
  try {
    const chats = await Chat.find({ "mentee.id": req.params.menteeId }).sort({ lastActivity: -1 }).lean();
    res.json({ success: true, contacts: chats.map((c) => ({ id: c.mentor.id, name: c.mentor.name, chatId: c.chatId, lastMessage: c.lastMessage, unreadCount: c.unreadCountMentee })) });
  } catch (error) {
    res.status(500).json({ success: false, message: "Failed to fetch contacts" });
  }
});

app.get("/mentor-chats/:mentorId", async (req, res) => {
  try {
    const mentor = await Mentor.findById(req.params.mentorId).lean();
    if (!mentor) return res.status(404).send("Mentor not found!");
    res.render("mentor-chats", { mentorId: req.params.mentorId });
  } catch (error) { res.status(500).send("Server error"); }
});

// ─── ActiveChat API Routes ─────────────────────────────────────────────────
// GET active chats for a mentor (sorted by most recent activity)
app.get("/active-chats/mentor/:mentorId", async (req, res) => {
  try {
    const chats = await ActiveChat.find({ mentorId: req.params.mentorId, isActive: true })
      .sort({ lastActivity: -1 }).lean();
    res.json({ success: true, chats: chats.map(c => ({ ...c, id: c._id.toString() })) });
  } catch (err) {
    res.status(500).json({ success: false, message: "Failed to fetch active chats." });
  }
});

// GET active chats for a mentee (sorted by most recent activity)
app.get("/active-chats/mentee/:menteeId", async (req, res) => {
  try {
    const chats = await ActiveChat.find({ menteeId: req.params.menteeId, isActive: true })
      .sort({ lastActivity: -1 }).lean();
    res.json({ success: true, chats: chats.map(c => ({ ...c, id: c._id.toString() })) });
  } catch (err) {
    res.status(500).json({ success: false, message: "Failed to fetch active chats." });
  }
});

// DELETE (archive) an active chat for either side
app.post("/active-chats/archive", async (req, res) => {
  try {
    const { chatId } = req.body;
    await ActiveChat.findOneAndUpdate({ chatId }, { isActive: false });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, message: "Failed to archive chat." });
  }
});

// ─── Video Call ───────────────────────────────────────────────────────────────
app.get("/video-call/:sessionId", async (req, res) => {
  try {
    const { sessionId } = req.params;
    const { userId } = req.query;
    const session = await Session.findById(sessionId).lean();
    if (!session) return res.status(404).send("Session not found!");
    if (session.status !== "accepted") return res.status(400).send("Session is not confirmed.");
    const isMentor = session.mentorId.toString() === userId;
    const isMentee = session.menteeId.toString() === userId;
    if (!isMentor && !isMentee) return res.status(403).send("Unauthorized.");
    res.render("video-call", {
      sessionId, currentUserId: userId,
      currentUserName: isMentor ? session.mentorName : session.menteeName,
      otherUserId: isMentor ? session.menteeId.toString() : session.mentorId.toString(),
      otherUserName: isMentor ? session.menteeName : session.mentorName,
      role: isMentor ? "mentor" : "mentee",
      redirectUrl: isMentor ? `/mentor-home/${session.mentorId}` : `/mentee-home/${session.menteeId}`,
      isGroupCall: false,
      groupParticipants: "[]",
    });
  } catch (error) {
    res.status(500).send("Server error");
  }
});

// ─── Analytics ────────────────────────────────────────────────────────────────
app.get("/mentor-analytics/:mentorId", async (req, res) => {
  try {
    const { mentorId } = req.params;
    const sessions = await Session.find({ mentorId }).lean();
    const total    = sessions.length;
    const accepted = sessions.filter(s => s.status === "accepted").length;
    const rejected = sessions.filter(s => s.status === "rejected").length;
    const decided  = accepted + rejected;
    const acceptanceRate = decided > 0 ? Math.round((accepted / decided) * 100) : 0;
    const messagesSent = await Message.countDocuments({ senderId: mentorId, senderType: "mentor" });
    const reviews = await Review.find({ mentorId }).lean();
    const totalReviews = reviews.length;
    const avgRating = totalReviews > 0 ? Math.round((reviews.reduce((s, r) => s + r.rating, 0) / totalReviews) * 10) / 10 : 0;
    res.json({ success: true, totalSessions: total, acceptedSessions: accepted, acceptanceRate, messagesSent, avgRating, totalReviews });
  } catch (err) {
    res.status(500).json({ success: false, message: "Failed to load analytics" });
  }
});

// ─── Reviews ──────────────────────────────────────────────────────────────────
app.post("/submit-review", async (req, res) => {
  try {
    const { sessionId, mentorId, menteeId, rating, comment } = req.body;
    if (!sessionId || !mentorId || !menteeId || !rating) return res.status(400).json({ success: false, message: "Missing required fields." });
    const session = await Session.findById(sessionId).lean();
    if (!session) return res.status(404).json({ success: false, message: "Session not found." });
    if (session.menteeId.toString() !== menteeId) return res.status(403).json({ success: false, message: "Unauthorized." });
    const mentee = await Mentee.findById(menteeId).lean();
    const menteeName = mentee ? `${mentee.firstName} ${mentee.lastName}` : "Mentee";
    await Review.findOneAndUpdate(
      { sessionId },
      { mentorId, menteeId, menteeName, rating: parseInt(rating), comment: comment || "" },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
    res.json({ success: true, message: "Review submitted!" });
  } catch (err) {
    res.status(500).json({ success: false, message: "Failed to submit review." });
  }
});

app.get("/mentor-reviews/:mentorId", async (req, res) => {
  try {
    const reviews = await Review.find({ mentorId: req.params.mentorId }).sort({ createdAt: -1 }).lean();
    const total = reviews.length;
    const avg = total > 0 ? Math.round((reviews.reduce((s, r) => s + r.rating, 0) / total) * 10) / 10 : 0;
    res.json({ success: true, reviews, avgRating: avg, totalReviews: total });
  } catch (err) {
    res.status(500).json({ success: false, message: "Failed to fetch reviews." });
  }
});

app.get("/check-review/:sessionId", async (req, res) => {
  try {
    const review = await Review.findOne({ sessionId: req.params.sessionId }).lean();
    res.json({ success: true, hasReview: !!review, review: review || null });
  } catch (err) {
    res.status(500).json({ success: false });
  }
});

// ─── Group Sessions ───────────────────────────────────────────────────────────
app.post("/create-group-session", async (req, res) => {
  try {
    const { mentorId, title, description, date, time, maxMentees } = req.body;
    if (!mentorId || !title || !date || !time) return res.status(400).json({ success: false, message: "Missing required fields." });
    const mentor = await Mentor.findById(mentorId).lean();
    if (!mentor) return res.status(404).json({ success: false, message: "Mentor not found." });
    const gs = await GroupSession.create({
      mentorId, mentorName: `${mentor.firstName} ${mentor.lastName}`,
      title, description: description || "", date, time,
      maxMentees: Math.max(2, parseInt(maxMentees) || 10),
    });
    res.json({ success: true, message: "Group session created!", groupSession: { ...gs.toObject(), id: gs._id.toString() } });
  } catch (err) {
    res.status(500).json({ success: false, message: "Failed to create group session." });
  }
});

app.get("/group-sessions/mentor/:mentorId", async (req, res) => {
  try {
    const gs = await GroupSession.find({ mentorId: req.params.mentorId }).sort({ date: 1, time: 1 }).lean();
    res.json({ success: true, groupSessions: gs.map(g => ({ ...g, id: g._id.toString() })) });
  } catch (err) {
    res.status(500).json({ success: false, message: "Failed to fetch group sessions." });
  }
});

app.get("/group-sessions/available/:menteeId", async (req, res) => {
  try {
    const menteeId = req.params.menteeId;
    const gs = await GroupSession.find({ status: "upcoming" }).sort({ date: 1, time: 1 }).lean();
    res.json({
      success: true,
      groupSessions: gs.map(g => ({
        ...g, id: g._id.toString(),
        participantCount: g.participants.filter(p => p.status === "accepted").length,
        alreadyJoined: g.participants.some(p => p.menteeId?.toString() === menteeId),
        myStatus: g.participants.find(p => p.menteeId?.toString() === menteeId)?.status || null,
      })),
    });
  } catch (err) {
    res.status(500).json({ success: false, message: "Failed to fetch group sessions." });
  }
});

app.post("/join-group-session", async (req, res) => {
  try {
    const { groupSessionId, menteeId } = req.body;
    const gs = await GroupSession.findById(groupSessionId);
    const mentee = await Mentee.findById(menteeId).lean();
    if (!gs || !mentee) return res.status(404).json({ success: false, message: "Not found." });
    if (gs.participants.some(p => p.menteeId?.toString() === menteeId)) return res.status(400).json({ success: false, message: "Already joined." });
    if (gs.participants.filter(p => p.status === "accepted").length >= gs.maxMentees) return res.status(400).json({ success: false, message: "Session is full." });
    gs.participants.push({ menteeId, menteeName: `${mentee.firstName} ${mentee.lastName}`, status: "accepted" });
    await gs.save();
    res.json({ success: true, message: "Joined group session!" });
  } catch (err) {
    res.status(500).json({ success: false, message: "Failed to join group session." });
  }
});

app.post("/cancel-group-session", async (req, res) => {
  try {
    const { groupSessionId, mentorId } = req.body;
    const gs = await GroupSession.findById(groupSessionId);
    if (!gs) return res.status(404).json({ success: false, message: "Not found." });
    if (gs.mentorId.toString() !== mentorId) return res.status(403).json({ success: false, message: "Unauthorized." });
    gs.status = "cancelled";
    await gs.save();
    res.json({ success: true, message: "Group session cancelled." });
  } catch (err) {
    res.status(500).json({ success: false, message: "Failed to cancel." });
  }
});

app.get("/group-video-call/:groupSessionId", async (req, res) => {
  try {
    const { groupSessionId } = req.params;
    const { userId } = req.query;
    const gs = await GroupSession.findById(groupSessionId).lean();
    if (!gs) return res.status(404).send("Group session not found!");
    if (gs.status === "cancelled") return res.status(400).send("This group session has been cancelled.");
    const isMentor = gs.mentorId.toString() === userId;
    const participant = gs.participants.find(p => p.menteeId?.toString() === userId);
    if (!isMentor && !participant) return res.status(403).send("You are not part of this session.");
    const currentUser = isMentor ? await Mentor.findById(userId).lean() : await Mentee.findById(userId).lean();
    if (!currentUser) return res.status(404).send("User not found.");

    // Build full participant list so the client can create one RTCPeerConnection per peer
    const acceptedMentees = gs.participants.filter(p => p.status === "accepted");
    const allParticipants = [
      { userId: gs.mentorId.toString(), userName: gs.mentorName, role: "mentor" },
      ...acceptedMentees.map(p => ({
        userId: p.menteeId.toString(), userName: p.menteeName, role: "mentee",
      })),
    ];

    res.render("video-call", {
      sessionId:         groupSessionId,
      currentUserId:     userId,
      currentUserName:   `${currentUser.firstName} ${currentUser.lastName}`,
      otherUserId:       "",          // unused in group mode
      otherUserName:     gs.title,    // session title shown in header
      role:              isMentor ? "mentor" : "mentee",
      redirectUrl:       isMentor ? `/mentor-home/${userId}` : `/mentee-home/${userId}`,
      isGroupCall:       true,
      groupParticipants: JSON.stringify(allParticipants),
    });
  } catch (err) {
    res.status(500).send("Server error");
  }
});

// ─── Gemini AI ────────────────────────────────────────────────────────────────
if (!process.env.GEMINI_API_KEY) {
  console.error("⚠️  GEMINI_API_KEY is missing!");
  process.exit(1);
}

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash-exp" });

async function generate(userMsg) {
  try {
    const prompt = `
You are a Virtual Career Mentor created by Mentorise.
Your sole purpose is to provide guidance on *career development only*.
If user asks anything unrelated (relationships, gossip, jokes, personal life),
politely refuse and remind them of your purpose.
Keep answers clear, structured, practical, and include emojis.
Do NOT use bold formatting.

User: ${userMsg}
    `;
    const result = await model.generateContent(prompt);
    return result.response.text();
  } catch (err) {
    console.error("Gemini Error:", err.message);
    return "AI is currently unavailable. Please try again shortly 🙏";
  }
}

app.get("/ai", (req, res) => {
  res.render("ai-chat", { userId: req.query.userId || "", role: req.query.role || "mentee" });
});

app.post("/ai", async (req, res) => {
  const { message } = req.body;
  if (!message || typeof message !== "string" || message.trim() === "") {
    return res.status(400).json({ error: "Message cannot be empty." });
  }
  res.json({ result: await generate(message.trim()) });
});
