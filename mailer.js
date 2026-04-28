const nodemailer = require("nodemailer");

const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  },
});

const sendMail = async ({ to, subject, html }) => {
  try {
    await transporter.sendMail({
      from: `"Mentorise" <${process.env.EMAIL_USER}>`,
      to,
      subject,
      html,
    });
    console.log(`Email sent to ${to}`);
  } catch (err) {
    console.error("Email error:", err.message);
  }
};

// ─── Send email to mentee when mentor ACCEPTS session ───────────────────────
const sendSessionAcceptedToMentee = async ({ menteeEmail, menteeName, mentorName, date, time, sessionId, menteeId }) => {
  const videoCallLink = sessionId ? `${process.env.APP_URL || 'http://localhost:3000'}/video-call/${sessionId}?userId=${menteeId || ''}` : null;
  await sendMail({
    to: menteeEmail,
    subject: `Your Session with ${mentorName} is Confirmed! ✅`,
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: auto; padding: 24px; border: 1px solid #e5e7eb; border-radius: 12px;">
        <h2 style="color: #3A5BA0;">Session Confirmed! 🎉</h2>
        <p>Hi <strong>${menteeName}</strong>,</p>
        <p>Great news! <strong>${mentorName}</strong> has accepted your session request.</p>

        <div style="background: #f0f4ff; padding: 16px; border-radius: 8px; margin: 16px 0;">
          <p style="margin: 4px 0;"><strong>Date:</strong> ${date}</p>
          <p style="margin: 4px 0;"><strong>Time:</strong> ${time}</p>
          <p style="margin: 4px 0;"><strong>Meeting:</strong> Built-in Mentorise Video Call</p>
        </div>

        <p>To join the video call on the day of your session, go to <strong>My Bookings</strong> in your Mentorise account and click <strong>"Join Video Call"</strong>.</p>
        <p>Make sure to join on time. Good luck! 🚀</p>
        <p style="color: #888; font-size: 13px; margin-top: 24px;">— The Mentorise Team</p>
      </div>
    `,
  });
};

// ─── Send email to mentee when mentor REJECTS session ───────────────────────
const sendSessionRejectedToMentee = async ({ menteeEmail, menteeName, mentorName, date, time }) => {
  await sendMail({
    to: menteeEmail,
    subject: `Session Request Update from ${mentorName}`,
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: auto; padding: 24px; border: 1px solid #e5e7eb; border-radius: 12px;">
        <h2 style="color: #3A5BA0;">Session Update</h2>
        <p>Hi <strong>${menteeName}</strong>,</p>
        <p>Unfortunately, <strong>${mentorName}</strong> is unable to take your session at this time.</p>

        <div style="background: #fff5f5; padding: 16px; border-radius: 8px; margin: 16px 0;">
          <p style="margin: 4px 0;"><strong>Date:</strong> ${date}</p>
          <p style="margin: 4px 0;"><strong>Time:</strong> ${time}</p>
          <p style="margin: 4px 0; color: #e24b4a;"><strong>Status:</strong> Not available</p>
        </div>

        <p>Don't be discouraged! Browse other mentors on Mentorise and book another session. 💪</p>
        <p style="color: #888; font-size: 13px; margin-top: 24px;">— The Mentorise Team</p>
      </div>
    `,
  });
};

