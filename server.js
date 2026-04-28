require("dotenv").config();
const crypto = require("crypto");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const express = require("express");
const path = require("path");
const http = require("http");
const socketIO = require("socket.io");
const cookieParser = require("cookie-parser");

const { connectDB, Mentor, Mentee, Session, Chat, Message, Review, GroupSession } = require("./db");
const { signupUser, loginUser, requireAuth } = require("./auth");
const { sendSessionAcceptedToMentee, sendSessionRejectedToMentee, sendOTPEmail, sendPasswordResetEmail, sendSessionReminderEmail } = require("./mailer");

const app = express();
const port = process.env.PORT || 3000;
const server = http.createServer(app);
const io = socketIO(server);

connectDB();

setInterval(async () => {
  try {
    const now = new Date();
    const windowStart = new Date(now.getTime() + 29 * 60 * 1000); // 29 min from now
    const windowEnd   = new Date(now.getTime() + 31 * 60 * 1000); // 31 min from now

    const upcomingSessions = await Session.find({
      status: "accepted",
      reminderSent: { $ne: true },
    }).lean();

    for (const session of upcomingSessions) {
      const sessionTime = new Date(`${session.date}T${session.time}`);
      if (sessionTime >= windowStart && sessionTime <= windowEnd) {
        // Send to mentor
        const mentor = await Mentor.findById(session.mentorId).lean();
        if (mentor) {
          await sendSessionReminderEmail({
            email: mentor.email, firstName: mentor.firstName,
            otherName: session.menteeName,
            date: session.date, time: session.time,
            sessionId: session._id.toString(), userId: mentor._id.toString(),
          });
        }
        // Send to mentee
        const mentee = await Mentee.findById(session.menteeId).lean();
        if (mentee) {
          await sendSessionReminderEmail({
            email: mentee.email, firstName: mentee.firstName,
            otherName: session.mentorName,
            date: session.date, time: session.time,
            sessionId: session._id.toString(), userId: mentee._id.toString(),
          });
        }
        await Session.findByIdAndUpdate(session._id, { reminderSent: true });
      }
    }

    const upcomingGroups = await GroupSession.find({
      status: "upcoming",
      reminderSent: { $ne: true },
    }).lean();

    for (const gs of upcomingGroups) {
      const sessionTime = new Date(`${gs.date}T${gs.time}`);
      if (sessionTime >= windowStart && sessionTime <= windowEnd) {
        const mentor = await Mentor.findById(gs.mentorId).lean();
        if (mentor) {
          await sendSessionReminderEmail({
            email: mentor.email, firstName: mentor.firstName,
            date: gs.date, time: gs.time,
            sessionId: gs._id.toString(), userId: mentor._id.toString(),
            isGroup: true, groupTitle: gs.title,
          });
        }
        for (const p of gs.participants.filter(p => p.status === "accepted")) {
          const mentee = await Mentee.findById(p.menteeId).lean();
          if (mentee) {
            await sendSessionReminderEmail({
              email: mentee.email, firstName: mentee.firstName,
              date: gs.date, time: gs.time,
              sessionId: gs._id.toString(), userId: mentee._id.toString(),
              isGroup: true, groupTitle: gs.title,
            });
          }
        }
        await GroupSession.findByIdAndUpdate(gs._id, { reminderSent: true });
      }
    }
  } catch (err) {
    console.error("Reminder cron error:", err.message);
  }
}, 60 * 1000);

// ─── Middleware  ← MUST be before all routes
app.set("views", path.join(__dirname, "views"));
app.set("view engine", "ejs");

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, "public")));

server.listen(port, () => {
  console.log("Server started on port " + port);
});

