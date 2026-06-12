require("dotenv").config();

const crypto = require("crypto");
const express = require("express");

const app = express();

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

  return `
<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Product Pricing Canvas SDK POC</title>
  <link rel="stylesheet" href="/public/app.css" />

  <!-- Salesforce Canvas SDK -->
  <script src="https://login.salesforce.com/canvas/sdk/js/canvas-all.js"></script>
</head>
<body>
  <div class="container">
    <h2>Product Pricing Canvas SDK POC</h2>

    <p>
      Opportunity Id:
      <strong id="oppId">Loading...</strong>
    </p>

    <div id="message"></div>

    <table>
      <thead>
        <tr>
          <th>Select</th>
          <th>Product</th>
          <th>Unit Price</th>
          <th>Quantity</th>
        </tr>
      </thead>
      <tbody id="productRows"></tbody>
    </table>

    <button id="submitBtn">Send Selected Products to Salesforce</button>
  </div>

<script>
const sr = ${safeSignedRequestJson};
const client = sr.client;
const context = sr.context || {};
const environment = context.environment || {};

const message = document.getElementById("message");
const productRows = document.getElementById("productRows");
const submitBtn = document.getElementById("submitBtn");

function showMessage(text, type) {
  message.className = type || "";
  message.innerText = text;
}

function getOpportunityId() {
  const urlParams = new URLSearchParams(window.location.search);

  const idFromUrl = urlParams.get("id");
  if (idFromUrl && idFromUrl.startsWith("006")) {
    return idFromUrl;
  }

  if (environment.recordId && environment.recordId.startsWith("006")) {
    return environment.recordId;
  }

  if (environment.parameters && typeof environment.parameters === "string") {
    if (environment.parameters.startsWith("006")) {
      return environment.parameters;
    }

    try {
      const parsed = JSON.parse(environment.parameters.replace(/&quot;/g, '"'));
      if (parsed.oppId && parsed.oppId.startsWith("006")) {
        return parsed.oppId;
      }
    } catch (e) {}
  }

  if (
    environment.parameters &&
    typeof environment.parameters === "object" &&
    environment.parameters.oppId
  ) {
    return environment.parameters.oppId;
  }

  return null;
}

const opportunityId = getOpportunityId();
document.getElementById("oppId").innerText = opportunityId || "Not found";

function canvasAjax(path, method, body, callback) {
  Sfdc.canvas.client.ajax(path, {
    client: client,
    method: method || "GET",
    contentType: "application/json",
    data: body ? JSON.stringify(body) : null,
    success: function(data) {
      callback(null, data.payload);
    },
    failure: function(data) {
      console.error("Canvas AJAX failure:", data);
      callback(data);
    }
  });
}

function loadProducts() {
  if (!opportunityId) {
    showMessage("Could not determine Opportunity Id from Canvas context or URL.", "error");
    return;
  }

  showMessage("Loading Opportunity and products...", "");

  canvasAjax(
    "/services/data/v60.0/sobjects/Opportunity/" +
      encodeURIComponent(opportunityId) +
      "?fields=Id,Name,Pricebook2Id",
    "GET",
    null,
    function(err, opp) {
      if (err) {
        showMessage("Failed to read Opportunity. Check browser console.", "error");
        return;
      }

      if (!opp.Pricebook2Id) {
        showMessage("This Opportunity does not have a Price Book. Add Standard Price Book first.", "error");
        return;
      }

      const soql =
        "SELECT Id, UnitPrice, Product2.Id, Product2.Name, Product2.ProductCode " +
        "FROM PricebookEntry " +
        "WHERE IsActive = true " +
        "AND Product2.IsActive = true " +
        "AND Pricebook2Id = '" + opp.Pricebook2Id + "' " +
        "ORDER BY Product2.Name";

      canvasAjax(
        "/services/data/v60.0/query?q=" + encodeURIComponent(soql),
        "GET",
        null,
        function(err2, result) {
          if (err2) {
            showMessage("Failed to load products. Check browser console.", "error");
            return;
          }

          if (!result.records || result.records.length === 0) {
            showMessage("No active products found for this Opportunity Price Book.", "error");
            return;
          }

          productRows.innerHTML = result.records.map(function(p) {
            return \`
              <tr>
                <td>
                  <input
                    type="checkbox"
                    data-pbe="\${p.Id}"
                    data-price="\${p.UnitPrice}"
                  />
                </td>
                <td>\${escapeHtmlClient(p.Product2.Name)}</td>
                <td>\${p.UnitPrice}</td>
                <td>
                  <input
                    type="number"
                    min="1"
                    value="1"
                    class="qty"
                    data-qty="\${p.Id}"
                  />
                </td>
              </tr>
            \`;
          }).join("");

          showMessage("Products loaded.", "success");
        }
      );
    }
  );
}

submitBtn.addEventListener("click", function() {
  const selected = Array.from(
    document.querySelectorAll("input[type='checkbox']:checked")
  );

  if (!selected.length) {
    showMessage("Select at least one product.", "error");
    return;
  }

  const records = selected.map(function(box) {
    const pbeId = box.dataset.pbe;
    const qtyInput = document.querySelector("[data-qty='" + pbeId + "']");

    return {
      attributes: { type: "OpportunityLineItem" },
      OpportunityId: opportunityId,
      PricebookEntryId: pbeId,
      Quantity: Number(qtyInput.value || 1),
      UnitPrice: Number(box.dataset.price)
    };
  });

  showMessage("Sending products to Salesforce...", "");

  canvasAjax(
    "/services/data/v60.0/composite/sobjects",
    "POST",
    {
      allOrNone: true,
      records: records
    },
    function(err, result) {
      if (err) {
        showMessage("Failed to create Opportunity Products. Check browser console.", "error");
        return;
      }

      showMessage("Products added successfully. Refresh the Opportunity page.", "success");
      console.log("Created records:", result);
    }
  );
});

function escapeHtmlClient(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

loadProducts();
</script>
</body>
</html>
`;
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
