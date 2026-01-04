import express from "express";
import fetch from "node-fetch";
import cors from "cors";
import dotenv from "dotenv";

dotenv.config();

const app = express();

app.use(
  cors({
    origin: [
      "http://localhost:3000",
      "https://starlink-beta-jet.vercel.app",
    ],
  })
);

app.use(express.json());

const PORT = process.env.PORT || 5000;

app.post("/api/runPrompt", async (req, res) => {
  console.log("Incoming payment:", req.body);

  const { phone, amount, local_id, transaction_desc } = req.body;

  if (!phone || !amount || !local_id) {
    return res.status(400).json({ status: false, msg: "Missing required fields" });
  }

  let formattedPhone = phone;
  if (phone.startsWith("0")) {
    formattedPhone = "254" + phone.slice(1);
  }

  try {
    const nestRes = await fetch("https://api.nestlink.co.ke/runPrompt", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Api-Secret": process.env.NESTLINK_API_KEY,
      },
      body: JSON.stringify({
        phone: formattedPhone,
        amount,
        local_id,
        transaction_desc,
      }),
    });

    if (!nestRes.ok) {
      const text = await nestRes.text();
      console.error("NestLink error:", text);
      return res.status(500).json({
        status: false,
        msg: "NestLink request failed",
        raw: text,
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
    return res.status(500).json({
      status: false,
      msg: "Server error",
      error: err.message,
    });
  }
});

app.listen(PORT, () => {
  console.log(`Backend running on port ${PORT}`);
});