// ─── Socket.IO ───────────────────────────────────────────────────────────────
io.on("connection", (socket) => {
  console.log("User connected:", socket.id);

  // ── Text Chat ─────────────────────────────────────────────────────────────
  socket.on("join-chat", ({ roomId, userName }) => {
    socket.join(roomId);
    console.log(`${userName} joined room: ${roomId}`);
  });

  // Persist message to MongoDB, update Chat metadata, then broadcast
  socket.on("send-message", async ({ roomId, message, sender, senderName, senderType }) => {
    try {
      // 1. Save message to DB
      const saved = await Message.create({
        chatId: roomId,
        senderId: sender,
        senderName,
        senderType: senderType || "mentee", // fallback; client should always send this
        content: message,
      });

      // 2. Update Chat document: lastMessage snapshot + unread counters
      const unreadIncrement = {};
      if (senderType === "mentor") {
        unreadIncrement.unreadCountMentee = 1;
      } else {
        unreadIncrement.unreadCountMentor = 1;
      }

      await Chat.findOneAndUpdate(
        { chatId: roomId },
        {
          lastMessage: {
            content: message,
            senderId: sender,
            senderName,
            sentAt: saved.createdAt,
          },
          lastActivity: new Date(),
          $inc: unreadIncrement,
        }
      );

      // 3. Broadcast to room (include DB _id so clients can reference it)
      io.to(roomId).emit("receive-message", {
        _id: saved._id.toString(),
        message,
        sender,
        senderName,
        timestamp: saved.createdAt.toISOString(),
      });
    } catch (err) {
      console.error("send-message error:", err.message);
    }
  });

  // Mark messages as read when a user opens/focuses the chat
  socket.on("mark-read", async ({ roomId, readerId, readerType }) => {
    try {
      // Mark all unread messages NOT sent by the reader as read
      await Message.updateMany(
        { chatId: roomId, senderId: { $ne: readerId }, read: false },
        { read: true, readAt: new Date() }
      );

      // Reset the relevant unread counter on the Chat document
      const counterField = readerType === "mentor" ? "unreadCountMentor" : "unreadCountMentee";
      await Chat.findOneAndUpdate({ chatId: roomId }, { [counterField]: 0 });

      // Notify room so the other user can update their UI
      socket.to(roomId).emit("messages-read", { readerId });
    } catch (err) {
      console.error("mark-read error:", err.message);
    }
  });

  // ── Video Call Signaling ──────────────────────────────────────────────────
  socket.on("join-video-room", ({ room, userId, userName }) => {
    socket.join(room);
    socket.data.videoRoom = room;
    socket.to(room).emit("video-user-joined", { userId, userName });
    console.log(`${userName} joined video room: ${room}`);
  });

  socket.on("video-signal", ({ room, to, from, type, sdp, candidate }) => {
    socket.to(room).emit("video-signal", { from, type, sdp, candidate });
  });

  socket.on("video-leave", ({ room, userId }) => {
    socket.to(room).emit("video-user-left", { userId });
    socket.leave(room);
    socket.data.videoRoom = null;
  });

  socket.on("video-chat-msg", ({ room, sender, message }) => {
    socket.to(room).emit("video-chat-msg", { sender, message });
  });

  socket.on("disconnect", () => {
    if (socket.data.videoRoom) {
      socket.to(socket.data.videoRoom).emit("video-user-left", { userId: socket.id });
    }
    console.log("User disconnected:", socket.id);
  });
});



// ─── In-Memory Password Reset Token Store ────────────────────────────────────
const resetTokenStore = new Map(); // token -> { email, expiresAt }

// POST /forgot-password — validate email, generate token, send reset email
app.post("/forgot-password", async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ success: false, message: "Email is required." });

    const user = (await Mentor.findOne({ email }).lean()) || (await Mentee.findOne({ email }).lean());
    if (!user) return res.status(400).json({ success: false, message: "No account found with this email." });

    // Generate a secure random token
    const token = crypto.randomBytes(32).toString("hex");
    const expiresAt = Date.now() + 15 * 60 * 1000; // 15 minutes
    resetTokenStore.set(token, { email, expiresAt });

    const resetLink = `${process.env.APP_URL || "https://mentorise-1.onrender.com"}/reset-password?token=${token}`;
    await sendPasswordResetEmail({ email, firstName: user.firstName, resetLink });

    res.json({ success: true, message: "Reset link sent." });
  } catch (err) {
    console.error("Forgot password error:", err);
    res.status(500).json({ success: false, message: "Failed to send reset email. Try again." });
  }
});

