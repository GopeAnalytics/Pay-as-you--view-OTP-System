require("dotenv").config();
const express = require("express");
const mysql = require("mysql2");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const cors = require("cors");
const bodyParser = require("body-parser");
const nodemailer = require("nodemailer");
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET;

const app = express();
app.use(cors());
app.post(
  "/webhook/stripe",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    console.log(" Webhook received at /webhook/stripe");

    let event;
    try {
      event = stripe.webhooks.constructEvent(
        req.body,
        req.headers["stripe-signature"],
        endpointSecret
      );
      console.log(" Webhook Verified:", event.type);
    } catch (err) {
      console.error(" Webhook Signature Verification Failed:", err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    if (event.type === "checkout.session.completed") {
      const session = event.data.object;
      const email = session.customer_email;
      const otp = generateOTP();

      console.log(` Sending OTP: ${otp} to ${email}`);

      db.query(
        "INSERT INTO user_access (email, otp) VALUES (?, ?) ON DUPLICATE KEY UPDATE otp = ?",
        [email, otp, otp],
        (err) => {
          if (err) {
            console.error(" Database Error:", err);
            return res.status(500).send("Database Error");
          }
          console.log(" OTP stored in database:", otp);
          sendOTPEmail(email, otp);
          console.log(" OTP Email Sent to", email);
        }
      );
    } else {
      console.log(`Unhandled event type: ${event.type}`);
    }

    res.json({ received: true });
  }
);
app.use(bodyParser.json());
app.use(express.json());

const SECRET_KEY = process.env.SECRET_KEY;

//  MySQL Database Connection
const db = mysql.createConnection({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASS,
  database: process.env.DB_NAME,
});

db.connect((err) => {
  if (err) {
    console.error(" MySQL Connection Error:", err);
    throw err;
  }
  console.log(" MySQL Connected");
});

//  Admin Registration Route
app.post("/api/admin/register", async (req, res) => {
  console.log(" Received Admin Registration Request");
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ message: "Email and password are required" });
  }

  db.query(
    "SELECT * FROM admin WHERE email = ?",
    [email],
    async (err, result) => {
      if (err) return res.status(500).json({ message: "Database Error" });

      if (result.length > 0) {
        return res.status(400).json({ message: "Admin already exists" });
      }

      const hashedPassword = await bcrypt.hash(password, 10);

      db.query(
        "INSERT INTO admin (email, password) VALUES (?, ?)",
        [email, hashedPassword],
        (err) => {
          if (err) {
            console.error(" Database Error:", err);
            return res.status(500).json({ message: "Database Error" });
          }
          res.status(201).json({ message: "Admin Registered Successfully" });
        }
      );
    }
  );
});

// Function to Generate 4-Digit OTP
function generateOTP() {
  return Math.floor(1000 + Math.random() * 9000).toString();
}

//  Function to Send OTP Email
async function sendOTPEmail(email, otp) {
  let transporter = nodemailer.createTransport({
    service: "Gmail",
    auth: {
      user: process.env.EMAIL_USER,
      pass: process.env.EMAIL_PASS,
    },
  });

  let mailOptions = {
    from: process.env.EMAIL_USER,
    to: email,
    subject: "Your See Code",
    text: `Your See Code (OTP) is: ${otp}`,
  };

  await transporter.sendMail(mailOptions);
  console.log(` OTP Sent to ${email}`);
}

app.post("/api/create-checkout-session", async (req, res) => {
  const { email } = req.body;

  if (!email) {
    return res.status(400).json({ message: "Email is required for payment" });
  }

  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      mode: "payment",
      customer_email: email,
      line_items: [
        {
          price_data: {
            currency: "usd",
            product_data: { name: "Lifetime Video Access" },
            unit_amount: 1000, // $10.00
          },
          quantity: 1,
        },
      ],
      success_url: `http://localhost:5000/payment-success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `http://localhost:5000/payment-cancelled`,
    });

    console.log(" Created Checkout Session:", session.id, "URL:", session.url);
    res.json({ id: session.id, url: session.url });
  } catch (error) {
    console.error("Stripe Error:", error);
    res.status(500).json({ message: "Stripe Payment Error" });
  }
});

//  Success Page Route
app.get("/payment-success", (req, res) => {
  res.send(`
        <h2> Payment Successful!</h2>
        <p>Thank you for your purchase.</p>
        <a href="/">Go back to Home</a>
    `);
});

//  Cancel Page Route
app.get("/payment-cancelled", (req, res) => {
  res.send(`
        <h2> Payment Cancelled!</h2>
        <p>Your payment was not completed.</p>
        <a href="/">Try Again</a>
    `);
});

