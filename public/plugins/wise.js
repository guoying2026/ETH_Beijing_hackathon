const VERIFIER_URL = "http://localhost:7047";
const PROXY_URL_BASE = "ws://localhost:7047/proxy?token=";
const CONTACTS_ORDER_BINDING_HASH = "0x0000000000000000000000000000000000000000000000000000000000000001";
const MERCHANT_NAME_HASH = "0x0000000000000000000000000000000000000000000000000000000000000002";
const MERCHANT_ID_HASH = "0x0000000000000000000000000000000000000000000000000000000000000003";
const PAYEE_NAME_HASH = "0x0000000000000000000000000000000000000000000000000000000000000004";
const PAYEE_ID_HASH = "0x0000000000000000000000000000000000000000000000000000000000000005";
const TRANSFER_ORDER_BINDING_HASH = "0x0000000000000000000000000000000000000000000000000000000000000006";
const OWNER_ADDRESS = "0x0000000000000000000000000000000000000000000000000000000000000007";
const COUNTERPARTY_ADDRESS = "0x0000000000000000000000000000000000000000000000000000000000000008";
const TENANT_ID = "__TLSN_TENANT_ID_SENTINEL__";
const HOST = "wise.com";
const METHOD = "GET";
const LANDING_URL = "https://wise.com/home";
const TLSN_POLICY_VERSION = "v1.0.0";
const CONTACTS_PATHNAME = "/gateway/v2/profiles/*/contacts";
const TRANSFER_PATHNAME = "/gateway/v3/profiles/*/transfers/*";
const ENDPOINT_CONTACTS = "contacts";
const ENDPOINT_TRANSFER = "transfer";
const config = {
  name: "Wise Contacts + Transfer Prover",
  description: "Prove your Wise contacts and transfer responses.",
  policyVersion: TLSN_POLICY_VERSION,
  requests: [
    {
      method: METHOD,
      host: HOST,
      pathname: CONTACTS_PATHNAME,
      verifierUrl: VERIFIER_URL
    },
    {
      method: METHOD,
      host: HOST,
      pathname: TRANSFER_PATHNAME,
      verifierUrl: VERIFIER_URL
    }
  ],
  urls: [`https://${HOST}/*`]
};
const OPTIONAL_HEADER_KEYS = [
  "accept",
  "accept-language",
  "cache-control",
  "pragma",
  "priority",
  "referer",
  "sec-ch-ua",
  "sec-ch-ua-arch",
  "sec-ch-ua-bitness",
  "sec-ch-ua-mobile",
  "sec-ch-ua-platform",
  "sec-fetch-dest",
  "sec-fetch-mode",
  "sec-fetch-site",
  "user-agent",
  "x-visual-context"
];
const CONTACTS_HANDLERS = [
  { type: "SENT", part: "START_LINE", action: "REVEAL" },
  { type: "RECV", part: "START_LINE", action: "REVEAL" },
  {
    type: "RECV",
    part: "ALL",
    action: "REVEAL",
    params: {
      type: "regex",
      regex: '"title"\\s*:\\s*"[^"]*"',
      flags: "g"
    }
  },
  {
    type: "RECV",
    part: "ALL",
    action: "REVEAL",
    params: {
      type: "regex",
      regex: '"subtitle"\\s*:\\s*"[^"]*"',
      flags: "g"
    }
  }
];
const TRANSFER_HANDLERS = [
  { type: "SENT", part: "START_LINE", action: "REVEAL" },
  { type: "RECV", part: "START_LINE", action: "REVEAL" },
  {
    type: "RECV",
    part: "BODY",
    action: "REVEAL",
    params: { type: "json", path: "id" },
    label: "transaction.id"
  },
  {
    type: "RECV",
    part: "BODY",
    action: "REVEAL",
    params: { type: "json", path: "state" },
    label: "transaction.status"
  },
  {
    type: "RECV",
    part: "BODY",
    action: "REVEAL",
    params: { type: "json", path: "targetAmount" },
    label: "originator.amount"
  },
  {
    type: "RECV",
    part: "BODY",
    action: "REVEAL",
    params: { type: "json", path: "targetCurrency" },
    label: "originator.currency"
  },
  {
    type: "RECV",
    part: "ALL",
    action: "REVEAL",
    params: {
      type: "regex",
      regex: '(?<="state"\\s*:\\s*"OUTGOING_PAYMENT_SENT"\\s*,\\s*)"date"\\s*:\\s*(?:"[^"]*"|\\d+)',
      flags: "g"
    },
    label: "originator.timestamp"
  }
];
function getHeaderValue(header, name) {
  return header?.requestHeaders?.find(
    (h) => h?.name?.toLowerCase() === name.toLowerCase()
  )?.value || null;
}
function isWiseTransferPath(pathname) {
  if (typeof pathname !== "string") return false;
  const parts = pathname.split("/").filter(Boolean);
  if (parts.length !== 6) return false;
  return parts[0] === "gateway" && parts[1] === "v3" && parts[2] === "profiles" && parts[4] === "transfers" && parts[3].length > 0 && parts[5].length > 0;
}
function isWiseContactsPath(pathname) {
  if (typeof pathname !== "string") return false;
  const parts = pathname.split("/").filter(Boolean);
  if (parts.length !== 5) return false;
  return parts[0] === "gateway" && parts[1] === "v2" && parts[2] === "profiles" && parts[4] === "contacts" && parts[3].length > 0;
}
function getEndpointFromUrl(urlString) {
  try {
    const url = new URL(urlString);
    if (url.hostname !== HOST) return null;
    if (isWiseContactsPath(url.pathname)) return ENDPOINT_CONTACTS;
    if (isWiseTransferPath(url.pathname)) return ENDPOINT_TRANSFER;
    return null;
  } catch {
    return null;
  }
}
function stateKey(endpoint, key) {
  return `${endpoint}_${key}`;
}
function useEndpointState(endpoint, key, fallback) {
  return useState(stateKey(endpoint, key), fallback);
}
function setEndpointState(endpoint, key, value) {
  setState(stateKey(endpoint, key), value);
}
function buildHeadersForEndpoint(endpoint) {
  const cookie = useEndpointState(endpoint, "cookie", null);
  const accessToken = useEndpointState(endpoint, "x-access-token", null);
  if (!cookie || !accessToken) {
    throw new Error(`[wise] missing required headers for ${endpoint}`);
  }
  const headers = {
    cookie,
    "x-access-token": accessToken,
    Host: HOST,
    "Accept-Encoding": "identity",
    Connection: "close"
  };
  for (const key of OPTIONAL_HEADER_KEYS) {
    const value = useEndpointState(endpoint, key, null);
    if (value) headers[key] = value;
  }
  return headers;
}
function resetCapturedState() {
  for (const endpoint of [ENDPOINT_CONTACTS, ENDPOINT_TRANSFER]) {
    setEndpointState(endpoint, "headerId", null);
    setEndpointState(endpoint, "requestUrl", null);
    setEndpointState(endpoint, "cookie", null);
    setEndpointState(endpoint, "x-access-token", null);
    for (const key of OPTIONAL_HEADER_KEYS) {
      setEndpointState(endpoint, key, null);
    }
  }
}
async function onClick() {
  console.log("[wise] onClick start");
  try {
    const isRequestPending = useState("isRequestPending", false);
    if (isRequestPending) return;
    setState("isRequestPending", true);
    const contactsRequestUrl = useEndpointState(
      ENDPOINT_CONTACTS,
      "requestUrl",
      null
    );
    const transferRequestUrl = useEndpointState(
      ENDPOINT_TRANSFER,
      "requestUrl",
      null
    );
    if (!contactsRequestUrl || !transferRequestUrl) {
      console.log("[wise] missing required captured URLs");
      setState("isRequestPending", false);
      return;
    }
    const contactsHeaders = buildHeadersForEndpoint(ENDPOINT_CONTACTS);
    const transferHeaders = buildHeadersForEndpoint(ENDPOINT_TRANSFER);
    const [contactsProof, transferProof] = await Promise.all([
      prove(
        {
          url: contactsRequestUrl,
          method: METHOD,
          headers: contactsHeaders
        },
        {
          verifierUrl: VERIFIER_URL,
          proxyUrl: PROXY_URL_BASE + HOST,
          maxRecvData: 3e3,
          maxSentData: 4e3,
          transcriptCommitHashAlg: "Keccak256",
          handlers: CONTACTS_HANDLERS,
          sessionData: {
            __tlsn_order_binding_hash: CONTACTS_ORDER_BINDING_HASH,
            __tlsn_merchant_name_hash: MERCHANT_NAME_HASH,
            __tlsn_merchant_id_hash: MERCHANT_ID_HASH,
            __tlsn_payee_name_hash: PAYEE_NAME_HASH,
            __tlsn_payee_id_hash: PAYEE_ID_HASH,
            __tlsn_owner_address: OWNER_ADDRESS,
            __tlsn_counterparty_address: COUNTERPARTY_ADDRESS,
            __tlsn_tenant_id: TENANT_ID
          },
          accountCheckFields: [
            // CONTACTS_HANDLERS[2] = title    → verify against payeeNameHash
            { handlerIndex: 2, sessionDataKey: "__tlsn_payee_name_hash", valueMode: "json_value" },
            // CONTACTS_HANDLERS[3] = subtitle → verify against payeeIdHash
            { handlerIndex: 3, sessionDataKey: "__tlsn_payee_id_hash", valueMode: "json_value" }
          ],
          transcriptCommitDebug: {
            exposeOpenings: true,
            //includeVerifierTranscript: true,
            runSelfCheck: true
          }
        }
      ),
      prove(
        {
          url: transferRequestUrl,
          method: METHOD,
          headers: transferHeaders
        },
        {
          verifierUrl: VERIFIER_URL,
          proxyUrl: PROXY_URL_BASE + HOST,
          maxRecvData: 3e3,
          maxSentData: 4e3,
          transcriptCommitHashAlg: "Keccak256",
          handlers: TRANSFER_HANDLERS,
          sessionData: {
            __tlsn_order_binding_hash: TRANSFER_ORDER_BINDING_HASH,
            __tlsn_owner_address: OWNER_ADDRESS,
            __tlsn_counterparty_address: COUNTERPARTY_ADDRESS,
            __tlsn_tenant_id: TENANT_ID
          },
          transcriptCommitDebug: {
            exposeOpenings: true,
            //includeVerifierTranscript: true,
            runSelfCheck: true
          }
        }
      )
    ]);
    console.log("[wise] prove ok for contacts + transfer");
    done(JSON.stringify({
      // 前端展示用（合并结果）
      displayResults: [
        ...contactsProof?.displayResults || contactsProof?.results || [],
        ...transferProof?.displayResults || transferProof?.results || []
      ],
      // 合约提交用（独立 proof，保留完整 ProveResponse）
      proofs: {
        contacts: contactsProof,
        transfer: transferProof
      }
    }));
  } catch (err) {
    console.error("[wise] onClick error", err);
    setState("isRequestPending", false);
  }
}
function expandUI() {
  setState("isMinimized", false);
}
function minimizeUI() {
  setState("isMinimized", true);
}
function main() {
  const isMinimized = useState("isMinimized", false);
  const isRequestPending = useState("isRequestPending", false);
  const cachedContactsHeaderId = useEndpointState(
    ENDPOINT_CONTACTS,
    "headerId",
    null
  );
  const cachedTransferHeaderId = useEndpointState(
    ENDPOINT_TRANSFER,
    "headerId",
    null
  );
  const cachedContactsRequestUrl = useEndpointState(
    ENDPOINT_CONTACTS,
    "requestUrl",
    null
  );
  const cachedTransferRequestUrl = useEndpointState(
    ENDPOINT_TRANSFER,
    "requestUrl",
    null
  );
  const cachedContactsCookie = useEndpointState(
    ENDPOINT_CONTACTS,
    "cookie",
    null
  );
  const cachedTransferCookie = useEndpointState(
    ENDPOINT_TRANSFER,
    "cookie",
    null
  );
  const cachedContactsAccessToken = useEndpointState(
    ENDPOINT_CONTACTS,
    "x-access-token",
    null
  );
  const cachedTransferAccessToken = useEndpointState(
    ENDPOINT_TRANSFER,
    "x-access-token",
    null
  );
  const matchedHeaders = useHeaders((headers) => {
    return headers.filter((item) => {
      if (typeof item?.url !== "string") return false;
      if ((item.method || "").toUpperCase() !== METHOD) return false;
      return !!getEndpointFromUrl(item.url);
    });
  });
  let latestContactsHeader = null;
  let latestTransferHeader = null;
  for (const header of matchedHeaders) {
    const endpoint = getEndpointFromUrl(header?.url ?? "");
    if (endpoint === ENDPOINT_CONTACTS) latestContactsHeader = header;
    if (endpoint === ENDPOINT_TRANSFER) latestTransferHeader = header;
  }
  if (latestContactsHeader && latestContactsHeader.id !== cachedContactsHeaderId) {
    setEndpointState(ENDPOINT_CONTACTS, "headerId", latestContactsHeader.id);
    setEndpointState(
      ENDPOINT_CONTACTS,
      "requestUrl",
      latestContactsHeader.url || null
    );
    setEndpointState(
      ENDPOINT_CONTACTS,
      "cookie",
      getHeaderValue(latestContactsHeader, "cookie")
    );
    setEndpointState(
      ENDPOINT_CONTACTS,
      "x-access-token",
      getHeaderValue(latestContactsHeader, "x-access-token")
    );
    for (const key of OPTIONAL_HEADER_KEYS) {
      setEndpointState(
        ENDPOINT_CONTACTS,
        key,
        getHeaderValue(latestContactsHeader, key)
      );
    }
    console.log("[wise] captured headers", {
      endpoint: ENDPOINT_CONTACTS,
      headerId: latestContactsHeader.id,
      url: latestContactsHeader.url
    });
  }
  if (latestTransferHeader && latestTransferHeader.id !== cachedTransferHeaderId) {
    setEndpointState(ENDPOINT_TRANSFER, "headerId", latestTransferHeader.id);
    setEndpointState(
      ENDPOINT_TRANSFER,
      "requestUrl",
      latestTransferHeader.url || null
    );
    setEndpointState(
      ENDPOINT_TRANSFER,
      "cookie",
      getHeaderValue(latestTransferHeader, "cookie")
    );
    setEndpointState(
      ENDPOINT_TRANSFER,
      "x-access-token",
      getHeaderValue(latestTransferHeader, "x-access-token")
    );
    for (const key of OPTIONAL_HEADER_KEYS) {
      setEndpointState(
        ENDPOINT_TRANSFER,
        key,
        getHeaderValue(latestTransferHeader, key)
      );
    }
    console.log("[wise] captured headers", {
      endpoint: ENDPOINT_TRANSFER,
      headerId: latestTransferHeader.id,
      url: latestTransferHeader.url
    });
  }
  const isContactsReady = !!cachedContactsRequestUrl && !!cachedContactsCookie && !!cachedContactsAccessToken;
  const isTransferReady = !!cachedTransferRequestUrl && !!cachedTransferCookie && !!cachedTransferAccessToken;
  const isReady = isContactsReady && isTransferReady;
  useEffect(() => {
    resetCapturedState();
    openWindow(LANDING_URL);
  }, []);
  if (isMinimized) {
    return div(
      {
        style: {
          position: "fixed",
          bottom: "20px",
          right: "20px",
          width: "60px",
          height: "60px",
          borderRadius: "50%",
          backgroundColor: "#163300",
          boxShadow: "0 4px 8px rgba(0,0,0,0.3)",
          zIndex: "999999",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          cursor: "pointer",
          transition: "all 0.3s ease",
          fontSize: "12px",
          color: "white",
          fontWeight: "700"
        },
        onclick: "expandUI"
      },
      ["WISE"]
    );
  }
  return div(
    {
      style: {
        position: "fixed",
        bottom: "0",
        right: "8px",
        width: "320px",
        borderRadius: "8px 8px 0 0",
        backgroundColor: "white",
        boxShadow: "0 -2px 10px rgba(0,0,0,0.1)",
        zIndex: "999999",
        fontSize: "14px",
        fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
        overflow: "hidden"
      }
    },
    [
      div(
        {
          style: {
            background: "linear-gradient(135deg, #163300 0%, #2f6f00 100%)",
            padding: "12px 16px",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            color: "white"
          }
        },
        [
          div(
            {
              style: {
                fontWeight: "600",
                fontSize: "16px"
              }
            },
            ["Wise Contacts + Transfer"]
          ),
          button(
            {
              style: {
                background: "transparent",
                border: "none",
                color: "white",
                fontSize: "20px",
                cursor: "pointer"
              },
              onclick: "minimizeUI"
            },
            ["-"]
          )
        ]
      ),
      div(
        {
          style: {
            padding: "16px",
            backgroundColor: "#f8f9fa"
          }
        },
        [
          div(
            {
              style: {
                fontSize: "12px",
                color: "#666",
                marginBottom: "12px"
              }
            },
            [
              "Open Wise contacts and transfer pages and let both requests fire, then generate proofs."
            ]
          ),
          div(
            {
              style: {
                marginBottom: "12px",
                padding: "10px",
                borderRadius: "6px",
                backgroundColor: isReady ? "#d4edda" : "#fff3cd",
                color: isReady ? "#155724" : "#856404",
                border: `1px solid ${isReady ? "#c3e6cb" : "#ffeeba"}`,
                fontSize: "12px",
                lineHeight: "1.4"
              }
            },
            [
              isReady ? "Captured latest contacts + transfer requests and required headers." : isContactsReady ? "Contacts ready. Waiting for transfer request capture." : isTransferReady ? "Transfer ready. Waiting for contacts request capture." : "Waiting for both contacts and transfer request captures."
            ]
          ),
          cachedContactsRequestUrl ? div(
            {
              style: {
                marginBottom: "8px",
                padding: "10px",
                borderRadius: "6px",
                backgroundColor: "#f1f3f5",
                color: "#495057",
                border: "1px solid #dee2e6",
                fontSize: "11px",
                wordBreak: "break-all",
                lineHeight: "1.4"
              }
            },
            [`Contacts: ${cachedContactsRequestUrl}`]
          ) : "",
          cachedTransferRequestUrl ? div(
            {
              style: {
                marginBottom: "12px",
                padding: "10px",
                borderRadius: "6px",
                backgroundColor: "#f1f3f5",
                color: "#495057",
                border: "1px solid #dee2e6",
                fontSize: "11px",
                wordBreak: "break-all",
                lineHeight: "1.4"
              }
            },
            [`Transfer: ${cachedTransferRequestUrl}`]
          ) : "",
          isReady ? button(
            {
              style: {
                width: "100%",
                padding: "10px 12px",
                borderRadius: "6px",
                backgroundColor: isRequestPending ? "#d9d9d9" : "#2f6f00",
                color: "white",
                border: "none",
                cursor: isRequestPending ? "not-allowed" : "pointer",
                fontWeight: "600"
              },
              onclick: "onClick"
            },
            [isRequestPending ? "Generating..." : "Generate Both Proofs"]
          ) : ""
        ]
      )
    ]
  );
}
export default { main, onClick, expandUI, minimizeUI, config };
