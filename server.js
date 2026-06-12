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
    console.log("Canvas POST received");
    console.log("Body keys:", Object.keys(req.body));

    const decoded = verifyAndDecodeSignedRequest(
      req.body.signed_request,
      process.env.SALESFORCE_CONSUMER_SECRET
    );

    console.log("Decoded Canvas payload:");
    console.log(JSON.stringify(decoded, null, 2));

    const environment = decoded.context?.environment || {};
    const params = decoded.context.environment.parameters;

    let opportunityId =
  environment.record.Id ||
  environment.parameters ||
  null;
    
    /*if (typeof params === "string") {
      try {
        opportunityId = JSON.parse(params).oppId;
      } catch {
        opportunityId = params;
      }
    } else {
      opportunityId = params.oppId;
    }*/

    if (!opportunityId) {
      throw new Error("Opportunity Id was not found in Canvas parameters");
    }

    const client = decoded.client || {};

    if (!client.oauthToken || !client.instanceUrl) {
      throw new Error("Canvas signed request does not include OAuth token or instance URL");
    }

    res.send(
      renderHtml({
        opportunityId,
        accessToken: client.oauthToken,
        instanceUrl: client.instanceUrl
      })
    );
  } catch (err) {
    console.error("Canvas authentication failed:", err.message);
    res
      .status(401)
      .send(`<h2>Canvas authentication failed</h2><pre>${err.message}</pre>`);
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

function renderHtml({ opportunityId, accessToken, instanceUrl }) {
  return `
<!doctype html>
<html>
<head>
  <title>Product Pricing Canvas</title>
  <link rel="stylesheet" href="/public/app.css" />
</head>
<body>
  <div class="container">
    <h2>Product Pricing POC</h2>
    <p>Opportunity Id: <strong>${opportunityId}</strong></p>

    <div id="message"></div>

    <table>
      <thead>
        <tr>
          <th>Select</th>
          <th>Product</th>
          <th>Price</th>
          <th>Quantity</th>
        </tr>
      </thead>
      <tbody id="productRows"></tbody>
    </table>

    <button id="submitBtn">Send Selected Products to Salesforce</button>
  </div>

<script>
const SALESFORCE = {
  opportunityId: "${opportunityId}",
  accessToken: "${accessToken}",
  instanceUrl: "${instanceUrl}"
};

const message = document.getElementById("message");
const rows = document.getElementById("productRows");

function showMessage(text, type) {
  message.className = type || "";
  message.innerText = text;
}

async function sfRequest(path, options = {}) {
  const response = await fetch(SALESFORCE.instanceUrl + path, {
    ...options,
    headers: {
      Authorization: "Bearer " + SALESFORCE.accessToken,
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
    console.error(body);
    throw new Error("Salesforce API error " + response.status);
  }

  return body;
}

async function loadProducts() {
  try {
    const opp = await sfRequest(
      "/services/data/v60.0/sobjects/Opportunity/" +
      SALESFORCE.opportunityId +
      "?fields=Id,Name,Pricebook2Id"
    );

    if (!opp.Pricebook2Id) {
      showMessage("Opportunity does not have a Price Book. Add Standard Price Book first.", "error");
      return;
    }

    const query = \`
      SELECT Id, UnitPrice, Product2.Id, Product2.Name, Product2.ProductCode
      FROM PricebookEntry
      WHERE IsActive = true
      AND Product2.IsActive = true
      AND Pricebook2Id = '\${opp.Pricebook2Id}'
      ORDER BY Product2.Name
    \`;

    const data = await sfRequest(
      "/services/data/v60.0/query?q=" + encodeURIComponent(query)
    );

    rows.innerHTML = data.records.map((p) => \`
      <tr>
        <td>
          <input type="checkbox"
                 data-id="\${p.Id}"
                 data-price="\${p.UnitPrice}" />
        </td>
        <td>\${p.Product2.Name}</td>
        <td>\${p.UnitPrice}</td>
        <td>
          <input type="number"
                 min="1"
                 value="1"
                 class="qty"
                 data-id="\${p.Id}" />
        </td>
      </tr>
    \`).join("");
  } catch (e) {
    showMessage(e.message, "error");
  }
}

document.getElementById("submitBtn").addEventListener("click", async () => {
  try {
    const selected = [...document.querySelectorAll("input[type='checkbox']:checked")];

    const records = selected.map((box) => {
      const id = box.dataset.id;
      const qty = document.querySelector(\`.qty[data-id="\${id}"]\`).value;

      return {
        attributes: { type: "OpportunityLineItem" },
        OpportunityId: SALESFORCE.opportunityId,
        PricebookEntryId: id,
        Quantity: Number(qty),
        UnitPrice: Number(box.dataset.price)
      };
    });

    if (!records.length) {
      showMessage("Select at least one product.", "error");
      return;
    }

    await sfRequest("/services/data/v60.0/composite/sobjects", {
      method: "POST",
      body: JSON.stringify({
        allOrNone: true,
        records
      })
    });

    showMessage("Products added successfully. Refresh the Opportunity page.", "success");
  } catch (e) {
    showMessage(e.message, "error");
  }
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
