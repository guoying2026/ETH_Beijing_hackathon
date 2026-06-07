const VERIFIER_URL = "http://localhost:7047";
const PROXY_URL_BASE = "ws://localhost:7047/proxy?token=";
const ORDER_BINDING_HASH = "0x0000000000000000000000000000000000000000000000000000000000000001";
const MERCHANT_NAME_HASH = "0x0000000000000000000000000000000000000000000000000000000000000002";
const MERCHANT_ID_HASH = "0x0000000000000000000000000000000000000000000000000000000000000003";
const PAYEE_NAME_HASH = "0x0000000000000000000000000000000000000000000000000000000000000004";
const PAYEE_ID_HASH = "0x0000000000000000000000000000000000000000000000000000000000000005";
const OWNER_ADDRESS = "0x0000000000000000000000000000000000000000000000000000000000000007";
const COUNTERPARTY_ADDRESS = "0x0000000000000000000000000000000000000000000000000000000000000008";
const TENANT_ID = "__TLSN_TENANT_ID_SENTINEL__";
const HOST = "mbillexprod.alipay.com";
const PATH = "/enterprise/fundReportDetailQuery.json";
const LANDING_URL = "https://b.alipay.com/page/mbillexprod/fund/business/operate/detail";
const METHOD = "POST";
const TLSN_POLICY_VERSION = "v1.0.0";

