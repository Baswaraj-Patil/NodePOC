require("dotenv").config();

const crypto = require("crypto");
const express = require("express");
const session = require("express-session");
const cookieParser = require("cookie-parser");
const fetch = require("node-fetch");

const app = express();

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(cookieParser());
app.use(
  session({
    secret: process.env.SESSION_SECRET || "local-dev-secret",
    resave: false,
    saveUninitialized: false,
    cookie: {
      secure: process.env.NODE_ENV === "production",
      httpOnly: true,
      sameSite: "none"
    }
  })
);

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

function getSalesforceAuth(req) {
  if (!req.session.sf) {
    throw new Error("Salesforce session not initialized");
  }

  return req.session.sf;
}

async function sfRequest(req, path, options = {}) {
  const sf = getSalesforceAuth(req);

  const response = await fetch(`${sf.instanceUrl}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${sf.accessToken}`,
      "Content-Type": "application/json",
      ...(options.headers || {})
    }
  });

  const text = await response.text();

  let body;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }

  if (!response.ok) {
    console.error("Salesforce API error", response.status, body);
    throw new Error(`Salesforce API error ${response.status}`);
  }

  return body;
}

app.get("/", (req, res) => {
  res.send("Node app is running. Use Salesforce Canvas to open /canvas.");
});

app.post("/canvas", (req, res) => {
  try {
    const signedRequest = req.body.signed_request;

    const decoded = verifyAndDecodeSignedRequest(
      signedRequest,
      process.env.SALESFORCE_CONSUMER_SECRET
    );

    res.send(renderHtml({
      signedRequestJson: decoded
    }));
  } catch (err) {
    res.status(401).send(`<h2>Canvas authentication failed</h2><pre>${err.message}</pre>`);
  }
});

app.get("/health", (req, res) => {
  res.json({ ok: true });
});

app.get("/api/context", (req, res) => {
  try {
    const sf = getSalesforceAuth(req);
    res.json({
      opportunityId: sf.opportunityId,
      instanceUrl: sf.instanceUrl,
      userId: sf.userId,
      organizationId: sf.organizationId
    });
  } catch (err) {
    res.status(401).json({ error: err.message });
  }
});

app.get("/api/products", async (req, res) => {
  try {
    const sf = getSalesforceAuth(req);

    const opp = await sfRequest(
      req,
      `/services/data/v60.0/sobjects/Opportunity/${sf.opportunityId}?fields=Id,Name,Pricebook2Id`
    );

    if (!opp.Pricebook2Id) {
      return res.status(400).json({
        error: "Opportunity does not have a Price Book. Add a Price Book to the Opportunity first."
      });
    }

    const query = `
      SELECT Id, UnitPrice, Product2.Id, Product2.Name, Product2.ProductCode
      FROM PricebookEntry
      WHERE IsActive = true
      AND Product2.IsActive = true
      AND Pricebook2Id = '${opp.Pricebook2Id}'
      ORDER BY Product2.Name
    `;

    const result = await sfRequest(
      req,
      `/services/data/v60.0/query?q=${encodeURIComponent(query)}`
    );

    res.json({
      opportunity: opp,
      products: result.records.map((r) => ({
        pricebookEntryId: r.Id,
        productId: r.Product2.Id,
        name: r.Product2.Name,
        productCode: r.Product2.ProductCode,
        unitPrice: r.UnitPrice
      }))
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/opportunity-lines", async (req, res) => {
  try {
    const sf = getSalesforceAuth(req);
    const { items } = req.body;

    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: "No selected products." });
    }

    const created = [];

    for (const item of items) {
      const payload = {
        OpportunityId: sf.opportunityId,
        PricebookEntryId: item.pricebookEntryId,
        Quantity: Number(item.quantity || 1),
        UnitPrice: Number(item.unitPrice)
      };

      const result = await sfRequest(
        req,
        `/services/data/v60.0/sobjects/OpportunityLineItem`,
        {
          method: "POST",
          body: JSON.stringify(payload)
        }
      );

      created.push(result);
    }

    res.json({
      success: true,
      created
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

function renderHtml({ signedRequestJson }) {
  return `
<!doctype html>
<html>
<head>
  <title>Product Pricing Canvas</title>
  <link rel="stylesheet" href="/public/app.css" />
  <script src="/canvas/sdk/js/canvas-all.js"></script>
</head>
<body>
  <div class="container">
    <h2>Product Pricing Canvas SDK POC</h2>
    <p>Opportunity Id: <strong id="oppId"></strong></p>
    <div id="message"></div>
    <div id="products"></div>
    <button id="submitBtn">Send Selected Products</button>
  </div>

<script>
const sr = ${JSON.stringify(signedRequestJson)};
const client = sr.client;
const context = sr.context;

const message = document.getElementById("message");
const productsDiv = document.getElementById("products");

function showMessage(text) {
  message.innerText = text;
}

function getOpportunityId() {
  const urlParams = new URLSearchParams(window.location.search);
  const idFromUrl = urlParams.get("id");

  if (idFromUrl && idFromUrl.startsWith("006")) {
    return idFromUrl;
  }

  if (context.environment && context.environment.recordId) {
    return context.environment.recordId;
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
      console.error(data);
      callback(data);
    }
  });
}

async function loadProducts() {
  if (!opportunityId) {
    showMessage("Could not determine Opportunity Id.");
    return;
  }

  canvasAjax(
    "/services/data/v60.0/sobjects/Opportunity/" +
      opportunityId +
      "?fields=Id,Name,Pricebook2Id",
    "GET",
    null,
    function(err, opp) {
      if (err) {
        showMessage("Failed to read Opportunity.");
        return;
      }

      if (!opp.Pricebook2Id) {
        showMessage("Add a Price Book to this Opportunity first.");
        return;
      }

      const soql =
        "SELECT Id, UnitPrice, Product2.Name " +
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
            showMessage("Failed to load products.");
            return;
          }

          productsDiv.innerHTML = result.records.map(function(p) {
            return \`
              <div>
                <input type="checkbox"
                       data-pbe="\${p.Id}"
                       data-price="\${p.UnitPrice}" />
                \${p.Product2.Name} - $\${p.UnitPrice}
                Qty: <input type="number"
                            min="1"
                            value="1"
                            data-qty="\${p.Id}" />
              </div>
            \`;
          }).join("");
        }
      );
    }
  );
}

document.getElementById("submitBtn").addEventListener("click", function() {
  const selected = Array.from(document.querySelectorAll("input[type='checkbox']:checked"));

  if (!selected.length) {
    showMessage("Select at least one product.");
    return;
  }

  const records = selected.map(function(box) {
    const pbeId = box.dataset.pbe;
    const qty = document.querySelector("[data-qty='" + pbeId + "']").value;

    return {
      attributes: { type: "OpportunityLineItem" },
      OpportunityId: opportunityId,
      PricebookEntryId: pbeId,
      Quantity: Number(qty),
      UnitPrice: Number(box.dataset.price)
    };
  });

  canvasAjax(
    "/services/data/v60.0/composite/sobjects",
    "POST",
    {
      allOrNone: true,
      records: records
    },
    function(err) {
      if (err) {
        showMessage("Failed to create Opportunity Products.");
        return;
      }

      showMessage("Products added successfully. Refresh the Opportunity.");
    }
  );
});

loadProducts();
</script>
</body>
</html>
`;
}

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Canvas app running on port ${port}`);
});