// GET /reset-password — serve the reset password page
app.get("/reset-password", (req, res) => {
  const { token } = req.query;
  if (!token) return res.redirect("/login");

  const record = resetTokenStore.get(token);
  if (!record || Date.now() > record.expiresAt) {
    return res.send(`
      <html><body style="font-family:sans-serif;text-align:center;padding:80px 20px;">
        <h2 style="color:#e24b4a;">Link Expired ⏰</h2>
        <p>This password reset link has expired or is invalid.</p>
        <a href="/login" style="color:#3A5BA0;font-weight:bold;">Back to Login</a>
      </body></html>
    `);
  }

  res.render("reset-password", { token });
});

// POST /reset-password — update the user's password
app.post("/reset-password", async (req, res) => {
  try {
    const { token, password } = req.body;
    if (!token || !password) return res.status(400).json({ success: false, message: "Token and password are required." });

    const record = resetTokenStore.get(token);
    if (!record || Date.now() > record.expiresAt) {
      return res.status(400).json({ success: false, message: "Reset link has expired. Please request a new one." });
    }

    const bcrypt = require("bcryptjs");
    const hashedPassword = await bcrypt.hash(password, 10);
    const { email } = record;

    // Update in whichever collection the user belongs to
    const mentorUpdate = await Mentor.findOneAndUpdate({ email }, { password: hashedPassword });
    if (!mentorUpdate) await Mentee.findOneAndUpdate({ email }, { password: hashedPassword });

    resetTokenStore.delete(token); // token is one-time use
    res.json({ success: true, message: "Password reset successfully!" });
  } catch (err) {
    console.error("Reset password error:", err);
    res.status(500).json({ success: false, message: "Failed to reset password. Try again." });
  }
});

// ─── In-Memory OTP Store (login)
const loginOtpStore = new Map();

// Send OTP for login (checks user exists first)
app.post("/send-login-otp", async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ success: false, message: "Email is required." });

    const user = (await Mentor.findOne({ email }).lean()) || (await Mentee.findOne({ email }).lean());
    if (!user) return res.status(400).json({ success: false, message: "No account found with this email." });

    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    const expiresAt = Date.now() + 10 * 60 * 1000;
    loginOtpStore.set(email, { otp, expiresAt });

    await sendOTPEmail({ email, otp, firstName: user.firstName });

    res.json({ success: true, message: "OTP sent to your email." });
  } catch (error) {
    console.error("Send login OTP error:", error);
    res.status(500).json({ success: false, message: "Failed to send OTP." });
  }
});

// Verify login OTP
app.post("/verify-login-otp", (req, res) => {
  const { email, otp } = req.body;
  const record = loginOtpStore.get(email);

  if (!record) return res.status(400).json({ success: false, message: "No OTP found. Please request a new one." });
  if (Date.now() > record.expiresAt) {
    loginOtpStore.delete(email);
    return res.status(400).json({ success: false, message: "OTP has expired. Please request a new one." });
  }
  if (record.otp !== otp.trim()) return res.status(400).json({ success: false, message: "Incorrect OTP. Please try again." });

  loginOtpStore.set(email, { ...record, verified: true });
  res.json({ success: true, message: "OTP verified!" });
});

const otpStore = new Map();