function getFormBody(request) {
  if (!request.requestBody?.formData) return null;
  return request.requestBody.formData;
}
const config = {
  name: "Alipay Payment Detail",
  description: "Verify Alipay payment transaction details: payer, payee, amount, status, and timestamp (selective disclosure of bizInfo fields).",
  policyVersion: TLSN_POLICY_VERSION,
  requests: [
    {
      method: METHOD,
      host: HOST,
      pathname: PATH,
      verifierUrl: VERIFIER_URL
    }
  ],
  urls: [
    "https://b.alipay.com/page/mbillexprod/fund/business/operate/detail",
    "https://b.alipay.com/page/mbillexprod/fund/business/detail"
  ]
};
async function onClick() {
  console.log("[alipay] onClick start");
  try {
    const isRequestPending = useState("isRequestPending", false);
    if (isRequestPending) {
      console.log("[alipay] onClick ignored: request pending");
      return;
    }
    setState("isRequestPending", true);
    const cachedCookie = useState("cookie", null);
    const cachedContentType = useState("content-type", null);
    const cachedRequestUrl = useState("requestUrl", null);
    const cachedRequestBody = useState("requestBody", null);
    const cachedOrigin = useState("origin", null);
    const cachedReferer = useState("referer", null);
    const cachedAccept = useState("accept", null);
    const cachedAcceptLanguage = useState("acceptLanguage", null);
    const cachedUserAgent = useState("userAgent", null);
    const cachedSecChUa = useState("secChUa", null);
    const cachedSecChUaMobile = useState("secChUaMobile", null);
    const cachedSecChUaPlatform = useState("secChUaPlatform", null);
    const cachedSecFetchDest = useState("secFetchDest", null);
    const cachedSecFetchMode = useState("secFetchMode", null);
    const cachedSecFetchSite = useState("secFetchSite", null);
    if (!cachedCookie || !cachedContentType || !cachedRequestUrl || !cachedRequestBody) {
      console.log("[alipay] missing cookie, content-type, request URL, or request body, abort");
      setState("isRequestPending", false);
      return;
    }
    const headers = {
      Accept: cachedAccept,
      "accept-language": cachedAcceptLanguage,
      "Accept-Encoding": "identity",
      "cache-control": "no-cache",
      "content-type": cachedContentType,
      cookie: cachedCookie,
      Host: HOST,
      Origin: cachedOrigin,
      "pragma": "no-cache",
      "priority": "u=1, i",
      Referer: cachedReferer,
      "sec-ch-ua": cachedSecChUa,
      "sec-ch-ua-mobile": cachedSecChUaMobile,
      "sec-ch-ua-platform": cachedSecChUaPlatform,
      "sec-fetch-dest": cachedSecFetchDest,
      "sec-fetch-mode": cachedSecFetchMode,
      "sec-fetch-site": cachedSecFetchSite,
      "user-agent": cachedUserAgent,
      "Connection": "close"
    };
    console.log("[alipay] prove start", {
      url: cachedRequestUrl,
      headerKeys: Object.keys(headers),
      cookieLen: cachedCookie.length
    });
    const formParams = "gmtDateBegin=2026-03-27+00%3A00%3A00&gmtDateEnd=2026-03-28+00%3A00%3A00&userId=2088542815888498&status=ALL&pageSize=50&pageNum=1&sortTarget=gmtCreate&sortType=0&bizType=ALL&_input_charset=gbk";
    const baseUrl = String(cachedRequestUrl);
    const urlWithParams = baseUrl + (baseUrl.includes("?") ? "&" : "?") + cachedRequestBody;
    console.log("[alipay] urlWithParams:", urlWithParams);
    const resp = await prove(
      {
        url: urlWithParams,
        method: METHOD,
        headers
      },
      {
        verifierUrl: VERIFIER_URL,
        proxyUrl: PROXY_URL_BASE + HOST,
        maxRecvData: 3e3,
        maxSentData: 3e3,
        transcriptCommitHashAlg: "Keccak256",
        sessionData: {
          __tlsn_order_binding_hash: ORDER_BINDING_HASH,
          __tlsn_merchant_name_hash: MERCHANT_NAME_HASH,
          __tlsn_merchant_id_hash: MERCHANT_ID_HASH,
          __tlsn_payee_name_hash: PAYEE_NAME_HASH,
          __tlsn_payee_id_hash: PAYEE_ID_HASH,
          __tlsn_owner_address: OWNER_ADDRESS,
          __tlsn_counterparty_address: COUNTERPARTY_ADDRESS,
          __tlsn_tenant_id: TENANT_ID
        },
        accountCheckFields: [
          // handlers[4] = payeeName       → verify against payeeNameHash (demo placeholder)
          { handlerIndex: 4, sessionDataKey: "__tlsn_payee_name_hash", valueMode: "json_value" },
          // handlers[5] = payeeLoginEmail → verify against payeeIdHash (demo placeholder)
          { handlerIndex: 5, sessionDataKey: "__tlsn_payee_id_hash", valueMode: "json_value" }
        ],
        handlers: [
          // Reveal the URL
          { type: "SENT", part: "START_LINE", action: "REVEAL" },
          // Reveal response status start line
          { type: "RECV", part: "START_LINE", action: "REVEAL" },
          // Selectively reveal key bizInfo fields from result.bizInfo.*
          // (Note: Parser only supports top-level JSON paths; nested paths not yet supported,
          //  so we use regex patterns to match specific fields within the JSON body.)
          //
          // Disclosed fields for C2C payment proof:
          //   orderId        – 订单号 (unique order identifier)
          //   gmtSuccess     – 完成支付时间 (payment completion timestamp)
          //   payeeName      – 被转账人名 (receiver display name)
          //   payeeLoginEmail – 被转账人email (receiver login email)
          //   payAmount      – 支付金额 CNY (transferred amount)
          //   bizType        – 业务类型 ("TRANSFER" = 转账，排除充值等其他操作)
          //   status         – 订单状态 ("SUCCESS" = completed)
          // part:'ALL' + params.regex is the correct path for regex matching
          // (extractBodyRanges only supports type:'json'; regex lives in extractAllRanges)
          {
            type: "RECV",
            part: "ALL",
            action: "REVEAL",
            params: { type: "regex", regex: '"orderId"\\s*:\\s*"[^"]*"' },
            label: "transaction.id"
          },
          {
            type: "RECV",
            part: "ALL",
            action: "REVEAL",
            params: { type: "regex", regex: '"gmtSuccess"\\s*:\\s*"[^"]*"' },
            label: "originator.timestamp"
          },
          {
            type: "RECV",
            part: "ALL",
            action: "REVEAL",
            params: { type: "regex", regex: '"payeeName"\\s*:\\s*"[^"]*"' },
            label: "beneficiary.name"
          },
          {
            type: "RECV",
            part: "ALL",
            action: "REVEAL",
            params: { type: "regex", regex: '"payeeLoginEmail"\\s*:\\s*"[^"]*"' },
            label: "beneficiary.accountId"
          },
          {
            type: "RECV",
            part: "ALL",
            action: "REVEAL",
            params: { type: "regex", regex: '"payAmount"\\s*:\\s*"[^"]*"' },
            label: "originator.amount"
          },
          {
            type: "RECV",
            part: "ALL",
            action: "REVEAL",
            params: { type: "regex", regex: '"bizType"\\s*:\\s*"[^"]*"' },
            label: "transaction.type"
          },
          {
            type: "RECV",
            part: "ALL",
            action: "REVEAL",
            params: { type: "regex", regex: '"status"\\s*:\\s*"[A-Z_]+"' },
            label: "transaction.status"
          }
        ],
        transcriptCommitDebug: {
          exposeOpenings: true,
          //includeVerifierTranscript: true,
          runSelfCheck: false
        }
      }
    );
    console.log("[alipay] prove ok");
    done(JSON.stringify({
      displayResults: resp.displayResults || resp.results || [],
      ...resp
    }));
  } catch (err) {
    console.error("[alipay] onClick error", err);
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
  const cachedCookie = useState("cookie", null);
  const cachedContentType = useState("content-type", null);
  const cachedRequestUrl = useState("requestUrl", null);
  const cachedRequestBody = useState("requestBody", null);
  const cachedOrigin = useState("origin", null);
  const cachedReferer = useState("referer", null);
  const cachedAccept = useState("accept", null);
  const cachedAcceptLanguage = useState("acceptLanguage", null);
  const cachedUserAgent = useState("userAgent", null);
  const cachedSecChUa = useState("secChUa", null);
  const cachedSecChUaMobile = useState("secChUaMobile", null);
  const cachedSecChUaPlatform = useState("secChUaPlatform", null);
  const cachedSecFetchDest = useState("secFetchDest", null);
  const cachedSecFetchMode = useState("secFetchMode", null);
  const cachedSecFetchSite = useState("secFetchSite", null);
  const headerSeen = useState("headerSeen", false);
  const headerUrl = useState("headerUrl", null);
  const headerMethod = useState("headerMethod", null);
  const headerHasCookie = useState("headerHasCookie", false);
  const debugLogged = useState("debugLogged", false);
  if (!debugLogged) {
    console.log("[alipay] main render");
    setState("debugLogged", true);
  }
  try {
    if (!cachedCookie || !cachedContentType) {
      const [header] = useHeaders((headers) => {
        return headers.filter(
          (h) => typeof h?.url === "string" && new URL(h.url).pathname === PATH && typeof h?.method === "string" && h.method.toUpperCase() === METHOD
        );
      });
      if (header) {
        console.log(header.requestHeaders);
        setState("headerSeen", true);
        setState("headerUrl", header.url);
        setState("headerMethod", header.method);
        const cookie = header.requestHeaders.find((h) => h.name?.toLowerCase() === "cookie")?.value;
        const contentType = header.requestHeaders.find((h) => h.name?.toLowerCase() === "content-type")?.value;
        const origin = header.requestHeaders.find((h) => h.name?.toLowerCase() === "origin")?.value;
        const referer = header.requestHeaders.find((h) => h.name?.toLowerCase() === "referer")?.value;
        const accept = header.requestHeaders.find((h) => h.name?.toLowerCase() === "accept")?.value;
        const acceptEncoding = header.requestHeaders.find((h) => h.name?.toLowerCase() === "accept-encoding")?.value;
        const acceptLanguage = header.requestHeaders.find((h) => h.name?.toLowerCase() === "accept-language")?.value;
        const cacheControl = header.requestHeaders.find((h) => h.name?.toLowerCase() === "cache-control")?.value;
        const userAgent = header.requestHeaders.find((h) => h.name?.toLowerCase() === "user-agent")?.value;
        const secChUa = header.requestHeaders.find((h) => h.name?.toLowerCase() === "sec-ch-ua")?.value;
        const secChUaMobile = header.requestHeaders.find((h) => h.name?.toLowerCase() === "sec-ch-ua-mobile")?.value;
        const secChUaPlatform = header.requestHeaders.find((h) => h.name?.toLowerCase() === "sec-ch-ua-platform")?.value;
        const secFetchDest = header.requestHeaders.find((h) => h.name?.toLowerCase() === "sec-fetch-dest")?.value;
        const secFetchMode = header.requestHeaders.find((h) => h.name?.toLowerCase() === "sec-fetch-mode")?.value;
        const secFetchSite = header.requestHeaders.find((h) => h.name?.toLowerCase() === "sec-fetch-site")?.value;
        if (cookie && !cachedCookie) {
          setState("cookie", cookie);
          console.log("[alipay] cookie found: ", cookie);
        }
        if (contentType && !cachedContentType) {
          setState("content-type", contentType);
          console.log("[alipay] content-type found: ", contentType);
        }
        setState("headerHasCookie", !!cookie);
        if (origin && !cachedOrigin) {
          setState("origin", origin);
          console.log("[alipay] origin found: ", origin);
        }
        if (referer && !cachedReferer) {
          setState("referer", referer);
          console.log("[alipay] referer found: ", referer);
        }
        if (accept && !cachedAccept) {
          setState("accept", accept);
          console.log("[alipay] accept found: ", accept);
        }
        if (acceptLanguage && !cachedAcceptLanguage) {
          setState("acceptLanguage", acceptLanguage);
          console.log("[alipay] accept-language found: ", acceptLanguage);
        }
        if (userAgent && !cachedUserAgent) {
          setState("userAgent", userAgent);
          console.log("[alipay] user-agent found");
        }
        if (secChUa && !cachedSecChUa) {
          setState("secChUa", secChUa);
        }
        if (secChUaMobile && !cachedSecChUaMobile) {
          setState("secChUaMobile", secChUaMobile);
        }
        if (secChUaPlatform && !cachedSecChUaPlatform) {
          setState("secChUaPlatform", secChUaPlatform);
        }
        if (secFetchDest && !cachedSecFetchDest) {
          setState("secFetchDest", secFetchDest);
        }
        if (secFetchMode && !cachedSecFetchMode) {
          setState("secFetchMode", secFetchMode);
        }
        if (secFetchSite && !cachedSecFetchSite) {
          setState("secFetchSite", secFetchSite);
        }
      }
    }
    if (!cachedRequestUrl || !cachedRequestBody) {
      const [request] = useRequests((requests) => {
        return requests.filter(
          (r) => typeof r?.url === "string" && new URL(r.url).pathname === PATH && typeof r?.method === "string" && r.method.toUpperCase() === METHOD
        );
      });
      if (request) {
        console.log("[alipay] request found, requestBody keys:", request.requestBody ? Object.keys(request.requestBody) : "null");
        console.log("[alipay] requestBody.raw:", JSON.stringify(request.requestBody?.raw));
        console.log("[alipay] requestBody.formData:", JSON.stringify(request.requestBody?.formData));
        const jsonBody = getJsonBody(request);
        const formBody = getFormBody(request);
        console.log("[alipay] getJsonBody result:", JSON.stringify(jsonBody));
        console.log("[alipay] getFormBody result:", JSON.stringify(formBody));
        const requestBody = jsonBody ? typeof jsonBody === "string" ? jsonBody : JSON.stringify(jsonBody) : formBody ? new URLSearchParams(formBody).toString().split("%20").join("+") : null;
        if (request.url && !cachedRequestUrl) {
          setState("requestUrl", request.url);
          console.log("[alipay] request URL found: ", request.url);
        }
        if (requestBody && !cachedRequestBody) {
          setState("requestBody", requestBody);
          console.log("[alipay] request body found: ", requestBody);
        }
      }
    }
  } catch (error) {
    console.log("Main Error: ", error);
  }
  const headerDetected = !!headerSeen;
  useEffect(() => {
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
          backgroundColor: "#1677ff",
          boxShadow: "0 4px 8px rgba(0,0,0,0.3)",
          zIndex: "999999",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          cursor: "pointer",
          transition: "all 0.3s ease",
          fontSize: "24px",
          color: "white"
        },
        onclick: "expandUI"
      },
      ["💰"]
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
            background: "linear-gradient(135deg, #1677ff 0%, #3f8cff 100%)",
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
            ["Alipay Payment Detail"]
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
            ["−"]
          )
        ]
      ),
      div(
        {
          style: {
            padding: "16px"
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
              "Open an Alipay transaction detail page, then wait for the payment detail request to appear."
            ]
          ),
          headerDetected || !!cachedRequestUrl ? div(
            {
              style: {
                marginBottom: "12px",
                padding: "10px",
                borderRadius: "6px",
                backgroundColor: "#eef3ff",
                color: "#0b2e6f",
                border: "1px solid #cfdcff",
                fontSize: "12px",
                lineHeight: "1.4"
              }
            },
            [
              div(
                {
                  style: {
                    marginBottom: "6px",
                    wordBreak: "break-all"
                  }
                },
                [headerUrl ? `Header URL: ${headerUrl}` : "Header URL: (none)"]
              ),
              div(
                {
                  style: {
                    marginBottom: "6px"
                  }
                },
                [headerMethod ? `Method: ${headerMethod}` : "Method: (none)"]
              ),
              div(
                {
                  style: {
                    marginBottom: "6px",
                    wordBreak: "break-all"
                  }
                },
                [cachedRequestUrl ? `Request URL: ${cachedRequestUrl}` : "Request URL: (none)"]
              ),
              div(
                {},
                [cachedRequestBody ? `Request Body: ${cachedRequestBody}` : "Request Body: (none)"]
              )
            ]
          ) : "",
          div(
            {
              style: {
                marginBottom: "12px",
                padding: "10px",
                borderRadius: "6px",
                backgroundColor: headerDetected ? "#e6fffb" : "#fff1f0",
                color: headerDetected ? "#006d75" : "#a8071a",
                border: headerDetected ? "1px solid #b5f5ec" : "1px solid #ffa39e",
                fontSize: "12px"
              }
            },
            [
              headerDetected ? headerHasCookie ? "Header detected with Cookie" : "Header detected (Cookie missing)" : "No header detected"
            ]
          ),
          headerDetected ? button(
            {
              style: {
                width: "100%",
                padding: "10px 12px",
                borderRadius: "6px",
                backgroundColor: isRequestPending ? "#d9d9d9" : "#1677ff",
                color: "white",
                border: "none",
                cursor: isRequestPending ? "not-allowed" : "pointer",
                fontWeight: "600"
              },
              onclick: "onClick"
            },
            [isRequestPending ? "Generating..." : "Generate Proof"]
          ) : ""
        ]
      )
    ]
  );
}
export default { main, onClick, expandUI, minimizeUI, config };
