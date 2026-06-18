// Express backend for the Salesforce Canvas Pricing Engine POC.
// Responsibilities:
//   1. Verify the HMAC-SHA256 `signed_request` POSTed by Salesforce Canvas.
//   2. Inject the decoded payload into the HTML template.
//   3. Serve that HTML back into the Canvas iframe.

require("dotenv").config();

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const express = require("express");

const app = express();

// Read the HTML template ONCE at startup (in-memory). Editing canvas.html
// requires a server restart to pick up changes (Render restarts on each deploy).
const CANVAS_TEMPLATE = fs.readFileSync(
  path.join(__dirname, "views", "canvas.html"),
  "utf8"
);

// Salesforce posts `signed_request` as application/x-www-form-urlencoded,
// so urlencoded parsing is required for POST /canvas to work.
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use("/public", express.static("public"));

// Decode URL-safe base64 (Salesforce uses `-`/`_` instead of `+`/`/`
// and strips trailing `=` padding). Restores standard base64, then decodes.
function base64UrlDecode(input) {
  let normalized = input.replace(/-/g, "+").replace(/_/g, "/");
  while (normalized.length % 4) normalized += "=";
  return Buffer.from(normalized, "base64");
}

// Security heart of the app: verifies the request actually came from Salesforce
// and returns the decoded JSON envelope (client OAuth token + context).
// Throws on any failure so the caller can return 401.
function verifyAndDecodeSignedRequest(signedRequest, consumerSecret) {
  if (!signedRequest) {
    throw new Error("Missing signed_request");
  }

  // Format is "<urlsafe-base64-sig>.<urlsafe-base64-envelope>"
  const [encodedSig, encodedEnvelope] = signedRequest.split(".");

  if (!encodedSig || !encodedEnvelope) {
    throw new Error("Invalid signed_request format");
  }

  // Recompute HMAC-SHA256 of the envelope using the Consumer Secret.
  const expectedSig = crypto
    .createHmac("sha256", consumerSecret)
    .update(encodedEnvelope)
    .digest();

  const actualSig = base64UrlDecode(encodedSig);

  // Constant-time comparison defeats per-byte timing attacks; the explicit
  // length check is required because timingSafeEqual throws on length mismatch.
  if (
    expectedSig.length !== actualSig.length ||
    !crypto.timingSafeEqual(expectedSig, actualSig)
  ) {
    throw new Error("Invalid signed_request signature");
  }

  // Envelope shape: { client: { oauthToken, instanceUrl, ... },
  //                   context: { user, organization, environment: { recordId, ... } } }
  const json = base64UrlDecode(encodedEnvelope).toString("utf8");
  return JSON.parse(json);
}

app.get("/", (req, res) => {
  res.send("Salesforce Canvas Product Pricing POC is running.");
});

// Lightweight health check for uptime monitors / Render readiness.
app.get("/health", (req, res) => {
  res.json({ ok: true });
});

// Real entry point: Salesforce Canvas POSTs the signed_request here.
// Verifies the signature, then renders the HTML with the payload injected.
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
    // Any verification failure (missing/malformed/forged) collapses to 401.
    // err.message is escaped to avoid reflecting attacker input as HTML.
    console.error("Canvas authentication failed:", err);
    res.status(401).send(`
      <h2>Canvas authentication failed</h2>
      <pre>${escapeHtml(err.message)}</pre>
    `);
  }
});

// Friendly fallback if a human opens /canvas in a browser directly
// (Salesforce always uses POST, so GET cannot deliver a signed_request).
app.get("/canvas", (req, res) => {
  res.send(`
    <h2>Canvas endpoint is working</h2>
    <p>This endpoint must be opened from Salesforce Canvas because Salesforce sends signed_request using POST.</p>
  `);
});

// Inject the decoded signed-request JSON into the HTML template.
// - Escapes `<` to `\u003c` so a stray `</script>` inside any string value
//   cannot break out of the inline <script> tag.
// - Uses a FUNCTION replacer (not a string) because OAuth tokens commonly
//   contain `$`, which String.prototype.replace interprets as special tokens
//   ($&, $1, $$). The function form returns the value verbatim.
function renderHtml(signedRequestJson) {
  const safeSignedRequestJson = JSON.stringify(signedRequestJson).replace(
    /</g,
    "\\u003c"
  );

  return CANVAS_TEMPLATE.replace("__SIGNED_REQUEST_JSON__", function () {
    return safeSignedRequestJson;
  });
}

// HTML-entity escape for the 401 error page only. Client-side rendering of
// product names uses a separate escape in canvas.html.
function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

// Render injects PORT at runtime; 3000 is the local-dev fallback.
const port = process.env.PORT || 3000;

app.listen(port, () => {
  console.log("Canvas app running on port " + port);
});
