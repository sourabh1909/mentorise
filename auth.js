const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { Mentor, Mentee } = require("./db");

const JWT_SECRET = process.env.JWT_SECRET || "change_this_secret";
const SALT_ROUNDS = 10;

// ─── Sign Up ────────────────────────────────────────────────────────────────
// Creates a hashed password and saves user to the correct collection.
// Returns { success, userId, userType } or { success: false, message }
const signupUser = async (userData) => {
  try {
    const { email, password, userType, ...rest } = userData;

    // Check if email already exists in either collection
    const existingMentor = await Mentor.findOne({ email });
    const existingMentee = await Mentee.findOne({ email });
    if (existingMentor || existingMentee) {
      return { success: false, message: "Email already registered." };
    }

    const hashedPassword = await bcrypt.hash(password, SALT_ROUNDS);

    let savedUser;
    if (userType === "mentor") {
      savedUser = await Mentor.create({ ...rest, email, password: hashedPassword, userType });
    } else if (userType === "mentee") {
      savedUser = await Mentee.create({ ...rest, email, password: hashedPassword, userType });
    } else {
      return { success: false, message: "Invalid user type." };
    }

    return { success: true, userId: savedUser._id.toString(), userType };
  } catch (error) {
    console.error("Signup error:", error.message);
    return { success: false, message: error.message };
  }
};

// ─── Login ──────────────────────────────────────────────────────────────────
// Finds user by email in both collections, validates password, returns JWT token.
const loginUser = async (email, password) => {
  try {
    let user = await Mentor.findOne({ email });
    let userType = "mentor";

    if (!user) {
      user = await Mentee.findOne({ email });
      userType = "mentee";
    }

    if (!user) {
      return { success: false, message: "No account found with this email." };
    }

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      return { success: false, message: "Incorrect password." };
    }

    // Create JWT token (valid 7 days)
    const token = jwt.sign(
      { userId: user._id.toString(), userType },
      JWT_SECRET,
      { expiresIn: "7d" }
    );

    return { success: true, token, userId: user._id.toString(), userType };
  } catch (error) {
    console.error("Login error:", error.message);
    return { success: false, message: error.message };
  }
};

// ─── Middleware: Verify JWT ──────────────────────────────────────────────────
// Use this on protected routes: requireAuth(req, res, next)
const requireAuth = (req, res, next) => {
  const token = req.cookies?.token;
  if (!token) return res.redirect("/login");

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded; // { userId, userType }
    next();
  } catch {
    res.clearCookie("token");
    return res.redirect("/login");
  }
};

module.exports = { signupUser, loginUser, requireAuth };
