const nodemailer = require("nodemailer");
const dns = require("dns");

// ─── Force IPv4 by resolving smtp.gmail.com manually ─────────────────────────
let transporter = null;

const createTransporter = () => {
  return new Promise((resolve) => {
    dns.resolve4("smtp.gmail.com", (err, addresses) => {
      const host = (!err && addresses && addresses.length > 0)
        ? addresses[0]
        : "smtp.gmail.com";

      console.log(`Gmail SMTP connecting via: ${host}`);

      resolve(nodemailer.createTransport({
        host,
        port: 587,
        secure: false,
        auth: {
          user: process.env.GMAIL_USER,
          pass: process.env.GMAIL_PASS,
        },
        tls: {
          rejectUnauthorized: false,
          servername: "smtp.gmail.com",
        },
      }));
    });
  });
};

const sendMail = async ({ to, subject, html }) => {
  try {
    if (!transporter) {
      transporter = await createTransporter();
    }
    const info = await transporter.sendMail({
      from: `"Mentorise" <${process.env.GMAIL_USER}>`,
      to, subject, html,
    });
    console.log(`✅ Email sent to ${to} | messageId: ${info.messageId}`);
    return true;
  } catch (err) {
    console.error("❌ Email send error:", err.message);
    transporter = null; // reset so next call retries
    return false;
  }
};

// Startup check (non-blocking)
(async () => {
  try {
    transporter = await createTransporter();
    await transporter.verify();
    console.log("Gmail transporter ready ✅");
  } catch (err) {
    console.error("Gmail transporter error:", err.message);
    transporter = null;
  }
})();

// ─── Session Accepted Email ───────────────────────────────────────────────────
const sendSessionAcceptedToMentee = async ({ menteeEmail, menteeName, mentorName, date, time }) => {
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
        <p>To join the video call, go to <strong>My Bookings</strong> in your Mentorise account and click <strong>Join Video Call</strong>.</p>
        <p style="color: #888; font-size: 13px; margin-top: 24px;">— The Mentorise Team</p>
      </div>
    `,
  });
};

// ─── Session Rejected Email ───────────────────────────────────────────────────
const sendSessionRejectedToMentee = async ({ menteeEmail, menteeName, mentorName, date, time }) => {
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
        <p style="color: #888; font-size: 13px; margin-top: 24px;">— The Mentorise Team</p>
      </div>
    `,
  });
};

module.exports = { sendSessionAcceptedToMentee, sendSessionRejectedToMentee };