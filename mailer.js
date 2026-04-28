const nodemailer = require("nodemailer");

// ─── Create transporter ──────────────────────────────────────────────────────
const transporter = nodemailer.createTransport({
  host: "smtp-relay.brevo.com",
  port: 465,
  secure: true,
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  },
});

// ─── Verify SMTP connection ──────────────────────────────────────────────────
transporter.verify((error, success) => {
  if (error) {
    console.error("SMTP Connection Error:", error.message);
  } else {
    console.log("SMTP Server is ready to send emails");
  }
});

// ─── Generic send mail function with retry ──────────────────────────────────
const sendMail = async ({ to, subject, html }) => {
  const maxRetries = 3;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      await transporter.sendMail({
        from: `"Mentorise" <${process.env.EMAIL_USER}>`,
        to,
        subject,
        html,
      });

      console.log(`Email sent to ${to}`);
      return true;
    } catch (err) {
      console.error(
        `Email attempt ${attempt}/${maxRetries} failed:`,
        err.message
      );

      if (attempt === maxRetries) {
        console.error("Final Email Error:", err.message);
        return false;
      }
    }
  }
};

// ─── Send email to mentee when mentor ACCEPTS session ───────────────────────
const sendSessionAcceptedToMentee = async ({
  menteeEmail,
  menteeName,
  mentorName,
  date,
  time,
  sessionId,
  menteeId,
}) => {
  await sendMail({
    to: menteeEmail,
    subject: `Your Session with ${mentorName} is Confirmed! ✅`,
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: auto; padding: 24px; border: 1px solid #e5e7eb; border-radius: 12px;">
        <h2 style="color: #3A5BA0;">Session Confirmed! 🎉</h2>
        <p>Hi <strong>${menteeName}</strong>,</p>
        <p>Great news! <strong>${mentorName}</strong> has accepted your session request.</p>

        <div style="background: #f0f4ff; padding: 16px; border-radius: 8px; margin: 16px 0;">
          <p><strong>Date:</strong> ${date}</p>
          <p><strong>Time:</strong> ${time}</p>
          <p><strong>Meeting:</strong> Built-in Mentorise Video Call</p>
        </div>

        <p>
          To join the video call, go to <strong>My Bookings</strong> in your Mentorise account
          and click <strong>Join Video Call</strong>.
        </p>

        <p style="color: #888; font-size: 13px; margin-top: 24px;">
          — The Mentorise Team
        </p>
      </div>
    `,
  });
};

// ─── Send email to mentee when mentor REJECTS session ───────────────────────
const sendSessionRejectedToMentee = async ({
  menteeEmail,
  menteeName,
  mentorName,
  date,
  time,
}) => {
  await sendMail({
    to: menteeEmail,
    subject: `Session Request Update from ${mentorName}`,
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: auto; padding: 24px; border: 1px solid #e5e7eb; border-radius: 12px;">
        <h2 style="color: #3A5BA0;">Session Update</h2>
        <p>Hi <strong>${menteeName}</strong>,</p>
        <p>
          Unfortunately, <strong>${mentorName}</strong> is unable to take your session.
        </p>

        <div style="background: #fff5f5; padding: 16px; border-radius: 8px; margin: 16px 0;">
          <p><strong>Date:</strong> ${date}</p>
          <p><strong>Time:</strong> ${time}</p>
          <p><strong>Status:</strong> Not available</p>
        </div>

        <p>Browse other mentors and book another session.</p>

        <p style="color: #888; font-size: 13px; margin-top: 24px;">
          — The Mentorise Team
        </p>
      </div>
    `,
  });
};

// ─── Send OTP email ──────────────────────────────────────────────────────────
const sendOTPEmail = async ({ email, otp, firstName }) => {
  await sendMail({
    to: email,
    subject: "Your Mentorise Verification Code",
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: auto; padding: 24px; border: 1px solid #e5e7eb; border-radius: 12px;">
        <h2 style="color: #3A5BA0;">Verify Your Email 🔐</h2>
        <p>Hi <strong>${firstName}</strong>,</p>
        <p>Use the OTP below to complete your registration.</p>

        <div style="background: #f0f4ff; padding: 24px; border-radius: 8px; margin: 20px 0; text-align: center;">
          <h1 style="font-size: 42px; letter-spacing: 12px; color: #3A5BA0;">
            ${otp}
          </h1>
          <p>Valid for 10 minutes</p>
        </div>

        <p>If you didn’t request this, ignore this email.</p>

        <p style="color: #888; font-size: 13px; margin-top: 24px;">
          — The Mentorise Team
        </p>
      </div>
    `,
  });
};

// ─── Send password reset email ───────────────────────────────────────────────
const sendPasswordResetEmail = async ({
  email,
  firstName,
  resetLink,
}) => {
  await sendMail({
    to: email,
    subject: "Reset Your Mentorise Password",
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: auto; padding: 24px; border: 1px solid #e5e7eb; border-radius: 12px;">
        <h2 style="color: #3A5BA0;">Reset Your Password 🔑</h2>
        <p>Hi <strong>${firstName}</strong>,</p>

        <div style="text-align: center; margin: 32px 0;">
          <a href="${resetLink}"
             style="background-color: #3A5BA0; color: white; padding: 14px 32px; border-radius: 8px; text-decoration: none;">
             Reset Password
          </a>
        </div>

        <p>This link expires in 15 minutes.</p>

        <p style="color: #888; font-size: 13px; margin-top: 24px;">
          — The Mentorise Team
        </p>
      </div>
    `,
  });
};

// ─── Send session reminder email ─────────────────────────────────────────────
const sendSessionReminderEmail = async ({
  email,
  firstName,
  otherName,
  date,
  time,
  sessionId,
  userId,
  isGroup,
  groupTitle,
}) => {
  const joinLink = isGroup
    ? `${process.env.APP_URL}/group-video-call/${sessionId}?userId=${userId}`
    : `${process.env.APP_URL}/video-call/${sessionId}?userId=${userId}`;

  const sessionLabel = isGroup
    ? `Group Session: ${groupTitle}`
    : `1-on-1 Session with ${otherName}`;

  await sendMail({
    to: email,
    subject: "⏰ Reminder: Your session starts in 30 minutes!",
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: auto; padding: 24px; border: 1px solid #e5e7eb; border-radius: 12px;">
        <h2 style="color: #3A5BA0;">Session Starting Soon! ⏰</h2>
        <p>Hi <strong>${firstName}</strong>,</p>

        <div style="background: #f0f4ff; padding: 16px; border-radius: 8px;">
          <p><strong>Session:</strong> ${sessionLabel}</p>
          <p><strong>Date:</strong> ${date}</p>
          <p><strong>Time:</strong> ${time}</p>
        </div>

        <div style="text-align: center; margin: 24px 0;">
          <a href="${joinLink}"
             style="background-color: #3A5BA0; color: white; padding: 14px 32px; border-radius: 8px; text-decoration: none;">
             Join Video Call
          </a>
        </div>

        <p style="color: #888; font-size: 13px; margin-top: 24px;">
          — The Mentorise Team
        </p>
      </div>
    `,
  });
};

module.exports = {
  sendSessionAcceptedToMentee,
  sendSessionRejectedToMentee,
  sendOTPEmail,
  sendPasswordResetEmail,
  sendSessionReminderEmail,
};