import express from "express";
import fetch from "node-fetch";
import cors from "cors";
import dotenv from "dotenv";

dotenv.config();

const app = express();

app.use(
  cors({
    origin: true,
    credentials: true,
  })
);

app.use(express.json());

const PORT = process.env.PORT || 5000;

/* ==================================
   IN-MEMORY SAFETY LAYERS
================================== */
const activeTransactions = new Map(); // prevents duplicate STKs
const statusThrottle = new Map();     // prevents API spam

/* ----------------------------------
   Health route
-----------------------------------*/
app.get("/", (req, res) => {
  res.send("Backend alive (SmartPay)");
});

/* ----------------------------------
   PAYMENT ENDPOINT (SAFE VERSION)
-----------------------------------*/
app.post("/api/runPrompt", async (req, res) => {
  console.log("Incoming payment:", req.body);

  const { phone, amount, local_id, transaction_desc, till_id } = req.body;

  if (!phone || !amount || !local_id) {
    return res.status(400).json({
      status: false,
      msg: "Missing required fields",
    });
  }

  /* ----------------------------------
     DEDUPLICATION (PREVENT DOUBLE STK)
  -----------------------------------*/
  if (activeTransactions.has(local_id)) {
    return res.status(429).json({
      status: false,
      msg: "Duplicate transaction blocked",
      error: "DUPLICATE_REQUEST",
    });
  }

  activeTransactions.set(local_id, Date.now());

  /* ----------------------------------
     Phone normalization
  -----------------------------------*/
  let formattedPhone = phone.toString().replace(/\D/g, "");

  if (formattedPhone.startsWith("07") || formattedPhone.startsWith("01")) {
    formattedPhone = "254" + formattedPhone.slice(1);
  } else if (formattedPhone.startsWith("0")) {
    formattedPhone = "254" + formattedPhone.slice(1);
  } else if (!formattedPhone.startsWith("254")) {
    return res.status(400).json({
      status: false,
      msg: "Invalid phone number format",
    });
  }

  /* ----------------------------------
     Select API key (SmartPay)
  -----------------------------------*/
  let selectedApiKey = process.env.SMARTPAY_API_KEY;

  if (till_id) {
    const dynamicKey = process.env[`SMARTPAY_KEY_${till_id}`];
    if (dynamicKey) {
      selectedApiKey = dynamicKey;
    }
  }

  if (!selectedApiKey) {
    console.error("Missing SmartPay API key");
    return res.status(500).json({
      status: false,
      msg: "Server configuration error",
    });
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 90000);

    const smartRes = await fetch(
      "https://api.smartpaypesa.com/v1/stk/push",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${selectedApiKey}`,
        },
        body: JSON.stringify({
          phone: formattedPhone,
          amount: Number(amount),
          account_reference: local_id,
          description: transaction_desc || "Payment",
        }),
        signal: controller.signal,
      }
    );

    clearTimeout(timeout);

    const rawText = await smartRes.text();

    let data;
    try {
      data = JSON.parse(rawText);
    } catch {
      data = { raw: rawText };
    }

    /* ----------------------------------
       SMARTPAY ERROR HANDLING FIX
    -----------------------------------*/
    if (!smartRes.ok || !data.success) {
      console.error("SmartPay ERROR:", data);

      if (data.error_code === "LIMIT_REACHED") {
        return res.status(429).json({
          status: false,
          msg: "Too many requests. Please wait.",
          error: "LIMIT_REACHED",
        });
      }

      if (data.error_code === "FRAUD_BLOCK_FAILURE_RATE") {
        return res.status(403).json({
          status: false,
          msg: "Temporarily blocked due to high failure rate.",
          error: "FRAUD_BLOCK",
        });
      }

      return res.status(500).json({
        status: false,
        msg: data.message || "SmartPay request failed",
        error: data.error_code || "UNKNOWN_ERROR",
        raw: data,
      });
    }

    console.log("SmartPay response:", data);

    return res.json({
      status: true,
      msg: "STK Push sent",
      checkout_request_id: data.checkout_request_id,
      data,
    });

  } catch (err) {
    console.error("Server error:", err);

    if (err.name === "AbortError") {
      return res.status(500).json({
        status: false,
        msg: "Request timeout contacting SmartPay",
      });
    }

    return res.status(500).json({
      status: false,
      msg: "Server error",
      error: err.message,
    });
  }
});

/* ----------------------------------
   OPTIONAL CALLBACK
-----------------------------------*/
app.post("/api/smartpay-callback", (req, res) => {
  console.log("SmartPay CALLBACK:", JSON.stringify(req.body, null, 2));

  const callback = req.body?.Body?.stkCallback;

  if (callback?.ResultCode === 0) {
    console.log("✅ Payment SUCCESS");
  } else {
    console.log("❌ Payment FAILED:", callback?.ResultDesc);
  }

  res.sendStatus(200);
});

/* ----------------------------------
   STATUS ENDPOINT (RATE LIMITED)
-----------------------------------*/
app.get("/api/status/:checkoutId", async (req, res) => {
  const id = req.params.checkoutId;
  const now = Date.now();

  const last = statusThrottle.get(id);

  // prevent spam polling
  if (last && now - last < 5000) {
    return res.status(429).json({
      success: false,
      message: "Too many status requests",
    });
  }

  statusThrottle.set(id, now);

  try {
    const response = await fetch(
      `https://api.smartpaypesa.com/v1/transactions/${id}`,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${process.env.SMARTPAY_API_KEY}`,
        },
      }
    );

    const data = await response.json();

    console.log("Transaction Status:", data);

    res.json(data);
  } catch (err) {
    console.error(err);

    res.status(500).json({
      success: false,
      message: "Unable to check transaction",
    });
  }
});

/* ----------------------------------
   CLEANUP OLD TRANSACTIONS
-----------------------------------*/
setInterval(() => {
  const now = Date.now();

  for (const [key, time] of activeTransactions.entries()) {
    if (now - time > 10 * 60 * 1000) {
      activeTransactions.delete(key);
    }
  }
}, 60 * 1000);

/* ----------------------------------
   Crash protection
-----------------------------------*/
process.on("uncaughtException", (err) => {
  console.error("Uncaught Exception:", err);
});

process.on("unhandledRejection", (err) => {
  console.error("Unhandled Rejection:", err);
});

app.listen(PORT, () => {
  console.log(`Backend running on port ${PORT}`);
});
