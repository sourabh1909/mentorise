const mongoose = require("mongoose");

const connectDB = async () => {
  try {
    await mongoose.connect(process.env.MONGO_URI);
    console.log("MongoDB connected successfully");
  } catch (error) {
    console.error("MongoDB connection error:", error.message);
    process.exit(1);
  }
};

// ─── Schemas ───────────────────────────────────────────────────────────────

const menteeSchema = new mongoose.Schema(
  {
    firstName:       { type: String, required: true },
    lastName:        { type: String, required: true },
    email:           { type: String, required: true, unique: true },
    password:        { type: String, required: true },
    userType:        { type: String, default: "mentee" },
    img:             { type: String, default: "" },
    college:         { type: String, default: "" },
    yearOfStudy:     { type: String, default: "" },
    areasOfInterest: { type: [String], default: [] },
  },
  { timestamps: true }
);

const mentorSchema = new mongoose.Schema(
  {
    firstName:      { type: String, required: true },
    lastName:       { type: String, required: true },
    email:          { type: String, required: true, unique: true },
    password:       { type: String, required: true },
    userType:       { type: String, default: "mentor" },
    img:            { type: String, default: "" },
    currentRole:    { type: String, default: "" },
    field:          { type: String, default: "" },
    experience:     { type: String, default: "" },
    about:          { type: String, default: "" },
    linkedin:       { type: String, default: "" },
    mentoringAreas: { type: [String], default: [] },
  },
  { timestamps: true }
);

const sessionSchema = new mongoose.Schema(
  {
    mentorId:    { type: mongoose.Schema.Types.ObjectId, ref: "Mentor", required: true },
    menteeId:    { type: mongoose.Schema.Types.ObjectId, ref: "Mentee", required: true },
    mentorName:  { type: String },
    menteeName:  { type: String },
    date:        { type: String, required: true },
    time:        { type: String, required: true },
    message:     { type: String, default: "" },
    status:      { type: String, enum: ["pending", "accepted", "rejected"], default: "pending" },
    acceptedAt:  { type: Date },
    rejectedAt:  { type: Date },
    reminderSent: { type: Boolean, default: false },
  },
  { timestamps: true }
);

// ─── Message Schema ──────────────────────────────────────────────────────────
const messageSchema = new mongoose.Schema(
  {
    chatId:     { type: String, required: true, index: true },
    senderId:   { type: String, required: true },
    senderName: { type: String, required: true },
    senderType: { type: String, enum: ["mentor", "mentee"], required: true },
    content:    { type: String, required: true },
    read:       { type: Boolean, default: false },
    readAt:     { type: Date, default: null },
  },
  { timestamps: true }
);

// ─── Chat Schema ─────────────────────────────────────────────────────────────
const chatSchema = new mongoose.Schema(
  {
    chatId:       { type: String, required: true, unique: true },
    users:        [{ type: String }],
    mentor:       { id: String, name: String },
    mentee:       { id: String, name: String },
    lastMessage: {
      content:    { type: String, default: "" },
      senderId:   { type: String, default: "" },
      senderName: { type: String, default: "" },
      sentAt:     { type: Date,   default: null },
    },
    unreadCountMentor: { type: Number, default: 0 },
    unreadCountMentee: { type: Number, default: 0 },
    lastActivity:      { type: Date, default: Date.now },
  },
  { timestamps: true }
);

// ─── Review Schema ────────────────────────────────────────────────────────────
const reviewSchema = new mongoose.Schema(
  {
    sessionId:   { type: mongoose.Schema.Types.ObjectId, ref: "Session", required: true, unique: true },
    mentorId:    { type: mongoose.Schema.Types.ObjectId, ref: "Mentor",  required: true },
    menteeId:    { type: mongoose.Schema.Types.ObjectId, ref: "Mentee",  required: true },
    menteeName:  { type: String, required: true },
    rating:      { type: Number, min: 1, max: 5, required: true },
    comment:     { type: String, default: "" },
  },
  { timestamps: true }
);