//  User Sign-In Verification (Using OTP)
app.post("/api/signin", (req, res) => {
  const { email, otp } = req.body;

  db.query(
    "SELECT * FROM user_access WHERE email = ? AND otp = ?",
    [email, otp],
    (err, result) => {
      if (err) return res.status(500).json({ error: "Database Error" });

      if (result.length > 0) {
        res.status(200).json({ message: "Access Granted" });
      } else {
        res.status(401).json({ error: "Invalid Credentials" });
      }
    }
  );
});

//  Admin Login Route (Verify Hashed Password)
app.post("/api/admin/login", (req, res) => {
  const { email, password } = req.body;

  db.query(
    "SELECT * FROM admin WHERE email = ?",
    [email],
    async (err, result) => {
      if (err) return res.status(500).json({ message: "Database Error" });

      if (result.length === 0) {
        return res.status(401).json({ message: "Admin Not Found" });
      }

      //  Compare Entered Password with Hashed Password
      const isPasswordValid = await bcrypt.compare(
        password,
        result[0].password
      );
      if (!isPasswordValid) {
        return res.status(401).json({ message: "Invalid Credentials" });
      }

      //  Generate JWT Token for Admin Session
      const token = jwt.sign({ email }, SECRET_KEY, { expiresIn: "1h" });

      res.status(200).json({ message: "Authenticated", token });
    }
  );
});

//  Admin Password Reset Request
app.post("/api/admin/reset-password", async (req, res) => {
  const { email } = req.body;

  db.query(
    "SELECT * FROM admin WHERE email = ?",
    [email],
    async (err, result) => {
      if (err) return res.status(500).json({ message: "Database Error" });

      if (result.length === 0) {
        return res.status(404).json({ message: "Admin Not Found" });
      }

      //  Generate Reset Token (Valid for 10 Minutes)
      const resetToken = jwt.sign({ email }, SECRET_KEY, { expiresIn: "10m" });

      //  Send Reset Link via Email
      let transporter = nodemailer.createTransport({
        service: "Gmail",
        auth: {
          user: process.env.EMAIL_USER,
          pass: process.env.EMAIL_PASS,
        },
      });

      let mailOptions = {
        from: process.env.EMAIL_USER,
        to: email,
        subject: "Admin Password Reset",
        text: `Click this link to reset your password: http://localhost:5000/reset-password/${resetToken}`,
      };

      await transporter.sendMail(mailOptions);
      res.status(200).json({ message: "Password Reset Link Sent" });
    }
  );
});

//  Middleware to Verify Admin Authentication
function verifyAdminToken(req, res, next) {
  const token = req.headers["authorization"];
  if (!token) return res.status(403).json({ message: "No token provided" });

  jwt.verify(token.split(" ")[1], SECRET_KEY, (err, decoded) => {
    if (err) return res.status(401).json({ message: "Unauthorized Access" });
    req.adminEmail = decoded.email;
    next();
  });
}

//  Cloudflare API Credentials
const CLOUDFLARE_ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID;
const CLOUDFLARE_API_KEY = process.env.CLOUDFLARE_API_KEY;

//  Video Upload to Cloudflare
app.post("/api/upload-video", async (req, res) => {
  const { title, description } = req.body;

  if (!title || !description) {
    return res
      .status(400)
      .json({ message: "Title and description are required!" });
  }

  try {
    let response = await axios.post(
      `https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/stream`,
      { meta: { title: title } },
      { headers: { Authorization: `Bearer ${CLOUDFLARE_API_KEY}` } }
    );

    if (response.data.success) {
      const videoId = response.data.result.uid;

      //  Store Video URL in Database
      db.query(
        "INSERT INTO videos (title, description, video_url) VALUES (?, ?, ?)",
        [title, description, `https://watch.cloudflarestream.com/${videoId}`],
        (err) => {
          if (err) return res.status(500).json({ message: "Database Error" });
          res
            .status(200)
            .json({ message: "Video Uploaded Successfully!", videoId });
        }
      );
    } else {
      res.status(500).json({ message: "Cloudflare Upload Failed" });
    }
  } catch (error) {
    console.error("Cloudflare Upload Error:", error);
    res.status(500).json({ message: "Cloudflare Upload Error" });
  }
});

//  Retrieve All Videos
app.get("/api/videos", (req, res) => {
  db.query("SELECT * FROM videos", (err, results) => {
    if (err) return res.status(500).json({ error: "Database Error" });

    res.status(200).json(results);
  });
});

//  Start Server
app.listen(5000, () => console.log("Server Running on Port 5000"));