// ─── OTP Routes
app.post("/send-otp", async (req, res) => {
  try {
    const { email, firstName } = req.body;

    if (!email || !firstName) {
      return res.status(400).json({ success: false, message: "Email and first name are required." });
    }

    const existingMentor = await Mentor.findOne({ email });
    const existingMentee = await Mentee.findOne({ email });
    if (existingMentor || existingMentee) {
      return res.status(400).json({ success: false, message: "Email already registered." });
    }

    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    const expiresAt = Date.now() + 10 * 60 * 1000;

    otpStore.set(email, { otp, expiresAt, firstName });

    await sendOTPEmail({ email, otp, firstName });

    res.json({ success: true, message: "OTP sent to your email." });
  } catch (error) {
    console.error("Send OTP error:", error);
    res.status(500).json({ success: false, message: "Failed to send OTP." });
  }
});

app.post("/verify-otp", (req, res) => {
  const { email, otp } = req.body;
  const record = otpStore.get(email);

  if (!record) {
    return res.status(400).json({ success: false, message: "No OTP found for this email. Please request a new one." });
  }
  if (Date.now() > record.expiresAt) {
    otpStore.delete(email);
    return res.status(400).json({ success: false, message: "OTP has expired. Please request a new one." });
  }
  if (record.otp !== otp.trim()) {
    return res.status(400).json({ success: false, message: "Incorrect OTP. Please try again." });
  }

  otpStore.set(email, { ...record, verified: true });
  res.json({ success: true, message: "Email verified successfully!" });
});


// ─── Page Routes
app.get("/", (req, res) => res.redirect("/home"));
app.get("/home", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));
app.get("/login", (req, res) => res.sendFile(path.join(__dirname, "public", "Login.html")));
app.get("/signup", (req, res) => res.sendFile(path.join(__dirname, "public", "signup.html")));

// ─── Auth Routes
app.post("/signup", async (req, res) => {
  const result_body = req.body;

  if (result_body.userType === "mentor" || result_body.userType === "mentee") {
    const email = result_body.email;
    const record = otpStore.get(email);
    if (!record || !record.verified) {
      return res.status(400).send("Email not verified. Please complete OTP verification before signing up.");
    }
    otpStore.delete(email);
  }

  const result = await signupUser(result_body);

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

  if (userType === "mentor") {
    return res.redirect(`/mentor-home/${userId}`);
  } else {
    return res.redirect(`/mentee-home/${userId}`);
  }
});

app.post("/login", async (req, res) => {
  const { email, password } = req.body;

  const otpRecord = loginOtpStore.get(email);
  if (!otpRecord || !otpRecord.verified) {
    return res.status(400).send("Email not verified. Please complete OTP verification before signing in.");
  }
  loginOtpStore.delete(email);

  const result = await loginUser(email, password);

  if (!result.success) {
    return res.status(400).send(result.message);
  }

  res.cookie("token", result.token, { httpOnly: true, maxAge: 7 * 24 * 60 * 60 * 1000 });

  if (result.userType === "mentor") {
    return res.redirect(`/mentor-home/${result.userId}`);
  } else {
    return res.redirect(`/mentee-home/${result.userId}`);
  }
});

app.post("/logout", (req, res) => {
  res.clearCookie("token");
  res.redirect("/login");
});

// ─── Profile Routes
app.get("/mentor-profile/:id", async (req, res) => {
  try {
    const mentor = await Mentor.findById(req.params.id).lean();
    if (!mentor) return res.status(404).send("Mentor not found!");
    delete mentor.password;
    res.render("mentor-profile", { user: mentor, userId: req.params.id });
  } catch (error) {
    console.error("Error fetching mentor:", error);
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
    console.error("Error fetching mentee:", error);
    res.status(500).send("Server error");
  }
});

// ─── Mentee Home
app.get("/mentee-home/:id", async (req, res) => {
  try {
    const mentee = await Mentee.findById(req.params.id).lean();
    if (!mentee) return res.status(404).send("Mentee not found!");
    delete mentee.password;
    res.render("mentee-home", { user: mentee, userId: req.params.id });
  } catch (error) {
    console.error("Error fetching mentee home:", error);
    res.status(500).send("Server error");
  }
});