// ─── Send OTP email for mentor signup verification ───────────────────────────
const sendOTPEmail = async ({ email, otp, firstName }) => {
  await sendMail({
    to: email,
    subject: "Your Mentorise Verification Code",
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: auto; padding: 24px; border: 1px solid #e5e7eb; border-radius: 12px;">
        <h2 style="color: #3A5BA0;">Verify Your Email 🔐</h2>
        <p>Hi <strong>${firstName}</strong>,</p>
        <p>Thanks for signing up as a mentor on Mentorise! Use the OTP below to complete your registration.</p>

        <div style="background: #f0f4ff; padding: 24px; border-radius: 8px; margin: 20px 0; text-align: center;">
          <p style="margin: 0 0 8px; color: #555; font-size: 14px;">Your One-Time Password</p>
          <h1 style="margin: 0; font-size: 42px; letter-spacing: 12px; color: #3A5BA0; font-weight: bold;">${otp}</h1>
          <p style="margin: 8px 0 0; color: #888; font-size: 12px;">Valid for 10 minutes</p>
        </div>

        <p style="color: #555;">If you did not request this, please ignore this email.</p>
        <p style="color: #888; font-size: 13px; margin-top: 24px;">— The Mentorise Team</p>
      </div>
    `,
  });
};


// ─── Send password reset link ─────────────────────────────────────────────────
const sendPasswordResetEmail = async ({ email, firstName, resetLink }) => {
  await sendMail({
    to: email,
    subject: "Reset Your Mentorise Password",
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: auto; padding: 24px; border: 1px solid #e5e7eb; border-radius: 12px;">
        <h2 style="color: #3A5BA0;">Reset Your Password 🔑</h2>
        <p>Hi <strong>${firstName}</strong>,</p>
        <p>We received a request to reset your Mentorise password. Click the button below to choose a new password.</p>

        <div style="text-align: center; margin: 32px 0;">
          <a href="${resetLink}" style="background-color: #3A5BA0; color: white; padding: 14px 32px; border-radius: 8px; text-decoration: none; font-weight: bold; font-size: 16px;">
            Reset Password
          </a>
        </div>

        <p style="color: #555; font-size: 13px;">This link expires in <strong>15 minutes</strong>. If you didn't request a password reset, you can safely ignore this email.</p>
        <p style="color: #888; font-size: 12px; word-break: break-all;">Or copy this link: ${resetLink}</p>
        <p style="color: #888; font-size: 13px; margin-top: 24px;">— The Mentorise Team</p>
      </div>
    `,
  });
};

// ─── Send session reminder email (30 min before) ─────────────────────────────
const sendSessionReminderEmail = async ({ email, firstName, otherName, date, time, sessionId, userId, isGroup, groupTitle }) => {
  const joinLink = isGroup
    ? `${process.env.APP_URL || 'http://localhost:3000'}/group-video-call/${sessionId}?userId=${userId}`
    : `${process.env.APP_URL || 'http://localhost:3000'}/video-call/${sessionId}?userId=${userId}`;
  const sessionLabel = isGroup ? `Group Session: ${groupTitle}` : `1-on-1 Session with ${otherName}`;
  await sendMail({
    to: email,
    subject: `⏰ Reminder: Your session starts in 30 minutes!`,
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: auto; padding: 24px; border: 1px solid #e5e7eb; border-radius: 12px;">
        <h2 style="color: #3A5BA0;">Session Starting Soon! ⏰</h2>
        <p>Hi <strong>${firstName}</strong>,</p>
        <p>Your session is starting in <strong>30 minutes</strong>. Get ready!</p>
        <div style="background: #f0f4ff; padding: 16px; border-radius: 8px; margin: 16px 0;">
          <p style="margin: 4px 0;"><strong>Session:</strong> ${sessionLabel}</p>
          <p style="margin: 4px 0;"><strong>Date:</strong> ${date}</p>
          <p style="margin: 4px 0;"><strong>Time:</strong> ${time}</p>
        </div>
        <div style="text-align: center; margin: 24px 0;">
          <a href="${joinLink}" style="background-color: #3A5BA0; color: white; padding: 14px 32px; border-radius: 8px; text-decoration: none; font-weight: bold; font-size: 16px;">
            Join Video Call
          </a>
        </div>
        <p style="color: #888; font-size: 13px; margin-top: 24px;">— The Mentorise Team</p>
      </div>
    `,
  });
};

module.exports = { sendSessionAcceptedToMentee, sendSessionRejectedToMentee, sendOTPEmail, sendPasswordResetEmail, sendSessionReminderEmail };