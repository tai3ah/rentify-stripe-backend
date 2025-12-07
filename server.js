// ============================================================
// Rentify Stripe Backend (Malaysia - Separate Charges + Transfers)
// ============================================================

import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import Stripe from "stripe";

dotenv.config();

const app = express();
const port = 4242;

// ------------------------------------------------------------
// INITIALISE STRIPE
// ------------------------------------------------------------
if (!process.env.STRIPE_SECRET_KEY) {
  console.error("❌ ERROR: STRIPE_SECRET_KEY missing in .env");
  process.exit(1);
}

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: "2024-09-30.acacia",
});

app.use(cors({ origin: "*" }));
app.use(express.json());

// ------------------------------------------------------------
// HEALTH CHECK
// ------------------------------------------------------------
app.get("/", (req, res) => {
  res.send("Rentify backend OK ⚡");
});

/* ============================================================
   CREATE STRIPE CUSTOMER (Renter)
============================================================ */
app.post("/create-stripe-customer", async (req, res) => {
  try {
    const { email, name, userId } = req.body;

    const customer = await stripe.customers.create({
      email,
      name,
      metadata: { userId: userId ?? "" },
    });

    return res.json({ customerId: customer.id });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

/* ============================================================
   CREATE CONNECT ACCOUNT (Owner)
============================================================ */
app.post("/create-connect-account", async (req, res) => {
  try {
    const { email } = req.body;

    const account = await stripe.accounts.create({
      type: "standard",
      country: "MY",
      email,
      business_type: "individual",
      capabilities: {
        card_payments: { requested: true },
        transfers: { requested: true },
      },
    });

    return res.json({ accountId: account.id });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

/* ============================================================
   CREATE ONBOARDING LINK
============================================================ */
app.post("/create-connect-account-link", async (req, res) => {
  try {
    const { accountId } = req.body;

    const link = await stripe.accountLinks.create({
      account: accountId,
      refresh_url: "https://example.com/reauth",
      return_url: "https://example.com/return",
      type: "account_onboarding",
    });

    return res.json({ url: link.url });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

/* ============================================================
   CREATE PAYMENT INTENT (Separate Charges + Transfers)
============================================================ */
app.post("/create-payment-intent", async (req, res) => {
  try {
    const {
      amount,
      customerId,
      ownerConnectAccountId,
      description = "Rentify booking",
      currency = "myr",
      platformFee = 0
    } = req.body;

    if (!amount || !customerId || !ownerConnectAccountId) {
      return res.status(400).json({ error: "Missing fields" });
    }

    // ✨ CHANGED — Create a unique transfer_group each time
    const transferGroup = `booking_${Date.now()}`;

    const paymentIntent = await stripe.paymentIntents.create({
      amount,
      currency,
      customer: customerId,
      automatic_payment_methods: { enabled: true },

      // ✨ CHANGED — Keep immediate transfer
      transfer_data: { 
        destination: ownerConnectAccountId,
      },

      // ✨ CHANGED — Correctly link transfer + charge
      transfer_group: transferGroup,

      application_fee_amount: platformFee,
      description
    });

    return res.json({
      clientSecret: paymentIntent.client_secret,
      paymentIntentId: paymentIntent.id,
      transferGroup   // ✨ return this (optional)
    });

  } catch (err) {
    console.error("❌ PaymentIntent error:", err.message);
    return res.status(500).json({ error: err.message });
  }
});

/* ============================================================
   REFUND + REVERSE TRANSFER
============================================================ */
app.post("/refund", async (req, res) => {
  try {
    const { paymentIntentId } = req.body;

    if (!paymentIntentId) {
      return res.status(400).json({ error: "Missing paymentIntentId" });
    }

    // 1️⃣ Refund renter
    const refund = await stripe.refunds.create({
      payment_intent: paymentIntentId,
    });

    // 2️⃣ Retrieve PaymentIntent to get transfer_group
    const pi = await stripe.paymentIntents.retrieve(paymentIntentId);
    const group = pi.transfer_group;

    if (!group) {
      console.log("⚠ No transfer_group on PI → cannot reverse transfer");
      return res.json({
        success: true,
        refundId: refund.id,
        refundStatus: refund.status,
        transferReversed: false
      });
    }

    // 3️⃣ Find transfers linked to this PI
    const transfers = await stripe.transfers.list({
      transfer_group: group,
    });

    let reversal = null;

    // 4️⃣ Reverse each transfer (correct API)
    for (const t of transfers.data) {
      reversal = await stripe.transfers.createReversal(t.id, {
        amount: t.amount,   // FULL reversal
      });
    }

    return res.json({
      success: true,
      refundId: refund.id,
      refundStatus: refund.status,
      transferReversed: !!reversal,
      reversal
    });

  } catch (err) {
    console.error("❌ Refund error:", err);
    return res.status(500).json({ error: err.message });
  }
});
/* ============================================================
   SETUP INTENT (Save card)
============================================================ */
app.post("/create-setup-intent", async (req, res) => {
  try {
    const { customerId } = req.body;

    const setupIntent = await stripe.setupIntents.create({
      customer: customerId,
      automatic_payment_methods: { enabled: true },
    });

    return res.json({ clientSecret: setupIntent.client_secret });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

/* ============================================================
   EPHEMERAL KEY
============================================================ */
app.post("/create-ephemeral-key", async (req, res) => {
  try {
    const { customerId } = req.body;

    const key = await stripe.ephemeralKeys.create(
      { customer: customerId },
      { apiVersion: "2024-09-30.acacia" }
    );

    return res.json({ ephemeralKey: key.secret });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

/* ============================================================
   LIST CARDS
============================================================ */
app.get("/list-payment-methods/:customerId", async (req, res) => {
  try {
    const methods = await stripe.paymentMethods.list({
      customer: req.params.customerId,
      type: "card",
    });

    return res.json({ methods: methods.data });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

/* ============================================================
   DETACH CARD
============================================================ */
app.post("/detach-payment-method", async (req, res) => {
  try {
    const detached = await stripe.paymentMethods.detach(req.body.paymentMethodId);
    return res.json({ success: true, id: detached.id });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

/* ============================================================
   PUBLISHABLE KEY
============================================================ */
app.get("/config", (req, res) => {
  res.json({ publishableKey: process.env.STRIPE_PUBLISHABLE_KEY });
});

app.listen(port, () =>
  console.log(`🚀 Rentify server running on http://localhost:${port}`)
);


/* ============================================================
   TRANSACTION HISTORY – RENTER (customerId based)
============================================================ */
app.post("/transactions/renter", async (req, res) => {
  try {
    const { customerId } = req.body;
    if (!customerId) {
      return res.status(400).json({ error: "Missing customerId" });
    }

    // 1) List recent charges (payments) for this customer
    const charges = await stripe.charges.list({
      customer: customerId,
      limit: 50,                      // adjust as you like
    });

    const payments = charges.data.map((c) => ({
      id: c.id,
      amount: c.amount,
      amountRm: c.amount / 100,
      currency: c.currency,
      created: c.created,             // unix timestamp (seconds)
      type: "payment",
      direction: "out",
      paymentIntentId: c.payment_intent,
      description: c.description || "Payment",
      receiptUrl: c.receipt_url || null,
    }));

    // 2) List recent refunds and filter to this customer via charge.customer
    const refundsList = await stripe.refunds.list({
      limit: 50,
      expand: ["data.charge"],
    });

    const refunds = refundsList.data
      .filter((r) => r.charge && r.charge.customer === customerId)
      .map((r) => ({
        id: r.id,
        amount: r.amount,
        amountRm: r.amount / 100,
        currency: r.currency,
        created: r.created,
        type: "refund",
        direction: "in",
        paymentIntentId: r.payment_intent,
        description: "Refund",
        receiptUrl: r.charge?.receipt_url || null,
      }));

    const all = [...payments, ...refunds].sort(
      (a, b) => b.created - a.created
    );

    return res.json({ transactions: all });
  } catch (err) {
    console.error("❌ /transactions/renter error:", err);
    return res.status(500).json({ error: err.message });
  }
});


/* ============================================================
   TRANSACTION HISTORY – OWNER (Connect account based)
============================================================ */
app.post("/transactions/owner", async (req, res) => {
  try {
    const { connectAccountId } = req.body;
    if (!connectAccountId) {
      return res.status(400).json({ error: "Missing connectAccountId" });
    }

    const transfers = await stripe.transfers.list({
      destination: connectAccountId,
      limit: 50,
      expand: ["data.source_transaction.payment_intent", "data.reversals"],
    });

    const payouts = [];
    const reversals = [];

    for (const t of transfers.data) {
      const charge = t.source_transaction;
      const pi = charge?.payment_intent?.id ?? null;

      payouts.push({
        id: t.id,
        amount: t.amount,
        amountRm: t.amount / 100,
        currency: t.currency,
        created: t.created,
        type: "transfer",
        direction: "in",
        description: "Payout received",
        receiptUrl: charge?.receipt_url || null,
        paymentIntentId: pi   // <-- 🟦 FIX
      });

      const revs = t.reversals?.data || [];
      for (const rev of revs) {
        reversals.push({
          id: rev.id,
          amount: rev.amount,
          amountRm: rev.amount / 100,
          currency: t.currency,
          created: rev.created,
          type: "reverse_transfer",
          direction: "out",
          description: "Payout reversed",
          receiptUrl: charge?.receipt_url || null,
          paymentIntentId: pi   // <-- 🟦 FIX
        });
      }
    }

    const all = [...payouts, ...reversals].sort((a, b) => b.created - a.created);
    return res.json({ transactions: all });

  } catch (err) {
    console.error("❌ /transactions/owner error:", err);
    return res.status(500).json({ error: err.message });
  }
});

//delte acc
app.delete("/stripe/delete-accounts", async (req, res) => {
  try {
    const { customerId, connectAccountId } = req.body;

    if (!customerId && !connectAccountId) {
      return res.status(400).json({ success: false, message: "No Stripe IDs provided." });
    }

    const results = {};

    // --------------------------
    // Delete Stripe Customer (ALWAYS exists)
    // --------------------------
    if (customerId) {
      try {
        await stripe.customers.del(customerId);
        results.customerDeleted = true;
      } catch (err) {
        console.log("Customer delete error:", err.message);
        results.customerDeleted = false;
      }
    }

    // --------------------------
    // Delete Connect Account (ONLY if created)
    // --------------------------
    if (connectAccountId) {
      try {
        await stripe.accounts.del(connectAccountId);
        results.connectAccountDeleted = true;
      } catch (err) {
        console.log("Connect account delete error:", err.message);
        results.connectAccountDeleted = false;
      }
    } else {
      results.connectAccountDeleted = true; // No account = nothing to delete
    }

    return res.json({
      success: true,
      message: "Deletion attempted.",
      details: results
    });

  } catch (err) {
    console.error("Stripe delete error:", err);
    return res.status(500).json({ success: false, message: err.message });
  }
});