// ─── Mentor Home
app.get("/mentor-home/:id", async (req, res) => {
  try {
    const mentor = await Mentor.findById(req.params.id).lean();
    if (!mentor) return res.status(404).send("Mentor not found!");
    delete mentor.password;
    res.render("mentor-home", { user: mentor, userId: req.params.id });
  } catch (error) {
    console.error("Error fetching mentor home:", error);
    res.status(500).send("Server error");
  }
});

// ─── Mentor Directory
app.get("/mentor-directory", async (req, res) => {
  try {
    const menteeId = typeof req.query.menteeId === "string" ? req.query.menteeId.trim() : "";
    const mentors = await Mentor.find({}, { password: 0 }).lean();
    const mentorsWithId = mentors.map((m) => ({ ...m, id: m._id.toString() }));
    res.render("mentor-directory", { mentors: mentorsWithId, menteeId });
  } catch (error) {
    console.error("Error fetching mentors:", error.message);
    res.status(500).send("Error loading mentors");
  }
});

// ─── Session Booking Routes
app.post("/book-session", async (req, res) => {
  try {
    const { mentorId, menteeId, date, time, message } = req.body;
    const mentor = await Mentor.findById(mentorId).lean();
    const mentee = await Mentee.findById(menteeId).lean();

    if (!mentor || !mentee) {
      return res.status(404).json({ success: false, message: "User not found" });
    }

    const session = await Session.create({
      mentorId, menteeId,
      mentorName: `${mentor.firstName} ${mentor.lastName}`,
      menteeName: `${mentee.firstName} ${mentee.lastName}`,
      date, time,
      message: message || "",
      status: "pending",
    });

    res.json({ success: true, message: "Session request sent successfully!", sessionId: session._id.toString() });
  } catch (error) {
    console.error("Error booking session:", error);
    res.status(500).json({ success: false, message: "Failed to book session" });
  }
});

app.get("/mentor-sessions/:mentorId", async (req, res) => {
  try {
    const sessions = await Session.find({ mentorId: req.params.mentorId }).lean();
    const sessionsWithId = sessions.map((s) => ({ ...s, id: s._id.toString() }));
    res.json({ success: true, sessions: sessionsWithId });
  } catch (error) {
    console.error("Error fetching mentor sessions:", error);
    res.status(500).json({ success: false, message: "Failed to fetch sessions" });
  }
});

app.get("/mentee-sessions/:menteeId", async (req, res) => {
  try {
    const sessions = await Session.find({ menteeId: req.params.menteeId }).lean();
    const sessionsWithId = sessions.map((s) => ({ ...s, id: s._id.toString() }));
    res.json({ success: true, sessions: sessionsWithId });
  } catch (error) {
    console.error("Error fetching mentee sessions:", error);
    res.status(500).json({ success: false, message: "Failed to fetch sessions" });
  }
});

app.post("/update-session", async (req, res) => {
  try {
    const { sessionId, status } = req.body;
    const updateData = { status };
    if (status === "accepted") {
      updateData.acceptedAt = new Date();
    } else if (status === "rejected") {
      updateData.rejectedAt = new Date();
    }

    await Session.findByIdAndUpdate(sessionId, updateData);
    const session = await Session.findById(sessionId).lean();
    const mentee = await Mentee.findById(session.menteeId).lean();

    if (mentee && session) {
      if (status === "accepted") {
        await sendSessionAcceptedToMentee({
          menteeEmail: mentee.email,
          menteeName: `${mentee.firstName} ${mentee.lastName}`,
          mentorName: session.mentorName,
          date: session.date, time: session.time,
          sessionId,
        });
      } else if (status === "rejected") {
        await sendSessionRejectedToMentee({
          menteeEmail: mentee.email,
          menteeName: `${mentee.firstName} ${mentee.lastName}`,
          mentorName: session.mentorName,
          date: session.date, time: session.time,
        });
      }
    }

    res.json({ success: true, message: `Session ${status} successfully!` });
  } catch (error) {
    console.error("Error updating session:", error);
    res.status(500).json({ success: false, message: "Failed to update session" });
  }
});

