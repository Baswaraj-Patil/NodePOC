require("dotenv").config();

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const express = require("express");

const app = express();

const CANVAS_TEMPLATE = fs.readFileSync(
  path.join(__dirname, "views", "canvas.html"),
  "utf8"
);

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use("/public", express.static("public"));

function base64UrlDecode(input) {
  let normalized = input.replace(/-/g, "+").replace(/_/g, "/");
  while (normalized.length % 4) normalized += "=";
  return Buffer.from(normalized, "base64");
}

function verifyAndDecodeSignedRequest(signedRequest, consumerSecret) {
  if (!signedRequest) {
    throw new Error("Missing signed_request");
  }

  const [encodedSig, encodedEnvelope] = signedRequest.split(".");

  if (!encodedSig || !encodedEnvelope) {
    throw new Error("Invalid signed_request format");
  }

  const expectedSig = crypto
    .createHmac("sha256", consumerSecret)
    .update(encodedEnvelope)
    .digest();

  const actualSig = base64UrlDecode(encodedSig);

  if (
    expectedSig.length !== actualSig.length ||
    !crypto.timingSafeEqual(expectedSig, actualSig)
  ) {
    throw new Error("Invalid signed_request signature");
  }

  const json = base64UrlDecode(encodedEnvelope).toString("utf8");
  return JSON.parse(json);
}

app.get("/", (req, res) => {
  res.send("Salesforce Canvas Product Pricing POC is running.");
});

app.get("/health", (req, res) => {
  res.json({ ok: true });
});

app.post("/canvas", (req, res) => {
  try {
    console.log("Canvas POST received");
    console.log("Body keys:", Object.keys(req.body));

    const decoded = verifyAndDecodeSignedRequest(
      req.body.signed_request,
      process.env.SALESFORCE_CONSUMER_SECRET
    );

    console.log("Canvas context environment:");
    console.log(JSON.stringify(decoded.context?.environment || {}, null, 2));

    res.send(renderHtml(decoded));
  } catch (err) {
    console.error("Canvas authentication failed:", err);
    res.status(401).send(`
      <h2>Canvas authentication failed</h2>
      <pre>${escapeHtml(err.message)}</pre>
    `);
  }
});

app.get("/canvas", (req, res) => {
  res.send(`
    <h2>Canvas endpoint is working</h2>
    <p>This endpoint must be opened from Salesforce Canvas because Salesforce sends signed_request using POST.</p>
  `);
});

function renderHtml(signedRequestJson) {
  const safeSignedRequestJson = JSON.stringify(signedRequestJson).replace(
    /</g,
    "\\u003c"
  );

  return CANVAS_TEMPLATE.replace("__SIGNED_REQUEST_JSON__", function () {
    return safeSignedRequestJson;
  });
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

const port = process.env.PORT || 3000;

app.listen(port, () => {
  console.log("Canvas app running on port " + port);
});