// ─── GroupSession Schema ──────────────────────────────────────────────────────
const groupSessionSchema = new mongoose.Schema(
  {
    mentorId:    { type: mongoose.Schema.Types.ObjectId, ref: "Mentor", required: true },
    mentorName:  { type: String, required: true },
    title:       { type: String, required: true },
    description: { type: String, default: "" },
    date:        { type: String, required: true },
    time:        { type: String, required: true },
    maxMentees:  { type: Number, default: 10 },
    participants: [
      {
        menteeId:   { type: mongoose.Schema.Types.ObjectId, ref: "Mentee" },
        menteeName: { type: String },
        status:     { type: String, enum: ["pending", "accepted", "rejected"], default: "pending" },
      }
    ],
    status: { type: String, enum: ["upcoming", "completed", "cancelled"], default: "upcoming" },
    reminderSent: { type: Boolean, default: false },
  },
  { timestamps: true }
);

// ─── ActiveChat Schema ────────────────────────────────────────────────────────
// Tracks which mentor↔mentee pairs have an active (open) chat thread.
// Created automatically when either side opens a chat for the first time.
// Useful for showing a mentor's/mentee's active chat list in dashboards.
const activeChatSchema = new mongoose.Schema(
  {
    chatId:        { type: String, required: true, unique: true }, // "{mentorId}_{menteeId}"
    mentorId:      { type: mongoose.Schema.Types.ObjectId, ref: "Mentor", required: true },
    menteeId:      { type: mongoose.Schema.Types.ObjectId, ref: "Mentee", required: true },
    mentorName:    { type: String, required: true },
    menteeName:    { type: String, required: true },
    mentorImg:     { type: String, default: "" },
    menteeImg:     { type: String, default: "" },
    isActive:      { type: Boolean, default: true },  // set false if either user archives/deletes
    lastMessage: {
      content:    { type: String, default: "" },
      senderId:   { type: String, default: "" },
      senderName: { type: String, default: "" },
      sentAt:     { type: Date,   default: null },
    },
    unreadCountMentor: { type: Number, default: 0 },
    unreadCountMentee: { type: Number, default: 0 },
    lastActivity:      { type: Date, default: Date.now },
  },
  { timestamps: true }
);
// Fast lookups by either participant
activeChatSchema.index({ mentorId: 1, lastActivity: -1 });
activeChatSchema.index({ menteeId: 1, lastActivity: -1 });

// ─── OTP Schema ───────────────────────────────────────────────────────────────
// Replaces in-memory Maps so OTPs survive Render restarts/spin-downs.
// MongoDB automatically deletes documents when `expiresAt` is reached (TTL index).
const otpSchema = new mongoose.Schema(
  {
    email:     { type: String, required: true, index: true },
    otp:       { type: String, required: true },
    type:      { type: String, enum: ["signup", "login"], required: true }, // distinguish signup vs login OTP
    verified:  { type: Boolean, default: false },
    expiresAt: { type: Date, required: true },   // TTL index below auto-deletes expired docs
  },
  { timestamps: true }
);
// TTL index: MongoDB removes the document automatically when expiresAt is reached
otpSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

const Mentor       = mongoose.model("Mentor",        mentorSchema);
const Mentee       = mongoose.model("Mentee",        menteeSchema);
const Session      = mongoose.model("Session",       sessionSchema);
const Chat         = mongoose.model("Chat",          chatSchema);
const Message      = mongoose.model("Message",       messageSchema);
const Review       = mongoose.model("Review",        reviewSchema);
const GroupSession = mongoose.model("GroupSession",  groupSessionSchema);
const OTP          = mongoose.model("OTP",           otpSchema);
const ActiveChat   = mongoose.model("ActiveChat",    activeChatSchema);

module.exports = { connectDB, Mentor, Mentee, Session, Chat, Message, Review, GroupSession, OTP, ActiveChat };