// ─── Booking Page Routes
app.get("/my-bookings/:menteeId", async (req, res) => {
  try {
    const mentee = await Mentee.findById(req.params.menteeId).lean();
    if (!mentee) return res.status(404).send("Mentee not found!");
    res.render("my-bookings", { menteeId: req.params.menteeId });
  } catch (error) {
    res.status(500).send("Server error");
  }
});

app.get("/view-requests/:mentorId", async (req, res) => {
  try {
    const mentor = await Mentor.findById(req.params.mentorId).lean();
    if (!mentor) return res.status(404).send("Mentor not found!");
    res.render("view-requests", { mentorId: req.params.mentorId });
  } catch (error) {
    res.status(500).send("Server error");
  }
});

app.get("/mentor-bookings/:mentorId", async (req, res) => {
  try {
    const mentor = await Mentor.findById(req.params.mentorId).lean();
    if (!mentor) return res.status(404).send("Mentor not found!");
    res.render("mentor-bookings", { mentorId: req.params.mentorId });
  } catch (error) {
    res.status(500).send("Server error");
  }
});

// ─── Chat Routes ─────────────────────────────────────────────────────────────

// Render chat page — also upserts the Chat document with correct mentor/mentee fields
app.get("/chat/:currentUserId/:otherUserId", async (req, res) => {
  try {
    const { currentUserId, otherUserId } = req.params;

    // Determine which is mentor and which is mentee
    const currentMentor = await Mentor.findById(currentUserId).lean();
    const currentMentee = await Mentee.findById(currentUserId).lean();
    const otherMentor   = await Mentor.findById(otherUserId).lean();
    const otherMentee   = await Mentee.findById(otherUserId).lean();

    const currentUserData = currentMentor || currentMentee;
    const otherUserData   = otherMentor   || otherMentee;

    if (!currentUserData || !otherUserData) return res.status(404).send("User not found!");

    // chatId is always mentorId_menteeId for consistency
    const mentorData = currentMentor || otherMentor;
    const menteeData = currentMentee || otherMentee;
    const mentorId   = mentorData._id.toString();
    const menteeId   = menteeData._id.toString();
    const chatId     = `${mentorId}_${menteeId}`;

    await Chat.findOneAndUpdate(
      { chatId },
      {
        chatId,
        users:  [mentorId, menteeId],
        mentor: { id: mentorId, name: `${mentorData.firstName} ${mentorData.lastName}` },
        mentee: { id: menteeId, name: `${menteeData.firstName} ${menteeData.lastName}` },
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
    console.error("Chat page error:", error);
    res.status(500).send("Server error");
  }
});

// REST: fetch paginated chat history (newest last, 50 per page)
app.get("/chat-history/:chatId", async (req, res) => {
  try {
    const { chatId } = req.params;
    const page  = Math.max(1, parseInt(req.query.page) || 1);
    const limit = 50;
    const skip  = (page - 1) * limit;

    const messages = await Message.find({ chatId })
      .sort({ createdAt: 1 })
      .skip(skip)
      .limit(limit)
      .lean();

    const total = await Message.countDocuments({ chatId });

    res.json({
      success: true,
      messages: messages.map((m) => ({
        _id:        m._id.toString(),
        senderId:   m.senderId,
        senderName: m.senderName,
        senderType: m.senderType,
        content:    m.content,
        read:       m.read,
        timestamp:  m.createdAt.toISOString(),
      })),
      page,
      totalPages: Math.ceil(total / limit),
      total,
    });
  } catch (error) {
    console.error("Chat history error:", error);
    res.status(500).json({ success: false, message: "Failed to fetch chat history" });
  }
});

// REST: fetch all chat contacts for a mentor (with lastMessage + unread count)
app.get("/mentor-chat-contacts/:mentorId", async (req, res) => {
  try {
    const mentorId = req.params.mentorId;
    const chats = await Chat.find({ "mentor.id": mentorId })
      .sort({ lastActivity: -1 })
      .lean();

    const contacts = chats.map((chat) => ({
      id:           chat.mentee.id,
      name:         chat.mentee.name,
      chatId:       chat.chatId,
      lastMessage:  chat.lastMessage,
      unreadCount:  chat.unreadCountMentor,
    }));

    res.json({ success: true, contacts });
  } catch (error) {
    console.error("Mentor contacts error:", error);
    res.status(500).json({ success: false, message: "Failed to fetch contacts" });
  }
});

// REST: fetch all chat contacts for a mentee (with lastMessage + unread count)
app.get("/mentee-chat-contacts/:menteeId", async (req, res) => {
  try {
    const menteeId = req.params.menteeId;
    const chats = await Chat.find({ "mentee.id": menteeId })
      .sort({ lastActivity: -1 })
      .lean();

    const contacts = chats.map((chat) => ({
      id:          chat.mentor.id,
      name:        chat.mentor.name,
      chatId:      chat.chatId,
      lastMessage: chat.lastMessage,
      unreadCount: chat.unreadCountMentee,
    }));

    res.json({ success: true, contacts });
  } catch (error) {
    console.error("Mentee contacts error:", error);
    res.status(500).json({ success: false, message: "Failed to fetch contacts" });
  }
});

// Page: mentor chats list
app.get("/mentor-chats/:mentorId", async (req, res) => {
  try {
    const mentor = await Mentor.findById(req.params.mentorId).lean();
    if (!mentor) return res.status(404).send("Mentor not found!");
    res.render("mentor-chats", { mentorId: req.params.mentorId });
  } catch (error) {
    res.status(500).send("Server error");
  }
});

// ─── Video Call Route ────────────────────────────────────────────────────────
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

    const currentUserId   = userId;
    const currentUserName = isMentor ? session.mentorName : session.menteeName;
    const otherUserId     = isMentor ? session.menteeId.toString() : session.mentorId.toString();
    const otherUserName   = isMentor ? session.menteeName : session.mentorName;
    const role            = isMentor ? "mentor" : "mentee";
    const redirectUrl     = isMentor
      ? `/mentor-home/${session.mentorId}`
      : `/mentee-home/${session.menteeId}`;

    res.render("video-call", {
      sessionId, currentUserId, currentUserName,
      otherUserId, otherUserName, role, redirectUrl,
    });
  } catch (error) {
    console.error("Video call error:", error);
    res.status(500).send("Server error");
  }
});

