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

/* ----------------------------------
   Health route (for ping services)
-----------------------------------*/
app.get("/", (req, res) => {
  res.send("Backend alive");
});

/* ----------------------------------
   Payment endpoint
-----------------------------------*/
app.post("/api/runPrompt", async (req, res) => {
  console.log("Incoming payment:", req.body);

  const { phone, amount, local_id, transaction_desc, till_id } = req.body;

  if (!phone || !amount || !local_id) {
    return res
      .status(400)
      .json({ status: false, msg: "Missing required fields" });
  }

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
     Select API key
  -----------------------------------*/
  let selectedApiKey = process.env.NESTLINK_API_KEY;

  if (till_id) {
    const dynamicKey = process.env[`NESTLINK_KEY_${till_id}`];
    if (dynamicKey) {
      selectedApiKey = dynamicKey;
    }
  }

  if (!selectedApiKey) {
    console.error("Missing Nestlink API key");
    return res.status(500).json({
      status: false,
      msg: "Server configuration error",
    });
  }

  try {
    /* ----------------------------------
       Timeout protection
    -----------------------------------*/
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);

    const nestRes = await fetch("https://api.nestlink.co.ke/runPrompt", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Api-Secret": selectedApiKey,
      },
      body: JSON.stringify({
        phone: formattedPhone,
        amount,
        local_id,
        transaction_desc,
      }),
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!nestRes.ok) {
      const text = await nestRes.text();

      console.error("NestLink STATUS:", nestRes.status);
      console.error("NestLink RESPONSE:", text);

      return res.status(500).json({
        status: false,
        msg: "NestLink request failed",
        code: nestRes.status,
        raw: text || "empty response",
      });
    }

    const data = await nestRes.json();
    console.log("NestLink response:", data);

    return res.json({
      status: data.status,
      msg: data.status ? "STK Push sent" : "Payment failed",
      data,
    });
  } catch (err) {
    console.error("Server error:", err);

    if (err.name === "AbortError") {
      return res.status(500).json({
        status: false,
        msg: "Request timeout contacting Nestlink",
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
