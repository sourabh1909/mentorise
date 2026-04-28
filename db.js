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
    college:         { type: String, default: "" },       // name="college"
    yearOfStudy:     { type: String, default: "" },       // name="yearOfStudy"
    areasOfInterest: { type: [String], default: [] },     // name="areasOfInterest" (checkboxes)
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
    currentRole:    { type: String, default: "" },        // name="currentRole"
    field:          { type: String, default: "" },        // name="field"
    experience:     { type: String, default: "" },        // name="experience"
    about:          { type: String, default: "" },        // name="about"
    linkedin:       { type: String, default: "" },        // name="linkedin"
    mentoringAreas: { type: [String], default: [] },      // name="mentoringAreas" (checkboxes)
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

// ─── Message Schema ─────────────────────────────────────────────────────────
// Stores individual messages within a chat conversation.
const messageSchema = new mongoose.Schema(
  {
    chatId:     { type: String, required: true, index: true },   // matches Chat.chatId
    senderId:   { type: String, required: true },                // ObjectId as string
    senderName: { type: String, required: true },
    senderType: { type: String, enum: ["mentor", "mentee"], required: true },
    content:    { type: String, required: true },                // message text
    read:       { type: Boolean, default: false },               // read receipt
    readAt:     { type: Date, default: null },
  },
  { timestamps: true }   // createdAt = message sent time
);

// ─── Chat Schema ─────────────────────────────────────────────────────────────
// One document per mentor-mentee pair; messages are stored in the Message collection.
const chatSchema = new mongoose.Schema(
  {
    chatId:       { type: String, required: true, unique: true },  // "<mentorId>_<menteeId>"
    users:        [{ type: String }],                              // [mentorId, menteeId]
    mentor:       { id: String, name: String },
    mentee:       { id: String, name: String },
    // Snapshot of the latest message for fast chat-list rendering
    lastMessage: {
      content:    { type: String, default: "" },
      senderId:   { type: String, default: "" },
      senderName: { type: String, default: "" },
      sentAt:     { type: Date,   default: null },
    },
    unreadCountMentor: { type: Number, default: 0 },  // unread msgs for the mentor
    unreadCountMentee: { type: Number, default: 0 },  // unread msgs for the mentee
    lastActivity:      { type: Date, default: Date.now },
  },
  { timestamps: true }
);

// ─── Review Schema ─────────────────────────────────────────────────────────
// One review per (sessionId, menteeId) pair — submitted after a session ends.
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

// ─── GroupSession Schema ────────────────────────────────────────────────────
// Allows one mentor to host multiple mentees in a single video room.
const groupSessionSchema = new mongoose.Schema(
  {
    mentorId:    { type: mongoose.Schema.Types.ObjectId, ref: "Mentor", required: true },
    mentorName:  { type: String, required: true },
    title:       { type: String, required: true },
    description: { type: String, default: "" },
    date:        { type: String, required: true },
    time:        { type: String, required: true },
    maxMentees:  { type: Number, default: 10 },
    // Array of { menteeId, menteeName, status: pending|accepted|rejected }
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

const Mentor       = mongoose.model("Mentor",        mentorSchema);
const Mentee       = mongoose.model("Mentee",        menteeSchema);
const Session      = mongoose.model("Session",       sessionSchema);
const Chat         = mongoose.model("Chat",          chatSchema);
const Message      = mongoose.model("Message",       messageSchema);
const Review       = mongoose.model("Review",        reviewSchema);
const GroupSession = mongoose.model("GroupSession",  groupSessionSchema);

module.exports = { connectDB, Mentor, Mentee, Session, Chat, Message, Review, GroupSession };