// ─── Analytics Route ─────────────────────────────────────────────────────────
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

    const reviews    = await Review.find({ mentorId }).lean();
    const totalReviews = reviews.length;
    const avgRating    = totalReviews > 0
      ? Math.round((reviews.reduce((s, r) => s + r.rating, 0) / totalReviews) * 10) / 10
      : 0;

    res.json({ success: true, totalSessions: total, acceptedSessions: accepted, acceptanceRate, messagesSent, avgRating, totalReviews });
  } catch (err) {
    console.error("Analytics error:", err);
    res.status(500).json({ success: false, message: "Failed to load analytics" });
  }
});

// ─── Ratings & Reviews Routes ─────────────────────────────────────────────────

app.post("/submit-review", async (req, res) => {
  try {
    const { sessionId, mentorId, menteeId, rating, comment } = req.body;
    if (!sessionId || !mentorId || !menteeId || !rating) {
      return res.status(400).json({ success: false, message: "Missing required fields." });
    }
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
    console.error("Submit review error:", err);
    res.status(500).json({ success: false, message: "Failed to submit review." });
  }
});

app.get("/mentor-reviews/:mentorId", async (req, res) => {
  try {
    const reviews = await Review.find({ mentorId: req.params.mentorId }).sort({ createdAt: -1 }).lean();
    const total = reviews.length;
    const avg   = total > 0
      ? Math.round((reviews.reduce((s, r) => s + r.rating, 0) / total) * 10) / 10
      : 0;
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

// ─── Group Session Routes ─────────────────────────────────────────────────────

app.post("/create-group-session", async (req, res) => {
  try {
    const { mentorId, title, description, date, time, maxMentees } = req.body;
    if (!mentorId || !title || !date || !time) {
      return res.status(400).json({ success: false, message: "Missing required fields." });
    }
    const mentor = await Mentor.findById(mentorId).lean();
    if (!mentor) return res.status(404).json({ success: false, message: "Mentor not found." });

    const gs = await GroupSession.create({
      mentorId, mentorName: `${mentor.firstName} ${mentor.lastName}`,
      title, description: description || "",
      date, time,
      maxMentees: Math.max(2, parseInt(maxMentees) || 10),
    });
    res.json({ success: true, message: "Group session created!", groupSession: { ...gs.toObject(), id: gs._id.toString() } });
  } catch (err) {
    console.error("Create group session error:", err);
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
    const result = gs.map(g => ({
      ...g,
      id: g._id.toString(),
      participantCount: g.participants.filter(p => p.status === "accepted").length,
      alreadyJoined: g.participants.some(p => p.menteeId?.toString() === menteeId),
      myStatus: g.participants.find(p => p.menteeId?.toString() === menteeId)?.status || null,
    }));
    res.json({ success: true, groupSessions: result });
  } catch (err) {
    res.status(500).json({ success: false, message: "Failed to fetch group sessions." });
  }
});

app.post("/join-group-session", async (req, res) => {
  try {
    const { groupSessionId, menteeId } = req.body;
    const gs     = await GroupSession.findById(groupSessionId);
    const mentee = await Mentee.findById(menteeId).lean();
    if (!gs || !mentee) return res.status(404).json({ success: false, message: "Not found." });

    const alreadyIn = gs.participants.some(p => p.menteeId?.toString() === menteeId);
    if (alreadyIn) return res.status(400).json({ success: false, message: "Already joined." });

    const acceptedCount = gs.participants.filter(p => p.status === "accepted").length;
    if (acceptedCount >= gs.maxMentees) {
      return res.status(400).json({ success: false, message: "Session is full." });
    }
    gs.participants.push({ menteeId, menteeName: `${mentee.firstName} ${mentee.lastName}`, status: "accepted" });
    await gs.save();
    res.json({ success: true, message: "Joined group session!" });
  } catch (err) {
    console.error("Join group session error:", err);
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

    const isMentor    = gs.mentorId.toString() === userId;
    const participant = gs.participants.find(p => p.menteeId?.toString() === userId);
    if (!isMentor && !participant) return res.status(403).send("You are not part of this session.");

    const currentUser = isMentor
      ? await Mentor.findById(userId).lean()
      : await Mentee.findById(userId).lean();
    if (!currentUser) return res.status(404).send("User not found.");

    res.render("video-call", {
      sessionId: groupSessionId,
      currentUserId: userId,
      currentUserName: `${currentUser.firstName} ${currentUser.lastName}`,
      otherUserId: gs.mentorId.toString(),
      otherUserName: gs.mentorName,
      role: isMentor ? "mentor" : "mentee",
      redirectUrl: isMentor ? `/mentor-home/${userId}` : `/mentee-home/${userId}`,
    });
  } catch (err) {
    console.error("Group video call error:", err);
    res.status(500).send("Server error");
  }
});

// ─── Gemini AI Routes ────────────────────────────────────────────────────────
if (!process.env.GEMINI_API_KEY) {
  console.error("⚠️  GEMINI_API_KEY is missing in .env file!");
  process.exit(1);
}

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

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
  const userId = req.query.userId || "";
  const role   = req.query.role   || "mentee";
  res.render("ai-chat", { userId, role });
});

app.post("/ai", async (req, res) => {
  const { message } = req.body;
  if (!message || typeof message !== "string" || message.trim() === "") {
    return res.status(400).json({ error: "Message cannot be empty." });
  }
  const result = await generate(message.trim());
  res.json({ result });
});
