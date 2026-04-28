const nodemailer = require("nodemailer");
const dns = require("dns");

// ─── Force IPv4 by resolving smtp.gmail.com to an IPv4 address at runtime ───
// Render free tier blocks IPv6. The `family: 4` option in nodemailer is not
// reliable across all Node versions on Render. Instead we manually resolve
// smtp.gmail.com to its IPv4 address using dns.resolve4() and connect directly
// to that IP, which guarantees no IPv6 is ever attempted.
// ─────────────────────────────────────────────────────────────────────────────

let transporter = null;

const createTransporter = () => {
  return new Promise((resolve, reject) => {
    dns.resolve4("smtp.gmail.com", (err, addresses) => {
      if (err || !addresses || addresses.length === 0) {
        console.error("DNS resolve error:", err?.message);
        // Fallback: use hostname directly (may still work on some Render regions)
        resolve(nodemailer.createTransport({
          host: "smtp.gmail.com",
          port: 587,
          secure: false,
          auth: {
            user: process.env.GMAIL_USER,
            pass: process.env.GMAIL_PASS,
          },
          tls: { rejectUnauthorized: false },
        }));
        return;
      }

      const ipv4 = addresses[0]; // e.g. "209.85.145.108"
      console.log(`Connecting to Gmail SMTP via IPv4: ${ipv4}`);

      resolve(nodemailer.createTransport({
        host: ipv4,          // direct IPv4 — no DNS lookup, no IPv6
        port: 587,
        secure: false,
        auth: {
          user: process.env.GMAIL_USER,
          pass: process.env.GMAIL_PASS,
        },
        tls: {
          rejectUnauthorized: false,
          servername: "smtp.gmail.com", // SNI: tell Gmail which cert to present
        },
      }));
    });
  });
};

// ─── Generic send mail function ──────────────────────────────────────────────
// Lazily initialises the transporter on first use so DNS resolution
// happens after the server is fully started.
const sendMail = async ({ to, subject, html }) => {
  try {
    if (!transporter) {
      transporter = await createTransporter();
    }

    const info = await transporter.sendMail({
      from: `"Mentorise" <${process.env.GMAIL_USER}>`,
      to,
      subject,
      html,
    });
    console.log(`Email sent to ${to} | messageId: ${info.messageId}`);
    return true;
  } catch (err) {
    console.error("Email send error:", err.message);
    // Reset transporter so next call re-resolves DNS (IP may have rotated)
    transporter = null;
    return false;
  }
};

// ─── Startup verification (non-blocking) ─────────────────────────────────────
(async () => {
  try {
    if (!transporter) {
      transporter = await createTransporter();
    }
    await transporter.verify();
    console.log("Gmail transporter ready ✅");
  } catch (err) {
    console.error("Gmail transporter error:", err.message);
    transporter = null; // will retry on first email send
  }
})();

// ─── Send OTP email ──────────────────────────────────────────────────────────
const sendOTPEmail = async ({ email, otp, firstName }) => {
  await sendMail({
    to: email,
    subject: "Your Mentorise Verification Code",
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: auto; padding: 24px; border: 1px solid #e5e7eb; border-radius: 12px;">
        <h2 style="color: #3A5BA0;">Verify Your Email 🔐</h2>
        <p>Hi <strong>${firstName}</strong>,</p>
        <p>Use the OTP below to complete your request.</p>

        <div style="background: #f0f4ff; padding: 24px; border-radius: 8px; margin: 20px 0; text-align: center;">
          <h1 style="font-size: 42px; letter-spacing: 12px; color: #3A5BA0; margin: 0;">
            ${otp}
          </h1>
          <p style="margin: 8px 0 0;">Valid for 10 minutes</p>
        </div>

        <p>If you didn't request this, you can safely ignore this email.</p>

        <p style="color: #888; font-size: 13px; margin-top: 24px;">
          — The Mentorise Team
        </p>
      </div>
    `,
  });
};

// ─── Send email to mentee when mentor ACCEPTS session ───────────────────────
const sendSessionAcceptedToMentee = async ({
  menteeEmail,
  menteeName,
  mentorName,
  date,
  time,
  sessionId,
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
        <p>Unfortunately, <strong>${mentorName}</strong> is unable to take your session.</p>

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

// ─── Send password reset email ───────────────────────────────────────────────
const sendPasswordResetEmail = async ({ email, firstName, resetLink }) => {
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

        <p>This link expires in 15 minutes. If you didn't request this, ignore this email.</p>

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