// @ts-nocheck
var sa = Object.create;
var Wt = Object.defineProperty;
var aa = Object.getOwnPropertyDescriptor;
var ca = Object.getOwnPropertyNames;
var la = Object.getPrototypeOf, ua = Object.prototype.hasOwnProperty;
var A = (e, t, n) => () => {
  if (n) throw n[0];
  try {
    return e && (t = e(e = 0)), t;
  } catch (o) {
    throw n = [o], o;
  }
};
var Jn = (e, t) => () => {
  try {
    return t || e((t = { exports: {} }).exports, t), t.exports;
  } catch (n) {
    throw t = 0, n;
  }
}, jt = (e, t) => {
  for (var n in t)
    Wt(e, n, { get: t[n], enumerable: !0 });
}, da = (e, t, n, o) => {
  if (t && typeof t == "object" || typeof t == "function")
    for (let r of ca(t))
      !ua.call(e, r) && r !== n && Wt(e, r, { get: () => t[r], enumerable: !(o = aa(t, r)) || o.enumerable });
  return e;
};
var Xn = (e, t, n) => (n = e != null ? sa(la(e)) : {}, da(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  t || !e || !e.__esModule ? Wt(n, "default", { value: e, enumerable: !0 }) : n,
  e
));

// openclaw/packages/normalization-core/src/record-coerce.ts
function J(e) {
  return e !== null && typeof e == "object" && !Array.isArray(e);
}
function $(e) {
  return J(e) ? e : void 0;
}
function G(e) {
  return J(e) ? e : null;
}
function Kt(e) {
  return e && typeof e == "object" ? e : void 0;
}
function be(e) {
  return Kt(e) ?? null;
}
var N = A(() => {
});

// openclaw/packages/normalization-core/src/string-coerce.ts
function q(e) {
  if (typeof e != "string")
    return null;
  let t = e.trim();
  return t || null;
}
function K(e) {
  return q(e) ?? void 0;
}
function U(e) {
  return typeof e == "string" && e.trim() ? e : void 0;
}
var B = A(() => {
});

// openclaw/packages/normalization-core/src/number-coercion.ts
function se(e) {
  return typeof e == "number" && Number.isFinite(e) ? e : void 0;
}
var pa, op, ae = A(() => {
  B();
  pa = 2147e6, op = Math.floor(pa / 1e3);
});

// openclaw/packages/gateway-client/src/device-auth.ts
var Qn = A(() => {
});

// openclaw/packages/gateway-client/src/chat-stream-message.ts
var er = A(() => {
  N();
});

// openclaw/packages/gateway-client/src/chat-stream-projection.ts
var tr = A(() => {
  N();
});

// openclaw/packages/normalization-core/src/string-normalization.ts
var at = A(() => {
  B();
});

// openclaw/packages/gateway-protocol/src/connect-error-details.ts
var M, yp, bp, Vt = A(() => {
  ae();
  at();
  M = {
    AUTH_REQUIRED: "AUTH_REQUIRED",
    AUTH_UNAUTHORIZED: "AUTH_UNAUTHORIZED",
    AUTH_TOKEN_MISSING: "AUTH_TOKEN_MISSING",
    AUTH_TOKEN_MISMATCH: "AUTH_TOKEN_MISMATCH",
    AUTH_TOKEN_NOT_CONFIGURED: "AUTH_TOKEN_NOT_CONFIGURED",
    AUTH_PASSWORD_MISSING: "AUTH_PASSWORD_MISSING",
    // pragma: allowlist secret
    AUTH_PASSWORD_MISMATCH: "AUTH_PASSWORD_MISMATCH",
    // pragma: allowlist secret
    AUTH_PASSWORD_NOT_CONFIGURED: "AUTH_PASSWORD_NOT_CONFIGURED",
    // pragma: allowlist secret
    AUTH_BOOTSTRAP_TOKEN_INVALID: "AUTH_BOOTSTRAP_TOKEN_INVALID",
    AUTH_DEVICE_TOKEN_MISMATCH: "AUTH_DEVICE_TOKEN_MISMATCH",
    AUTH_SCOPE_MISMATCH: "AUTH_SCOPE_MISMATCH",
    AUTH_RATE_LIMITED: "AUTH_RATE_LIMITED",
    AUTH_TAILSCALE_IDENTITY_MISSING: "AUTH_TAILSCALE_IDENTITY_MISSING",
    AUTH_TAILSCALE_PROXY_MISSING: "AUTH_TAILSCALE_PROXY_MISSING",
    AUTH_TAILSCALE_WHOIS_FAILED: "AUTH_TAILSCALE_WHOIS_FAILED",
    AUTH_TAILSCALE_IDENTITY_MISMATCH: "AUTH_TAILSCALE_IDENTITY_MISMATCH",
    AUTH_IDENTITY_HEADER_REQUIRED: "AUTH_IDENTITY_HEADER_REQUIRED",
    AUTH_VERIFIED_USER_REQUIRED: "AUTH_VERIFIED_USER_REQUIRED",
    AUTHENTICATED_PROFILE_UNAVAILABLE: "AUTHENTICATED_PROFILE_UNAVAILABLE",
    OPERATOR_ACCESS_DENIED: "OPERATOR_ACCESS_DENIED",
    CONTROL_UI_BUILD_MISMATCH: "CONTROL_UI_BUILD_MISMATCH",
    CONTROL_UI_ORIGIN_NOT_ALLOWED: "CONTROL_UI_ORIGIN_NOT_ALLOWED",
    PROTOCOL_MISMATCH: "PROTOCOL_MISMATCH",
    CONTROL_UI_DEVICE_IDENTITY_REQUIRED: "CONTROL_UI_DEVICE_IDENTITY_REQUIRED",
    DEVICE_IDENTITY_REQUIRED: "DEVICE_IDENTITY_REQUIRED",
    DEVICE_AUTH_INVALID: "DEVICE_AUTH_INVALID",
    DEVICE_AUTH_DEVICE_ID_MISMATCH: "DEVICE_AUTH_DEVICE_ID_MISMATCH",
    DEVICE_AUTH_SIGNATURE_EXPIRED: "DEVICE_AUTH_SIGNATURE_EXPIRED",
    DEVICE_AUTH_NONCE_REQUIRED: "DEVICE_AUTH_NONCE_REQUIRED",
    DEVICE_AUTH_NONCE_MISMATCH: "DEVICE_AUTH_NONCE_MISMATCH",
    DEVICE_AUTH_SIGNATURE_INVALID: "DEVICE_AUTH_SIGNATURE_INVALID",
    DEVICE_AUTH_PUBLIC_KEY_INVALID: "DEVICE_AUTH_PUBLIC_KEY_INVALID",
    PAIRING_REQUIRED: "PAIRING_REQUIRED",
    PAIRING_REJECTED: "PAIRING_REJECTED",
    PAIRING_EXPIRED: "PAIRING_EXPIRED",
    CLIENT_VERSION_MISMATCH: "CLIENT_VERSION_MISMATCH"
  }, yp = /* @__PURE__ */ new Map([
    ["token_missing", M.AUTH_TOKEN_MISSING],
    ["token_mismatch", M.AUTH_TOKEN_MISMATCH],
    ["token_missing_config", M.AUTH_TOKEN_NOT_CONFIGURED],
    ["password_missing", M.AUTH_PASSWORD_MISSING],
    ["password_mismatch", M.AUTH_PASSWORD_MISMATCH],
    ["password_missing_config", M.AUTH_PASSWORD_NOT_CONFIGURED],
    ["bootstrap_token_invalid", M.AUTH_BOOTSTRAP_TOKEN_INVALID],
    ["tailscale_user_missing", M.AUTH_TAILSCALE_IDENTITY_MISSING],
    ["tailscale_proxy_missing", M.AUTH_TAILSCALE_PROXY_MISSING],
    ["tailscale_whois_failed", M.AUTH_TAILSCALE_WHOIS_FAILED],
    ["tailscale_user_mismatch", M.AUTH_TAILSCALE_IDENTITY_MISMATCH],
    ["rate_limited", M.AUTH_RATE_LIMITED],
    ["device_token_mismatch", M.AUTH_DEVICE_TOKEN_MISMATCH],
    ["scope_mismatch", M.AUTH_SCOPE_MISMATCH],
    [void 0, M.AUTH_REQUIRED]
  ]), bp = /* @__PURE__ */ new Map([
    ["device-id-mismatch", M.DEVICE_AUTH_DEVICE_ID_MISMATCH],
    ["device-signature-stale", M.DEVICE_AUTH_SIGNATURE_EXPIRED],
    ["device-nonce-missing", M.DEVICE_AUTH_NONCE_REQUIRED],
    ["device-nonce-mismatch", M.DEVICE_AUTH_NONCE_MISMATCH],
    ["device-signature", M.DEVICE_AUTH_SIGNATURE_INVALID],
    ["device-public-key", M.DEVICE_AUTH_PUBLIC_KEY_INVALID]
  ]);
});

// openclaw/packages/gateway-client/src/connect-auth.ts
var nr = A(() => {
  B();
});

// openclaw/packages/gateway-client/src/browser-device-auth.ts
var rr = A(() => {
});

// openclaw/packages/gateway-client/src/gateway-origin-scope.ts
var or = A(() => {
});

// openclaw/packages/gateway-client/src/model-catalog-connect.ts
var ir = A(() => {
});

// openclaw/packages/retry/src/index.ts
function ct(e, t, n, o) {
  return typeof e != "number" || !Number.isFinite(e) ? t : Math.min(
    Math.max(e, n ?? Number.NEGATIVE_INFINITY),
    o ?? Number.POSITIVE_INFINITY
  );
}
function ga(e, t) {
  return Math.max(1, Math.round(ct(e, t)));
}
function $e(e) {
  let t = e === Number.POSITIVE_INFINITY ? 2147e6 : Number.isFinite(e) ? e : 0;
  return Math.min(Math.max(Math.round(t), 0), 2147e6);
}
function ma(e, t) {
  return e === "full" ? "full" : typeof e == "number" && Number.isFinite(e) ? Math.min(Math.max(e, 0), 1) : t;
}
function ya(e = sr, t) {
  let n = ga(t?.attempts, e.attempts), o = $e(
    ct(t?.minDelayMs, e.minDelayMs, 0)
  ), r = Math.max(
    o,
    $e(ct(t?.maxDelayMs, e.maxDelayMs, 0))
  );
  return {
    attempts: n,
    minDelayMs: o,
    maxDelayMs: r,
    jitter: ma(t?.jitter, e.jitter)
  };
}
function ba(e, t, n, o) {
  if (t === "full")
    return n === "symmetric" ? Math.max(0, Math.round(e * (0.5 + o() * 0.5))) : Math.max(0, Math.ceil(e * (1 + o())));
  if (t <= 0)
    return n === "positive" ? Math.ceil(e) : e;
  let r = o(), i = n === "positive" ? r * t : (r * 2 - 1) * t, s = e * (1 + i);
  return Math.max(0, n === "positive" ? Math.ceil(s) : Math.round(s));
}
function wa(e, t = "Non-Error thrown") {
  if (e instanceof Error)
    return e;
  if (typeof e == "string")
    return new Error(e);
  let n = new Error(t, { cause: e });
  return (typeof e == "object" && e !== null || typeof e == "function") && Object.assign(n, e), n;
}
function Ra(e = {}) {
  let t = e.sleep ?? ha, n = e.random ?? Math.random, o = e.createFailure ?? ((r) => wa(r.at(-1) ?? new Error("Retry failed")));
  return async function(i, s = 3, c = 300) {
    let u = [], p = typeof s == "number", g = typeof s == "number" ? { attempts: s } : s, f = ya(sr, g), m = f.attempts, l = f.minDelayMs, d = f.maxDelayMs > 0 ? f.maxDelayMs : Number.POSITIVE_INFINITY, y = g.retryAfterMaxDelayMs === void 0 ? d : Math.max(
      l,
      $e(ct(g.retryAfterMaxDelayMs, d, 0))
    ), h = g.random ?? n, b = g.sleep ?? t, w = g.shouldRetry ?? (() => !0);
    for (let R = 1; R <= m; R += 1)
      try {
        return await i();
      } catch (S) {
        if (u.push(S), R >= m || !w(S, R))
          break;
        if (p) {
          await t($e(c * 2 ** (R - 1)));
          continue;
        }
        let x = {
          attempt: R,
          maxAttempts: m,
          err: S,
          label: g.label
        }, E = g.retryAfterMs?.(S), P = typeof E == "number" && Number.isFinite(E), _ = typeof g.delayMs == "function" ? g.delayMs(x) : g.delayMs, C = _ === void 0 ? void 0 : $e(_), O = P ? Math.max(E, l) : C === void 0 ? l * 2 ** (R - 1) : Math.max(C, l), I = P ? y : d, v = Math.min(O, I), z = P && (E ?? 0) <= I, V = f.jitter === "full" && !P || z;
        v = ba(
          v,
          f.jitter,
          V ? "positive" : "symmetric",
          h
        ), v = Math.min(Math.max(v, l), I), await g.onRetry?.({ ...x, delayMs: v }), v > 0 && await b(v);
      }
    throw o(u);
  };
}
var sr, ha, kp, Yt = A(() => {
  sr = {
    attempts: 3,
    minDelayMs: 300,
    maxDelayMs: 3e4,
    jitter: 0
  }, ha = async (e) => {
    let t = e;
    do {
      let n = Math.min(t, 2147e6);
      await new Promise((o) => {
        setTimeout(o, n);
      }), t -= n;
    } while (t > 0);
  };
  kp = Ra();
});

// openclaw/packages/gateway-protocol/src/startup-unavailable.ts
var ar = A(() => {
});

// openclaw/packages/gateway-client/src/protocol-client.ts
var cr = A(() => {
  N();
  Yt();
});

// openclaw/packages/gateway-client/src/reconnect-policy.ts
var Lp, lr = A(() => {
  Vt();
  Lp = /* @__PURE__ */ new Set([
    M.AUTH_TOKEN_MISSING,
    M.AUTH_BOOTSTRAP_TOKEN_INVALID,
    M.AUTH_PASSWORD_MISSING,
    M.AUTH_PASSWORD_MISMATCH,
    M.AUTH_RATE_LIMITED,
    M.AUTH_DEVICE_TOKEN_MISMATCH,
    M.AUTH_SCOPE_MISMATCH,
    M.AUTH_IDENTITY_HEADER_REQUIRED,
    M.AUTH_VERIFIED_USER_REQUIRED,
    M.CONTROL_UI_BUILD_MISMATCH,
    M.PAIRING_REQUIRED,
    M.PAIRING_REJECTED,
    M.PAIRING_EXPIRED,
    M.CONTROL_UI_DEVICE_IDENTITY_REQUIRED,
    M.DEVICE_IDENTITY_REQUIRED
  ]);
});

// openclaw/packages/normalization-core/src/stable-stringify.ts
var ur = A(() => {
});

// openclaw/packages/gateway-protocol/src/gateway-error-details.ts
var dr = A(() => {
});

// openclaw/packages/gateway-client/src/session-projection-message-identity.ts
function pr(e) {
  return typeof e == "number" && Number.isSafeInteger(e) && e > 0 ? e : null;
}
function fr(e, t) {
  let n = G(G(e)?.__openclaw);
  return pr(n?.seq) ?? pr(t?.messageSeq);
}
function qe(e) {
  let t = q(e);
  return t?.endsWith(":user") ? t.slice(0, -5) || null : t;
}
function Zt(e, t) {
  let n = G(e), o = q(n?.role)?.toLowerCase();
  if (!n || !o)
    return null;
  let r = G(n.__openclaw), i = q(r?.importedFrom), s = q(r?.cliSessionId), c = q(r?.externalId), u = G(r?.transcriptPosition), p = q(u?.source), f = !(p !== null && p.length <= 128 && typeof u?.rawSeq == "number" && Number.isSafeInteger(u.rawSeq) && u.rawSeq >= 0) && !!(i || s || c), m = q(r?.idempotencyKey) ?? q(n.idempotencyKey) ?? q(t?.idempotencyKey) ?? q(t?.clientRunId), l = qe(m), d = qe(t?.runId), y = qe(r?.runId), h = qe(
    G(n.openclawStreamFallback)?.runId
  ), b = q(r?.mirrorOrigin) !== null, w = o === "assistant" && q(n.api)?.toLowerCase() === "cli", R = w && l?.startsWith("cli-assistant:") ? q(l.slice(14)) : l, S = o === "assistant" ? y ?? d ?? h ?? (w || !b ? R : null) : y ?? R ?? d;
  return {
    role: o,
    id: q(r?.id) ?? q(t?.messageId),
    sequence: fr(e, t),
    idempotencyKey: m,
    sendId: o === "user" ? l ?? S : null,
    runId: S,
    isImported: f,
    // Imported IDs belong to their provider and CLI session, never the native ID namespace.
    externalSource: f && i && s && c ? JSON.stringify([i, s, c]) : null
  };
}
var hr = A(() => {
  N();
  B();
});

// openclaw/packages/gateway-client/src/session-projection.ts
var gr = A(() => {
  N();
  B();
  hr();
});

// openclaw/packages/normalization-core/src/result.ts
var mr = A(() => {
});

// openclaw/packages/normalization-core/src/agent-id.ts
var lt = A(() => {
  mr();
});

// openclaw/packages/normalization-core/src/uuid.ts
var Jt = A(() => {
});

// openclaw/packages/gateway-client/src/session-subscriptions.ts
var yr = A(() => {
  lt();
  Jt();
});

// openclaw/packages/gateway-protocol/src/client-info.ts
var xa, Ea, cf, lf, br = A(() => {
  B();
  xa = {
    WEBCHAT_UI: "webchat-ui",
    CONTROL_UI: "openclaw-control-ui",
    BROWSER_COPILOT: "openclaw-browser-copilot",
    TUI: "openclaw-tui",
    WEBCHAT: "webchat",
    CLI: "cli",
    GATEWAY_CLIENT: "gateway-client",
    MACOS_APP: "openclaw-macos",
    // Native Linux UI uses the same trusted-client admission class as the macOS app.
    LINUX_APP: "openclaw-linux",
    IOS_APP: "openclaw-ios",
    WATCHOS_APP: "openclaw-watchos",
    ANDROID_APP: "openclaw-android",
    NODE_HOST: "node-host",
    WORKER: "openclaw-worker",
    TEST: "test",
    FINGERPRINT: "fingerprint",
    PROBE: "openclaw-probe"
  }, Ea = {
    WEBCHAT: "webchat",
    CLI: "cli",
    UI: "ui",
    BACKEND: "backend",
    NODE: "node",
    WORKER: "worker",
    PROBE: "probe",
    TEST: "test"
  }, cf = new Set(Object.values(xa)), lf = new Set(Object.values(Ea));
});

// openclaw/packages/gateway-protocol/src/session-row-deltas.ts
var wr = A(() => {
});

// openclaw/packages/gateway-protocol/src/version.ts
var Rr = A(() => {
});

// openclaw/packages/gateway-client/src/browser.ts
var Sr = A(() => {
  Qn();
  er();
  tr();
  rr();
  or();
  nr();
  ir();
  cr();
  lr();
  gr();
  yr();
  br();
  Vt();
  dr();
  wr();
  ar();
  Rr();
});

// openclaw/packages/normalization-core/src/balanced-json.ts
var xr = A(() => {
});

// openclaw/packages/normalization-core/src/boolean-coercion.ts
var Er = A(() => {
});

// openclaw/packages/normalization-core/src/cjk-chars.ts
var Qt, Of, Nf, Tr = A(() => {
  Qt = [
    [
      [183, 183],
      [12288, 12703],
      [19968, 40869],
      [44032, 55215],
      [65281, 65376]
    ],
    [
      [4352, 4607],
      [11904, 12287],
      [12704, 19967],
      [40870, 40959],
      [40960, 42239],
      [42752, 42759],
      [43360, 43391],
      [55216, 55295],
      [63744, 64255]
    ],
    [
      [711, 711],
      [713, 715],
      [729, 729],
      [746, 747],
      [773, 773],
      [803, 803],
      [65040, 65103],
      [65377, 65500],
      [65504, 65510]
    ],
    [[119648, 119665]],
    [
      [94176, 94207],
      [110576, 110591],
      [110592, 110959],
      [127488, 127743],
      [131072, 195103],
      [196608, 210047]
    ]
  ], Of = new RegExp(
    `[${Qt.flatMap(
      (e) => e.map(([t, n]) => `\\u{${t.toString(16)}}-\\u{${n.toString(16)}}`)
    ).join("")}]`,
    "u"
  ), Nf = (() => {
    let e = Math.max(
      ...Qt.flatMap((n) => n.map(([, o]) => o))
    ), t = new Uint8Array(e + 1);
    for (let [n, o] of Qt.entries())
      for (let [r, i] of o)
        t.fill(n + 1, r, i + 1);
    return t;
  })();
});

// openclaw/packages/normalization-core/src/code-points.ts
var en = A(() => {
});

// openclaw/packages/normalization-core/src/error-coercion.ts
var Ta, Ar, Cr, kr, _r = A(() => {
  Ta = /* @__PURE__ */ Symbol.for(
    "openclaw.provider-auth-persistence-error"
  ), kr = class extends (Cr = AggregateError, Ar = Ta, Cr) {
    constructor(n, o, { cause: r }) {
      super([o, r], n, { cause: r });
      this[Ar] = !0;
      this.persistenceError = o, this.cleanupError = r;
    }
  };
});

// openclaw/packages/normalization-core/src/expect.ts
var tn = A(() => {
});

// openclaw/packages/normalization-core/src/format.ts
var vr = A(() => {
  tn();
});

// openclaw/packages/normalization-core/src/json-coercion.ts
function nn(e) {
  try {
    return JSON.parse(e);
  } catch {
    return;
  }
}
function Re(e) {
  return /^[\t\n\r ]*\{/.test(e) ? $(nn(e)) : void 0;
}
var rn = A(() => {
  N();
});

// openclaw/packages/normalization-core/src/response-bytes.ts
var Ir = A(() => {
});

// openclaw/packages/normalization-core/src/text-decoding.ts
var Pr = A(() => {
});

// openclaw/packages/normalization-core/src/utf16-slice.ts
function Dr(e) {
  return e >= 55296 && e <= 56319;
}
function Mr(e) {
  return e >= 56320 && e <= 57343;
}
function Or(e, t, n) {
  let o = e.length, r = t < 0 ? Math.max(o + t, 0) : Math.min(t, o), i = n === void 0 ? o : n < 0 ? Math.max(o + n, 0) : Math.min(n, o);
  if (i <= r)
    return "";
  if (r > 0 && r < o) {
    let s = e.charCodeAt(r);
    Mr(s) && Dr(e.charCodeAt(r - 1)) && (r += 1);
  }
  if (i > 0 && i < o) {
    let s = e.charCodeAt(i - 1);
    Dr(s) && Mr(e.charCodeAt(i)) && (i -= 1);
  }
  return e.slice(r, i);
}
function We(e, t) {
  let n = Math.max(0, Math.floor(t));
  return e.length <= n ? e : Or(e, 0, n);
}
var Oe = A(() => {
});

// openclaw/packages/normalization-core/src/index.ts
var X = A(() => {
  xr();
  Er();
  Tr();
  en();
  _r();
  tn();
  vr();
  rn();
  ae();
  N();
  Ir();
  ur();
  B();
  at();
  Pr();
  Oe();
});

// openclaw/packages/net-policy/src/redact-sensitive-url.ts
var Nr = A(() => {
  B();
});

// openclaw/src/logging/redact-pattern-runtime.ts
function Ur(e) {
  let t = e.match(/^\/(.+)\/([gimsuy]*)$/);
  if (!t)
    return [e, "gi"];
  let n = t[1] ?? "", o = t[2] ?? "";
  return [n, o.includes("g") ? o : `${o}g`];
}
var Lr = A(() => {
});

// openclaw/packages/acp-core/src/structured-auth-redaction.ts
var ut, ue, Ne, Ue, ce, le, dt, Se, F, fh, hh, Fr = A(() => {
  ut = "[A-Za-z0-9!#$%&'*+.^_`|~-]+", ue = String.raw`(?:\[REDACTED\]|[^\s\\"',;&#?<>)}\]]+)`, Ne = String.raw`\\{1,64}t`, Ue = String.raw`(?:[ \t]+|${Ne})`, ce = String.raw`(?:[ \t]*\r?\n${Ue}|[ \t]*\\{1,64}r\\{1,64}n${Ue}|[ \t]*\\{1,64}n${Ue}|[ \t]*${Ne}[ \t]*|[ \t]*)`, le = String.raw`(?:[ \t]*\r?\n${Ue}|[ \t]*\\{1,64}r\\{1,64}n${Ue}|[ \t]*\\{1,64}n${Ue}|[ \t]*${Ne}[ \t]*|[ \t]+)`, dt = String.raw`(?:[ \t\r\n]*|[ \t]*\\{1,64}r\\{1,64}n(?:[ \t]*|${Ne})|[ \t]*\\{1,64}n(?:[ \t]*|${Ne})|[ \t]*${Ne}[ \t]*)`, Se = String.raw`(^|[^A-Za-z0-9_-]|\\{1,64}[rn])`, F = String.raw`(?:\\{1,64}["']|["']|)`, fh = String.raw`${Se}(?:x-goog-api-key|api-key|apikey|x-api-token|x-access-token)${F}[ \t]*[:=]${ce}${F}([^\s\\"',;]+)`, hh = new RegExp(
    String.raw`${Se}(?:Proxy-)?Authorization${F}[ \t]*[:=]${ce}${F}(${ut})${le}`,
    "giu"
  );
});

// openclaw/src/logging/redact-pem.ts
var Br, Gr = A(() => {
  Br = String.raw`-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]+?-----END [A-Z ]*PRIVATE KEY-----`;
});

// openclaw/src/logging/redact-patterns.ts
function sn(e) {
  let t = e.charCodeAt(0);
  return t >= 65 && t <= 90 || t >= 97 && t <= 122 || t >= 48 && t <= 57 || e === "/" || e === "+" || e === "=";
}
function Vr(e) {
  for (let t = 39; t < e.length; ) {
    let n = t;
    for (; n > t - 40 && sn(e[n]); )
      n--;
    if (n === t - 40)
      return Kr.test(e);
    t = n + 40;
  }
  return !1;
}
function* Ka(e) {
  if (!Vr(e))
    return;
  let t = {
    '"': '"',
    "'": "'",
    "`": "`",
    "<": ">",
    "(": ")",
    "[": "]",
    "{": "}"
  }, n = -1, o = -1, r, i = 0, s = [];
  for (let c = 0; c <= e.length; c++) {
    let u = e[c] ?? "", p = c === e.length || qa.test(u), g = i;
    if (i = u === "\\" ? i + 1 : 0, u && sn(u) ? n === -1 && (n = c) : n !== -1 && (c - n === 40 ? s.push({ start: n, end: c, origin: n, url: r }) : c - n > 40 && u === "@" && e[c - 41] === "/" && s.push({ start: c - 40, end: c, origin: n, url: r }), n = -1), p) {
      r && (r.end = Math.min(r.end, c));
      for (let f of s) {
        let m = f.url, l = m && !m.hasAt && m.portValid && (m.portStart === -1 || (m.authorityEnd === -1 ? m.end : m.authorityEnd) > m.portStart + 1), d = e[f.start - 1] ?? "", y = e[f.end] ?? "", h = f.start !== f.origin, b = m && m.portStart !== -1 && f.origin === m.portStart + 1 && m.authorityEnd > f.origin && f.end > m.authorityEnd && y === "@";
        if (!h && (d === "_" || sn(d)) || y === "_" || e.slice(f.origin - 8, f.origin) === ";base64," || l && !b && f.start >= m.start && f.end <= m.end)
          continue;
        let w = e.slice(f.start, f.end);
        Kr.test(w) && (yield { match: w, groups: [w], input: e, offset: f.start });
      }
      s.length = 0, o = -1, r = void 0;
      continue;
    }
    if (r && c >= r.start && (u === r.closing && g === r.closingEscapeDepth ? (r.end = Math.min(r.end, c), r = void 0) : ("?#\"'<>`|()[]{}".includes(u) && (r.end = Math.min(r.end, c)), r.queryOrFragment ||= u === "?" || u === "#", r.authorityEnd === -1 && (r.hasAt ||= u === "@", "/?#".includes(u) ? r.authorityEnd = c : c < r.end && (u === ":" ? (r.portValid &&= r.portStart === -1, r.portStart = c) : r.portStart !== -1 && (u < "0" || u > "9") && (r.portValid = !1))))), Wa.test(u))
      o === -1 && (o = c);
    else {
      if ((!r || c >= r.end && !r.queryOrFragment) && u === ":" && e.startsWith("//", c + 1) && o !== -1 && ja.test(e[o])) {
        let f = e[o - 1], m = 0;
        for (let l = o - 2; l >= 0 && e[l] === "\\"; l--)
          m++;
        r = {
          start: c + 3,
          end: e.length,
          authorityEnd: -1,
          portStart: -1,
          portValid: !0,
          hasAt: !1,
          queryOrFragment: !1,
          closing: f ? t[f] : void 0,
          closingEscapeDepth: m
        };
      }
      o = -1;
    }
  }
}
function* Xa(e) {
  if (!/pass\s*:/.test(e))
    return;
  let t = [...e.matchAll(Ya)];
  if (t.length === 0)
    return;
  let n = 0, o = !1;
  for (let r = 0; r < e.length; r++) {
    let i = t[n];
    if (!i)
      return;
    if (r === i.index) {
      n++;
      let c = e[r - 1] ?? "", u = i[1] !== "pass" || c === "." || c === "-" || c === "_";
      if (!(!u && !o && c === " " && Za.test(e[r - 2] ?? ""))) {
        o = !0;
        let g = r + i[0].length;
        if (!u) {
          zr.lastIndex = g;
          let m = zr.exec(e)?.[0];
          m && (g += m.length, yield { match: e.slice(r, g), groups: [m], input: e, offset: r });
        }
        let f = t[n];
        for (; f && f.index < g; )
          n++, f = t[n];
        r = g - 1;
        continue;
      }
    }
    let s = e[r];
    s === `
` || s === "\r" ? o = !1 : (s === "=" || s === ":" && !Ja.test(e[r + 1] ?? " ")) && (o = !0);
  }
}
var $r, Le, ka, ft, Aa, Ca, qr, an, Wr, _a, jr, Hr, wh, va, Ia, Pa, Da, Ma, Oa, Na, Ua, La, Fa, Ba, Ga, Ha, za, $a, xe, pt, Kr, qa, Wa, ja, Va, Ya, zr, Za, Ja, Qa, ec, tc, Yr, Zr, ht, nc, rc, oc, ic, sc, ac, cc, lc, uc, dc, pc, Jr, Xr = A(() => {
  Fr();
  Gr();
  $r = String.raw`CARD[_-]?NUMBER|CARD[_-]?CVC|CARD[_-]?CVV|CVC|CVV|SECURITY[_-]?CODE|PAYMENT[_-]?CREDENTIAL|SHARED[_-]?PAYMENT[_-]?TOKEN`, Le = String.raw`card[-_]?number|card[-_]?cvc|card[-_]?cvv|cvc|cvv|security[-_]?code|payment[-_]?credential|shared[-_]?payment[-_]?token`, ka = String.raw`cardNumber|card_number|cardCvc|card_cvc|cardCvv|card_cvv|cvc|cvv|securityCode|security_code|paymentCredential|payment_credential|sharedPaymentToken|shared_payment_token`, ft = String.raw`aws[-_]?secret[-_]?access[-_]?key|awsSecretAccessKey|SecretAccessKey`, Aa = String.raw`access[-_]?token|auth[-_]?token|hook[-_]?token|refresh[-_]?token|id[-_]?token|api[-_]?key|apikey|client[-_]?secret|app[-_]?secret|private[-_]?key|${ft}|credential|authorization|token|key|secret|password|pass|passwd|auth|jwt|session|code|signature|x[-_]?amz[-_]?(?:signature|security[-_]?token)`, Ca = String.raw`${Aa}|app[-_]?secret|credential|${Le}`, qr = String.raw`access_token|refresh_token|id_token|auth[-_]?token|hook[-_]?token|api[-_]?key|client[-_]?secret|app[-_]?secret|private[-_]?key|authorization|jwt|token|secret|password|pass|passwd|credential|${Le}`, an = String.raw`access[-_]?token|refresh[-_]?token|id[-_]?token|auth[-_]?token|hook[-_]?token|api[-_]?(?:key|secret)|client[-_]?secret|app[-_]?secret|private[-_]?key|secret[-_]?key|key[-_]?material|authorization|jwt|token|secret|password|passphrase|pass|passwd|credential|${Le}`, Wr = String.raw`access[-_]?token|refresh[-_]?token|id[-_]?token|auth[-_]?token|hook[-_]?token|api[-_]?(?:key|secret)|client[-_]?secret|app[-_]?secret|private[-_]?key|secret[-_]?key|key[-_]?material|authorization|jwt|token|secret|password|passphrase|passwd|credential|${Le}`, _a = String.raw`access-token|refresh-token|id-token|auth-token|hook-token|api[-_]?(?:key|secret)|secret[-_]?key|key[-_]?material|passphrase`, jr = String.raw`password|passphrase|pass|passwd`, Hr = String.raw`${ft}|api[-_]?key|hook[-_]?token|access[-_]?token|refresh[-_]?token|id[-_]?token|token|secret|password|passwd|credential|private[-_]?key|client[-_]?secret|${Le}`, wh = String.raw`\p{C}\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000\u115F\u1160\u3164\uFFA0`, va = String.raw`/\b[A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|${$r})\b\s*[=:]\s*(["']?)([^\s"'\\]+)\1/g`, Ia = String.raw`/\b[A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|${$r})\b\s*[=:]\s*\\+(["'])([^\s"'\\]+)\\+\1/g`, Pa = String.raw`(^|[\s,;({\["])(?:${qr})=(["'\x60])((?:(?!\2)[^\r\n])+)\2`, Da = String.raw`(^|[\s,;({\["])(?:${qr})=(["'\x60]?[^\s&#"'\x60<>]+)`, Ma = String.raw`access[-_]?token|refresh[-_]?token|id[-_]?token|auth[-_]?token|hook[-_]?token|api[-_]?(?:key|secret)|secret[-_]?key|key[-_]?material|authorization|jwt|token|secret|password|passphrase|pass|passwd|${Le}`, Oa = String.raw`/(^|[\s,{])(?:(?:${Ma})(?:\s*:\s*|\s+=\s*|=\s*)|[a-z0-9][a-z0-9._-]{0,79}[-_](?:${jr})\s*[:=]\s*|[a-z0-9_.-]{1,80}\.(?:${an})\s*[:=]\s*)(["'\x60])((?:(?!\2)[^\r\n])+)\2/g`, Na = String.raw`/(^|[\s,{])(?:(?:${Wr})\s*:\s*|(?:${an})(?:\s+=\s*|=\s+))([^\s#"'\x60<>]+)/g`, Ua = String.raw`/(^|[\s,{])(?:${_a})=([^\s#"'\x60<>]+)/g`, La = String.raw`/(^|[\s,{])[a-z0-9][a-z0-9._-]{0,79}[-_](?:${jr})\s*[:=]\s*([^\s#"'\x60<>]+)/g`, Fa = String.raw`/(^|[\s,{])[a-z0-9_.-]{1,80}\.(?:${an})\s*[:=]\s*([^\s#"'\x60<>]+)/g`, Ba = String.raw`"(?:apiKey|api_key|apiToken|api_token|bearerToken|bearer_token|token|secret|password|passwd|${ft}|credential|authorization|proxy-authorization|cookie|set-cookie|x-api-key|x-auth-token|accessToken|access_token|refreshToken|refresh_token|idToken|id_token|authToken|auth_token|clientSecret|client_secret|privateKey|private_key|secret_value|raw_secret|secret_input|key_material)"\s*:\s*"([^"]+)"`, Ga = String.raw`"(?:${ka})"\s*:\s*"([^"]+)"`, Ha = String.raw`(^|[\s,{])["']?(?:api[-_]key|access[-_]token|refresh[-_]token|id[-_]token|authToken|auth[-_]token|clientSecret|client[-_]secret|appSecret|app[-_]secret|private[-_]key|credential|authorization|secret[-_]value|raw[-_]secret|secret[-_]input|key[-_]material)["']?\s*[:=]\s*(["'])([^"'\r\n]+)\2`, za = String.raw`(^|[\s,{])["']?(?:authorization|proxy-authorization|cookie|set-cookie|x-api-key|x-auth-token)["']?\s*[:=]\s*(["'])([^"'\r\n]+)\2`, $a = String.raw`(^|[^A-Za-z0-9])`, xe = (e) => String.raw`${$a}(?=${e})(?<!;base64,[A-Za-z0-9+/=]*)(${e})`, pt = String.raw`(^|[^A-Za-z0-9_])`;
  Kr = /(?=[A-Za-z0-9/+=]{0,39}[A-Z])(?=[A-Za-z0-9/+=]{0,39}[a-z])(?=[A-Za-z0-9/+=]{0,39}[0-9/+=])(?=[A-Za-z0-9/+=]{0,39}[G-Zg-z/+=])[A-Za-z0-9/+=]{40}/u;
  qa = /\s/, Wa = /[A-Za-z0-9+.-]/, ja = /[A-Za-z]/;
  Va = Object.freeze({
    source: "aws-secret-access-key",
    exec: Ka,
    couldMatch: Vr
  }), Ya = new RegExp(
    String.raw`(?<![A-Za-z0-9])(pass|${Wr})\s*:\s*`,
    "gi"
  ), zr = /[^\s#"'\x60<>]+/y, Za = /[A-Za-z0-9]/, Ja = /[ \t\r\n]/;
  Qa = Object.freeze({
    source: "bare-pass-assignment",
    exec: Xa
  }), ec = String.raw`\bbot(\d{6,}:[A-Za-z0-9_-]{20,})\b`, tc = String.raw`\b(\d{6,}:[A-Za-z0-9_-]{20,})\b`, Yr = "x-goog-api-key|api-key|apikey|x-api-token|x-access-token", Zr = "X-OpenClaw-Token|x-pomerium-jwt-assertion|X-Api-Key|X-Auth-Token", ht = String.raw`(^|[^A-Za-z0-9_?&-]|\\{1,64}[rn])`, nc = String.raw`${ht}(?:${Yr})${F}[ \t]*:${ce}${F}([^\s\\"',;]+)`, rc = String.raw`${ht}(?:${Yr})${F}[ \t]*=${ce}${F}([^\s\\"',;]+)`, oc = String.raw`${ht}(?:${Zr})\s*:\s*([^\s"',;]+)`, ic = String.raw`${ht}(?:${Zr})\s*=\s*([^\s"',;]+)`, sc = [
    String.raw`${Se}Proxy-Authorization${F}[ \t]*[:=]${ce}${F}${ut}${le}(${ue})`,
    String.raw`${Se}Proxy-Authorization${F}[ \t]*[:=]${ce}${F}(${ue})[ \t]*(?=${F}(?:$|[,;)}\]]|\r?\n(?![ \t])))`,
    String.raw`${Se}Authorization${F}[ \t]*[:=]${ce}${F}(?!(?:Bearer|Basic|Bot)(?=${le}))${ut}${le}(${ue})`,
    String.raw`${Se}Authorization${F}[ \t]*[:=]${ce}${F}(?!(?:Bearer|Basic|Bot)(?=${le}))(${ue})[ \t]*(?=${F}(?:$|[,;)}\]]|\r?\n(?![ \t])))`,
    nc,
    rc
  ], ac = String.raw`Authorization${F}[ \t]*[:=]${dt}${F}Bearer${le}(${ue})`, cc = String.raw`Authorization${F}[ \t]*[:=]${dt}${F}Basic${le}(${ue})`, lc = String.raw`Authorization${F}[ \t]*[:=]${dt}${F}Bot${le}(${ue})`, uc = String.raw`\bBearer\s+([-A-Za-z0-9._~+/=]{18,})(?![-A-Za-z0-9._~+/=])`, dc = [
    va,
    Ia,
    Ba,
    Ga,
    Ha,
    za,
    String.raw`--(?:${Hr})=([^\s"']+)`,
    String.raw`--(?:${Hr})\s+(?!(?:or|and)\b(?=\s+--))(["']?)([^\s"']+)\1`,
    ac,
    cc,
    lc,
    ...sc,
    oc,
    ic,
    uc,
    String.raw`\b(?:https?|wss?|ftp):\/\/[^\/\s:@]*:([^\/\s@]+)@`,
    String.raw`\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|rediss?|amqps?):\/\/[^:\s/@]*:([^@\s]+)@`,
    String.raw`(^|[\s,;])(?:${Ca})=([^&\s]+)(?=&[A-Za-z_][A-Za-z0-9_.-]*=)`,
    Pa,
    Da,
    Oa,
    Na,
    // Runs where the generic rule handled bare `pass:`, before the namespaced and prefixed rules.
    Qa,
    Ua,
    La,
    Fa,
    Br,
    String.raw`(^|[\s,{])["']?(?:${ft})["']?\s*[:=]\s*(["']?)([A-Za-z0-9/+=]{40})(?![A-Za-z0-9/+=])\2`
  ], pc = [
    String.raw`\b(sk-[A-Za-z0-9_-]{8,})\b`,
    String.raw`(ghp_[A-Za-z0-9]{10,})`,
    String.raw`(github_pat_[A-Za-z0-9_]{10,})`,
    String.raw`(gho_[A-Za-z0-9]{10,})`,
    String.raw`(ghu_[A-Za-z0-9]{10,})`,
    String.raw`(ghs_[A-Za-z0-9]{10,})`,
    String.raw`(ghr_[A-Za-z0-9]{10,})`,
    String.raw`(glpat-[A-Za-z0-9._=\-]{20,})`,
    String.raw`(gloas-(?:[A-Fa-f0-9]{65,}|[A-Za-z0-9_-]{64}|[A-Fa-f0-9]{32,}))`,
    String.raw`(gldt-[A-Za-z0-9_-]{20,})`,
    String.raw`(glcbt-[A-Za-z0-9]{1,5}_[A-Za-z0-9_-]{20,})`,
    String.raw`(glptt-[A-Za-z0-9_-]{40,})`,
    String.raw`(glft-(?:[A-Za-z0-9_-]{20,}|[a-h0-9]+-[0-9]+_))`,
    String.raw`(glimt-[A-Za-z0-9_-]{25,})`,
    String.raw`(glagent-[A-Za-z0-9_-]{50,})`,
    String.raw`(glwt-[A-Za-z0-9_-]{20,})`,
    String.raw`(glsoat-[A-Za-z0-9_-]{20,})`,
    String.raw`(glffct-[A-Za-z0-9_-]{20,})`,
    String.raw`(glrt-[A-Za-z0-9._-]{20,})`,
    String.raw`(glrtr?-[A-Za-z0-9_-]{27,300}\.[0-9a-z]{2}\.[0-9a-z]{9})`,
    String.raw`(GR1348941[A-Za-z0-9_-]{20,})`,
    String.raw`(_gitlab_session=[A-Za-z0-9%._-]{20,})`,
    String.raw`(xox[baprs]-[A-Za-z0-9-]{10,})`,
    String.raw`(xapp-[A-Za-z0-9-]{10,})`,
    String.raw`(https:\/\/hooks\.slack\.com\/(?:services\/T[A-Z0-9]+\/B[A-Z0-9]+|workflows\/T[A-Z0-9]+\/A[A-Z0-9]+\/[0-9]{17,19})\/[A-Za-z0-9]{20,})`,
    String.raw`(https:\/\/discord(?:app)?\.com\/api\/webhooks\/[0-9]{17,20}\/[A-Za-z0-9_-]{60,})`,
    String.raw`discord(?:.|\n|\r){0,40}?\b([A-Za-z0-9_-]{24}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{27})\b`,
    String.raw`(gsk_[A-Za-z0-9_-]{10,})`,
    String.raw`(AIza[0-9A-Za-z\-_]{20,})`,
    String.raw`(ya29\.[0-9A-Za-z_\-./+=]{10,})`,
    String.raw`(1//0[0-9A-Za-z_\-./+=]{10,})`,
    String.raw`(eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})`,
    String.raw`(pplx-[A-Za-z0-9_-]{10,})`,
    String.raw`(fal_[A-Za-z0-9_-]{10,})`,
    String.raw`${pt}(fc-[A-Za-z0-9]{10,})`,
    String.raw`(bb_live_[A-Za-z0-9_-]{10,})`,
    xe(String.raw`gAAAA[A-Za-z0-9_=-]{20,}`),
    String.raw`(sk_live_[A-Za-z0-9]{10,})`,
    String.raw`(sk_test_[A-Za-z0-9]{10,})`,
    String.raw`(rk_live_[A-Za-z0-9]{10,})`,
    String.raw`(SG\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})`,
    String.raw`(npm_[A-Za-z0-9]{10,})`,
    String.raw`(pypi-[A-Za-z0-9_-]{10,})`,
    String.raw`(dop_v1_[A-Za-z0-9]{10,})`,
    String.raw`(doo_v1_[A-Za-z0-9]{10,})`,
    String.raw`(dor_v1_[A-Za-z0-9]{10,})`,
    String.raw`(dp\.(?:ct|pt|sa|scim|audit)\.[A-Za-z0-9]{40,44})`,
    String.raw`(dp\.st\.[A-Za-z0-9]{40,44})`,
    String.raw`(dp\.st\.[a-z0-9_-]{2,35}\.[A-Za-z0-9]{40,44})`,
    String.raw`(dckr_(?:pat|oat)_[A-Za-z0-9_-]{27,32})`,
    String.raw`(bkua_[a-z0-9]{40})`,
    String.raw`(CCIPAT_[A-Za-z0-9]{22}_[A-Fa-f0-9]{40})`,
    String.raw`(sbp_[a-z0-9]{40})`,
    xe(String.raw`dapi[0-9a-f]{32}(?:-\d)?`),
    String.raw`(dd[pw]_[A-Za-z0-9]{36})`,
    String.raw`(glsa_[A-Za-z0-9_]{41})`,
    String.raw`(glc_eyJ[A-Za-z0-9+/=]{60,160})`,
    String.raw`(nfp_[A-Za-z0-9_]{36})`,
    String.raw`(CFPAT-[A-Za-z0-9_\-]{40,})`,
    xe(String.raw`ATCTT3xFfG[A-Za-z0-9+/=_-]+=[A-Za-z0-9]{8}`),
    xe(String.raw`ATATT[A-Za-z0-9+/=_-]+=[A-Za-z0-9]{8}`),
    xe(String.raw`ATBB[A-Za-z0-9_=.-]{16,}`),
    String.raw`(BBDC-[A-Za-z0-9+/@_-]{40,50})`,
    String.raw`(HRKU-AA[A-Za-z0-9_-]{20,})`,
    String.raw`(pat-(?:eu|na)1-[A-Za-z0-9]{8}\-[A-Za-z0-9]{4}\-[A-Za-z0-9]{4}\-[A-Za-z0-9]{4}\-[A-Za-z0-9]{12})`,
    String.raw`(apify_api_[A-Za-z0-9\-]{20,})`,
    String.raw`(FlyV1 fm\d+_[A-Za-z0-9+/=,_-]{100,})`,
    String.raw`(fio-u-[A-Za-z0-9_-]{40,})`,
    String.raw`(^|[^A-Za-z0-9_])(am_[A-Za-z0-9_-]{10,})`,
    String.raw`(^|[^A-Za-z0-9_])(sk_[A-Za-z0-9_]{10,})`,
    String.raw`(tvly-[A-Za-z0-9]{10,})`,
    String.raw`(exa_[A-Za-z0-9]{10,})`,
    String.raw`(syt_[A-Za-z0-9]{10,})`,
    String.raw`(retaindb_[A-Za-z0-9]{10,})`,
    String.raw`(hsk-[A-Za-z0-9]{10,})`,
    String.raw`(mem0_[A-Za-z0-9]{10,})`,
    String.raw`(brv_[A-Za-z0-9]{10,})`,
    String.raw`(xai-[A-Za-z0-9]{30,})`,
    String.raw`${pt}(fw-[A-Za-z0-9]{30,})`,
    String.raw`${pt}(fw_[A-Za-z0-9]{30,})`,
    String.raw`${pt}(fpk_[A-Za-z0-9]{30,})`,
    xe(String.raw`AKIA[A-Z0-9]{16}`),
    xe(String.raw`ASIA[A-Z0-9]{16}`),
    String.raw`(AKID[A-Za-z0-9]{10,})`,
    String.raw`(LTAI[A-Za-z0-9]{10,})`,
    String.raw`(hf_[A-Za-z0-9]{10,})`,
    String.raw`(api_org_[A-Za-z0-9]{20,})`,
    String.raw`(r8_[A-Za-z0-9]{10,})`,
    ec,
    tc
  ], Jr = [
    ...dc,
    ...pc,
    Va
  ];
});

// openclaw/ui/src/lib/browser-redact.ts
var _h, Qr = A(() => {
  Nr();
  Oe();
  Lr();
  Xr();
  _h = Jr.map(
    (e) => typeof e == "string" ? new RegExp(...Ur(e)) : e
  );
});

// openclaw/ui/src/lib/format-error.ts
var gt = A(() => {
  X();
  Qr();
});

// openclaw/node_modules/.pnpm/@noble+ed25519@3.2.0/node_modules/@noble/ed25519/index.js
var so, Fe, ln, mt, un, dn, yt, hc, gc, to, bt, mc, ao, co, lo, yc, Ee, H, no, T, bc, cn, uo, ke, je, Te, wc, Rc, te, Sc, ro, xc, pn, Ec, oo, io, Tc, po = A(() => {
  so = Object.freeze, Fe = 0x7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffedn, ln = 0x1000000000000000000000000000000014def9dea2f79cd65812631a5cf5d3edn, mt = 0x52036cee2b6ffe738cc740797779e89800700a4d4141d8ab75eb4dca135978a3n, un = 0x216936d3cd6e53fec0a4e231fdd6dc5c692cc7609525a7b2c9562d608f25d51an, dn = 0x6666666666666666666666666666666666666666666666666666666666666658n, yt = Fe - 1n, hc = so({
    p: Fe,
    n: ln,
    h: 8n,
    a: yt,
    d: mt,
    Gx: un,
    Gy: dn
  }), gc = 32, to = (e) => e instanceof Uint8Array || ArrayBuffer.isView(e) && e.constructor.name === "Uint8Array" && e.BYTES_PER_ELEMENT === 1, bt = (e, t, n = "") => {
    if (to(e) && (t === void 0 || e.length === t))
      return e;
    let o = to(e), r = t !== void 0 ? ` of length ${t}` : "", i = o ? `length=${e.length}` : `type=${typeof e}`, s = (n ? `"${n}" ` : "") + "expected Uint8Array" + r + ", got " + i;
    throw o ? new RangeError(s) : new TypeError(s);
  }, mc = (e, t = "", n) => Uint8Array.from(bt(e, n, t)), ao = (e, t) => e.toString(16).padStart(t, "0"), co = (e) => {
    let t = "";
    for (let n of bt(e))
      t += ao(n, 2);
    return t;
  }, lo = (e) => {
    let t = "hex invalid";
    if (typeof e != "string")
      throw new TypeError(t);
    if (e.length % 2 || !/^[\da-f]*$/i.test(e))
      throw new RangeError(t);
    let n = new Uint8Array(e.length / 2);
    for (let o = 0, r = 0; o < n.length; o++, r += 2) {
      let i = e.charCodeAt(r), s = e.charCodeAt(r + 1);
      n[o] = ((i & 15) + (i >> 6) * 9) * 16 + (s & 15) + (s >> 6) * 9;
    }
    return n;
  }, yc = (...e) => {
    let t = 0;
    for (let r of e)
      t += bt(r).length;
    let n = new Uint8Array(t), o = 0;
    for (let r of e)
      n.set(r, o), o += r.length;
    return n;
  }, Ee = (e, t, n, o = "bad number: out of range") => {
    if (typeof e != "bigint")
      throw new TypeError(o);
    if (t <= e && e < n)
      return e;
    throw new RangeError(o);
  }, H = (e, t = Fe) => (e %= t) >= 0n ? e : t + e, no = (1n << 255n) - 1n, T = (e) => {
    if (e < 0n)
      throw new RangeError("negative coordinate");
    let t = (e >> 255n) * 19n + (e & no);
    return t = (t >> 255n) * 19n + (t & no), t % Fe;
  }, bc = (e, t) => {
    if (e === 0n)
      throw new Error("invert: expected non-zero number");
    if (t <= 1n)
      throw new Error("invert: expected modulus > 1, got " + t);
    let n = H(e, t), o = t, r = 0n, i = 1n;
    for (; n !== 0n; ) {
      let c = o / n, u = o - n * c, p = r - i * c;
      o = n, n = u, r = i, i = p;
    }
    if (o !== 1n)
      throw new Error("invert: does not exist");
    return H(r, t);
  }, cn = (e) => {
    if (e instanceof ke)
      return e;
    throw new TypeError("Point expected");
  }, uo = 2n ** 256n, ke = class e {
    static BASE;
    static ZERO;
    X;
    Y;
    Z;
    T;
    // Constructor only bounds-checks and freezes XYZT coordinates; it does not prove the point is
    // on-curve or that T matches X*Y/Z.
    constructor(t, n, o, r) {
      let i = uo;
      this.X = Ee(t, 0n, i), this.Y = Ee(n, 0n, i), this.Z = Ee(o, 1n, i), this.T = Ee(r, 0n, i), so(this);
    }
    static CURVE() {
      return hc;
    }
    static fromAffine(t) {
      return new e(t.x, t.y, 1n, T(t.x * t.y));
    }
    /** RFC8032 5.1.3: Uint8Array to Point. */
    static fromBytes(t, n = !1) {
      let o = mc(t, "point", gc), r = o[31];
      o[31] = r & -129;
      let i = Rc(o);
      n || Ee(i, 0n, Fe);
      let s = T(i * i), c = H(s - 1n), u = T(mt * s + 1n), { isValid: p, value: g } = xc(c, u);
      if (!p)
        throw new Error("bad point: y not sqrt");
      let f = !!(r & 128);
      if (!n && g === 0n && f)
        throw new Error("bad point: x==0, isLastByteOdd");
      return f !== !!(g & 1n) && (g = H(-g)), new e(g, i, 1n, T(g * i));
    }
    static fromHex(t, n) {
      return e.fromBytes(lo(t), n);
    }
    get x() {
      return this.toAffine().x;
    }
    get y() {
      return this.toAffine().y;
    }
    /** Checks if the point is valid and on-curve. */
    assertValidity() {
      let t = yt, n = mt, o = this;
      if (o.is0())
        throw new Error("bad point: ZERO");
      let { X: r, Y: i, Z: s, T: c } = o, u = T(r * r), p = T(i * i), g = T(s * s), f = T(g * g), m = T(u * t), l = T(g * (m + p)), d = H(f + T(n * T(u * p)));
      if (l !== d)
        throw new Error("bad point: equation left != right (1)");
      let y = T(r * i), h = T(s * c);
      if (y !== h)
        throw new Error("bad point: equation left != right (2)");
      return this;
    }
    /** Equality check: compare points P&Q. */
    equals(t) {
      let { X: n, Y: o, Z: r } = this, { X: i, Y: s, Z: c } = cn(t);
      return T(n * c) === T(i * r) && T(o * c) === T(s * r);
    }
    is0() {
      return this.equals(Te);
    }
    /** Flip point over y coordinate. */
    negate() {
      return new e(H(-this.X), this.Y, this.Z, H(-this.T));
    }
    /** Point doubling. Complete formula. Cost: `4M + 4S + 1*a + 6add + 1*2`. */
    double() {
      let { X: t, Y: n, Z: o } = this, r = yt, i = T(t * t), s = T(n * n), c = T(2n * o * o), u = T(r * i), p = H(t + n), g = H(T(p * p) - i - s), f = H(u + s), m = H(f - c), l = H(u - s), d = T(g * m), y = T(f * l), h = T(g * l), b = T(m * f);
      return new e(d, y, b, h);
    }
    /** Point addition. Complete formula. Cost: `9M + 1*a + 1*d + 7add`. */
    add(t) {
      let { X: n, Y: o, Z: r, T: i } = this, { X: s, Y: c, Z: u, T: p } = cn(t), g = yt, f = mt, m = T(n * s), l = T(o * c), d = T(T(i * f) * p), y = T(r * u), h = H(T(H(n + o) * H(s + c)) - m - l), b = H(y - d), w = H(y + d), R = H(l - T(g * m)), S = T(h * b), x = T(w * R), E = T(h * R), P = T(b * w);
      return new e(S, x, P, E);
    }
    subtract(t) {
      return this.add(cn(t).negate());
    }
    /**
     * Point-by-scalar multiplication. Safe mode requires `1 <= n < CURVE.n`.
     * Unsafe mode additionally permits `n = 0` and returns the identity point for that case.
     * Uses {@link wNAF} for base point.
     * Uses fake point to mitigate side-channel leakage.
     * @param n - scalar by which point is multiplied
     * @param safe - safe mode guards against timing attacks; unsafe mode is faster
     */
    multiply(t, n = !0) {
      if (!n && t === 0n || (Ee(t, 1n, ln), !n && this.is0()))
        return Te;
      if (t === 1n)
        return this;
      if (this.equals(je))
        return Tc(t).p;
      let o = Te, r = je, i = this;
      for (let s = 0; n ? s < 256 : t > 0n; s++)
        t & 1n ? o = o.add(i) : n && (r = r.add(i)), i = i.double(), t >>= 1n;
      return o;
    }
    multiplyUnsafe(t) {
      return this.multiply(t, !1);
    }
    /** Convert point to 2d xy affine point. (X, Y, Z) ∋ (x=X/Z, y=Y/Z) */
    toAffine() {
      let { X: t, Y: n, Z: o } = this;
      if (this.equals(Te))
        return { x: 0n, y: 1n };
      let r = bc(o, Fe);
      if (T(o * r) !== 1n)
        throw new Error("invalid inverse");
      return { x: T(t * r), y: T(n * r) };
    }
    toBytes() {
      let { x: t, y: n } = this.toAffine(), o = wc(n);
      return o[31] |= t & 1n ? 128 : 0, o;
    }
    toHex() {
      return co(this.toBytes());
    }
    clearCofactor() {
      return this.multiply(8n, !1);
    }
    isSmallOrder() {
      return this.clearCofactor().is0();
    }
    isTorsionFree() {
      return this.multiply(ln / 2n, !1).double().add(this).is0();
    }
  }, je = new ke(un, dn, 1n, H(un * dn)), Te = new ke(0n, 1n, 1n, 0n);
  ke.BASE = je;
  ke.ZERO = Te;
  wc = (e) => lo(ao(Ee(e, 0n, uo), 64)).reverse(), Rc = (e) => BigInt("0x" + co(Uint8Array.from(bt(e)).reverse())), te = (e, t) => {
    let n = e;
    for (; t-- > 0; )
      n = T(n * n);
    return n;
  }, Sc = (e) => {
    let t = T(e * e), n = T(t * e), o = T(te(n, 2) * n), r = T(te(o, 1) * e), i = T(te(r, 5) * r), s = T(te(i, 10) * i), c = T(te(s, 20) * s), u = T(te(c, 40) * c), p = T(te(u, 80) * u), g = T(te(p, 80) * u), f = T(te(g, 10) * i);
    return T(te(f, 2) * e);
  }, ro = 0x2b8324804fc1df0b2b4d00993dfbd7a72f431806ad2fe478c4ee1b274a0ea0b0n, xc = (e, t) => {
    let n = T(t * T(t * t)), o = T(T(n * n) * t), r = Sc(T(e * o)), i = T(e * T(n * r)), s = T(t * T(i * i)), c = i, u = T(i * ro), p = s === e, g = s === H(-e), f = s === H(-e * ro);
    return p && (i = c), (g || f) && (i = u), (H(i) & 1n) === 1n && (i = H(-i)), { isValid: p || g, value: i };
  }, pn = {
    sha512Async: async (e) => {
      let t = globalThis?.crypto?.subtle;
      if (!t)
        throw new Error("crypto.subtle must be defined, consider polyfill");
      return new Uint8Array(await t.digest("SHA-512", yc(e)));
    },
    sha512: void 0
  }, Ec = () => {
    let e = [], t = je, n;
    for (let o = 0; o < 33; o++) {
      n = t, e.push(n);
      for (let r = 1; r < 128; r++)
        n = n.add(t), e.push(n);
      t = n.double();
    }
    return e;
  }, io = (e, t) => {
    let n = t.negate();
    return e ? n : t;
  }, Tc = (e) => {
    let t = oo || (oo = Ec()), n = Te, o = je;
    for (let r = 0; r < 33; r++) {
      let i = Number(e & 255n);
      e >>= 8n, i > 128 && (i -= 256, e += 1n);
      let s = r * 128, c = s + Math.abs(i) - 1, u = r % 2 !== 0, p = i < 0;
      i === 0 ? o = o.add(io(u, t[s])) : n = n.add(io(p, t[c]));
    }
    if (e !== 0n)
      throw new Error("invalid wnaf");
    return { p: n, f: o };
  };
});

// openclaw/src/shared/control-ui-storage.ts
var fo, kc, ho = A(() => {
  fo = "openclaw.device.auth.v1", kc = `${fo}:`;
});

// openclaw/src/shared/device-auth.ts
var fn = A(() => {
  at();
});

// openclaw/ui/src/local-storage.ts
var go = A(() => {
});

// openclaw/ui/src/lib/bytes-base64.ts
var mo = A(() => {
});

// openclaw/node_modules/.pnpm/@noble+hashes@2.4.0/node_modules/@noble/hashes/_u64.js
function Ac(e, t = !1) {
  return t ? { h: Number(e & wt), l: Number(e >> yo & wt) } : { h: Number(e >> yo & wt) | 0, l: Number(e & wt) | 0 };
}
function bo(e, t = !1) {
  let n = e.length, o = new Uint32Array(n), r = new Uint32Array(n);
  for (let i = 0; i < n; i++) {
    let { h: s, l: c } = Ac(e[i], t);
    [o[i], r[i]] = [s, c];
  }
  return [o, r];
}
function wo(e, t, n, o) {
  let r = Cc(n), i = _c(n);
  e.setUint32(t, o ? i : r, o), e.setUint32(t + 4, o ? r : i, o);
}
function ne(e, t, n, o) {
  let r = (t >>> 0) + (o >>> 0);
  return { h: e + n + (r / 2 ** 32 | 0) | 0, l: r | 0 };
}
var wt, yo, Cc, _c, hn, gn, Ae, Ce, Ke, Ve, Ro, So, xo, Eo, To, ko, mn = A(() => {
  wt = BigInt(4294967295), yo = /* @__PURE__ */ BigInt(32);
  Cc = (e) => e / 2 ** 32 | 0, _c = (e) => e >>> 0;
  hn = (e, t, n) => e >>> n, gn = (e, t, n) => e << 32 - n | t >>> n, Ae = (e, t, n) => e >>> n | t << 32 - n, Ce = (e, t, n) => e << 32 - n | t >>> n, Ke = (e, t, n) => e << 64 - n | t >>> n - 32, Ve = (e, t, n) => e >>> n - 32 | t << 64 - n;
  Ro = (e, t, n) => (e >>> 0) + (t >>> 0) + (n >>> 0), So = (e, t, n, o) => t + n + o + (e / 2 ** 32 | 0) | 0, xo = (e, t, n, o) => (e >>> 0) + (t >>> 0) + (n >>> 0) + (o >>> 0), Eo = (e, t, n, o, r) => t + n + o + r + (e / 2 ** 32 | 0) | 0, To = (e, t, n, o, r) => (e >>> 0) + (t >>> 0) + (n >>> 0) + (o >>> 0) + (r >>> 0), ko = (e, t, n, o, r, i) => t + n + o + r + i + (e / 2 ** 32 | 0) | 0;
});

// openclaw/node_modules/.pnpm/@noble+hashes@2.4.0/node_modules/@noble/hashes/utils.js
function Ao(e) {
  return e instanceof Uint8Array || ArrayBuffer.isView(e) && e.constructor.name === "Uint8Array" && "BYTES_PER_ELEMENT" in e && e.BYTES_PER_ELEMENT === 1;
}
function Ic(e, t = "") {
  if (typeof e != "number")
    throw new TypeError(yn(t) + "expected number, got " + typeof e);
  if (!Number.isSafeInteger(e) || e < 0)
    throw new RangeError(yn(t) + "expected integer >= 0, got " + e);
  return e;
}
function bn(e, t, n = "") {
  if (Ao(e) && (t === void 0 || e.length === t))
    return e;
  t !== void 0 && Ic(t, "length");
  let o = Ao(e), r = t !== void 0 ? ` of length ${t}` : "", i = o ? `length=${e.length}` : `type=${typeof e}`, s = yn(n) + "expected Uint8Array" + r + ", got " + i;
  throw o ? new RangeError(s) : new TypeError(s);
}
function wn(e, t = !0) {
  if (e.destroyed)
    throw new Error("hash was destroyed");
  if (t && e.finished)
    throw new Error("digest() was already called");
}
function _o(e, t) {
  bn(e, void 0, "output");
  let n = t.outputLen;
  if (!(e.length >= n))
    throw new RangeError('"output" expected length >= ' + n);
}
function Ye(...e) {
  for (let t = 0; t < e.length; t++)
    e[t].fill(0);
}
function Rt(e) {
  return new DataView(e.buffer, e.byteOffset, e.byteLength);
}
function Q(e, t) {
  return e << 32 - t | e >>> t;
}
function Dc(e, t, n = "opts") {
  return Co(e, "defaults"), t !== void 0 && Co(t, n), Object.assign(/* @__PURE__ */ Object.create(null), e, t);
}
function _e(e, t = {}) {
  if (typeof e != "function")
    throw new TypeError('"hashCons" expected function, got type=' + typeof e);
  t = Dc({}, t, "info");
  let n = (r, i) => e(i).update(r).digest(), o = e(void 0);
  return n.outputLen = o.outputLen, n.blockLen = o.blockLen, n.canXOF = o.canXOF, n.create = (r) => e(r), Object.assign(n, t), Object.freeze(n);
}
var yn, Pc, Co, ve, Rn = A(() => {
  yn = (e) => e ? `"${e}" ` : "";
  Pc = (e, t) => {
    if (e === null || typeof e != "object" || Array.isArray(e))
      throw new TypeError((t === "object" ? "" : `"${t}" `) + "expected object, got type=" + typeof e);
  }, Co = (e, t) => {
    Pc(e, t);
    let n = Object.getPrototypeOf(e);
    if (n !== Object.prototype && n !== null)
      throw new TypeError(`"${t}" expected plain object`);
    if (Object.hasOwn(e, "__proto__"))
      throw new TypeError(`"${t}.__proto__" is not allowed`);
  };
  ve = (e) => ({
    // Current NIST hashAlgs suffixes used here fit in one DER subidentifier octet.
    // Larger suffix values would need base-128 OID encoding and a different length byte.
    oid: Uint8Array.from([6, 9, 96, 134, 72, 1, 101, 3, 4, 2, e])
  });
});

// openclaw/node_modules/.pnpm/@noble+hashes@2.4.0/node_modules/@noble/hashes/_md.js
function vo(e, t, n) {
  return e & t ^ ~e & n;
}
function Io(e, t, n) {
  return e & t ^ e & n ^ t & n;
}
var Ze, Po, Do, Mo, Oo, No = A(() => {
  mn();
  Rn();
  Ze = class {
    blockLen;
    outputLen;
    canXOF = !1;
    padOffset;
    isLE;
    // For partial updates less than block size
    buffer;
    view;
    finished = !1;
    length = 0;
    pos = 0;
    destroyed = !1;
    constructor(t, n, o, r) {
      this.blockLen = t, this.outputLen = n, this.padOffset = o, this.isLE = r, this.buffer = new Uint8Array(t), this.view = Rt(this.buffer);
    }
    update(t) {
      wn(this), bn(t);
      let { view: n, buffer: o, blockLen: r } = this, i = t.length, s = !1;
      for (let c = 0; c < i; ) {
        let u = Math.min(r - this.pos, i - c);
        if (u === r) {
          let p = Rt(t);
          for (; r <= i - c; c += r)
            this.process(p, c);
          s = !0;
          continue;
        }
        o.set(c === 0 && u === i ? t : t.subarray(c, c + u), this.pos), this.pos += u, c += u, this.pos === r && (this.process(n, 0), this.pos = 0, s = !0);
      }
      return this.length += t.length, s && this.roundClean(), this;
    }
    digestInto(t) {
      wn(this), _o(t, this), this.finished = !0;
      let { buffer: n, view: o, blockLen: r, isLE: i } = this, { pos: s } = this;
      n[s++] = 128, n.fill(0, s), this.padOffset > r - s && (this.process(o, 0), n.fill(0)), wo(o, r - 8, this.length * 8, i), this.process(o, 0), this.roundClean();
      let c = t === n ? o : Rt(t), u = this.outputLen, p = u / 4, g = this.get();
      if (u % 4 || p > g.length)
        throw new Error("invalid outputLen");
      for (let f = 0; f < p; f++)
        c.setUint32(4 * f, g[f], i);
    }
    digest() {
      let { buffer: t, outputLen: n } = this;
      this.digestInto(t);
      let o = t.slice(0, n);
      return this.destroy(), o;
    }
    _cloneIntoMeta(t) {
      let { buffer: n, length: o, finished: r, destroyed: i, pos: s } = this;
      return t.destroyed = i, t.finished = r, t.length = o, t.pos = s, s && t.buffer.set(n), t;
    }
    clone() {
      return this._cloneInto();
    }
  }, Po = /* @__PURE__ */ Uint32Array.from([
    1779033703,
    3144134277,
    1013904242,
    2773480762,
    1359893119,
    2600822924,
    528734635,
    1541459225
  ]), Do = /* @__PURE__ */ Uint32Array.from([
    3238371032,
    914150663,
    812702999,
    4144912697,
    4290775857,
    1750603025,
    1694076839,
    3204075428
  ]), Mo = /* @__PURE__ */ Uint32Array.from([
    3418070365,
    3238371032,
    1654270250,
    914150663,
    2438529370,
    812702999,
    355462360,
    4144912697,
    1731405415,
    4290775857,
    2394180231,
    1750603025,
    3675008525,
    1694076839,
    1203062813,
    3204075428
  ]), Oo = /* @__PURE__ */ Uint32Array.from([
    1779033703,
    4089235720,
    3144134277,
    2227873595,
    1013904242,
    4271175723,
    2773480762,
    1595750129,
    1359893119,
    2917565137,
    2600822924,
    725511199,
    528734635,
    4215389547,
    1541459225,
    327033209
  ]);
});

// openclaw/node_modules/.pnpm/@noble+hashes@2.4.0/node_modules/@noble/hashes/sha2.js
var Lo = {};
jt(Lo, {
  _SHA224: () => Et,
  _SHA256: () => xt,
  _SHA384: () => kt,
  _SHA512: () => Tt,
  _SHA512_224: () => At,
  _SHA512_256: () => Ct,
  sha224: () => Bc,
  sha256: () => Fc,
  sha384: () => Hc,
  sha512: () => Gc,
  sha512_224: () => $c,
  sha512_256: () => zc
});
var Mc, de, St, xt, Et, Uo, Oc, Nc, pe, fe, Be, Tt, kt, Uc, Lc, At, Ct, Fc, Bc, Gc, Hc, zc, $c, Fo = A(() => {
  No();
  mn();
  Rn();
  Mc = /* @__PURE__ */ Uint32Array.from([
    1116352408,
    1899447441,
    3049323471,
    3921009573,
    961987163,
    1508970993,
    2453635748,
    2870763221,
    3624381080,
    310598401,
    607225278,
    1426881987,
    1925078388,
    2162078206,
    2614888103,
    3248222580,
    3835390401,
    4022224774,
    264347078,
    604807628,
    770255983,
    1249150122,
    1555081692,
    1996064986,
    2554220882,
    2821834349,
    2952996808,
    3210313671,
    3336571891,
    3584528711,
    113926993,
    338241895,
    666307205,
    773529912,
    1294757372,
    1396182291,
    1695183700,
    1986661051,
    2177026350,
    2456956037,
    2730485921,
    2820302411,
    3259730800,
    3345764771,
    3516065817,
    3600352804,
    4094571909,
    275423344,
    430227734,
    506948616,
    659060556,
    883997877,
    958139571,
    1322822218,
    1537002063,
    1747873779,
    1955562222,
    2024104815,
    2227730452,
    2361852424,
    2428436474,
    2756734187,
    3204031479,
    3329325298
  ]), de = /* @__PURE__ */ new Uint32Array(64), St = class extends Ze {
    // We cannot use array here since array allows indexing by variable
    // which means optimizer/compiler cannot use registers.
    // Numeric initializers matter: starting the fields as `undefined` changes
    // V8's field representation and makes sha256 3x slower (measured).
    A = 0;
    B = 0;
    C = 0;
    D = 0;
    E = 0;
    F = 0;
    G = 0;
    H = 0;
    constructor(t, n) {
      super(64, t, 8, !1), this.A = n[0] | 0, this.B = n[1] | 0, this.C = n[2] | 0, this.D = n[3] | 0, this.E = n[4] | 0, this.F = n[5] | 0, this.G = n[6] | 0, this.H = n[7] | 0;
    }
    get() {
      let { A: t, B: n, C: o, D: r, E: i, F: s, G: c, H: u } = this;
      return [t, n, o, r, i, s, c, u];
    }
    // prettier-ignore
    set(t, n, o, r, i, s, c, u) {
      this.A = t | 0, this.B = n | 0, this.C = o | 0, this.D = r | 0, this.E = i | 0, this.F = s | 0, this.G = c | 0, this.H = u | 0;
    }
    _cloneInto(t) {
      return (t ||= new this.constructor()).set(...this.get()), this._cloneIntoMeta(t);
    }
    process(t, n) {
      for (let f = 0; f < 16; f++, n += 4)
        de[f] = t.getUint32(n, !1);
      for (let f = 16; f < 64; f++) {
        let m = de[f - 15], l = de[f - 2], d = Q(m, 7) ^ Q(m, 18) ^ m >>> 3, y = Q(l, 17) ^ Q(l, 19) ^ l >>> 10;
        de[f] = y + de[f - 7] + d + de[f - 16] | 0;
      }
      let { A: o, B: r, C: i, D: s, E: c, F: u, G: p, H: g } = this;
      for (let f = 0; f < 64; f++) {
        let m = Q(c, 6) ^ Q(c, 11) ^ Q(c, 25), l = g + m + vo(c, u, p) + Mc[f] + de[f] | 0, y = (Q(o, 2) ^ Q(o, 13) ^ Q(o, 22)) + Io(o, r, i) | 0;
        g = p, p = u, u = c, c = s + l | 0, s = i, i = r, r = o, o = l + y | 0;
      }
      o = o + this.A | 0, r = r + this.B | 0, i = i + this.C | 0, s = s + this.D | 0, c = c + this.E | 0, u = u + this.F | 0, p = p + this.G | 0, g = g + this.H | 0, this.set(o, r, i, s, c, u, p, g);
    }
    roundClean() {
      Ye(de);
    }
    destroy() {
      this.destroyed = !0, this.set(0, 0, 0, 0, 0, 0, 0, 0), Ye(this.buffer);
    }
  }, xt = class extends St {
    constructor() {
      super(32, Po);
    }
  }, Et = class extends St {
    constructor() {
      super(28, Do);
    }
  }, Uo = bo([
    "0x428a2f98d728ae22",
    "0x7137449123ef65cd",
    "0xb5c0fbcfec4d3b2f",
    "0xe9b5dba58189dbbc",
    "0x3956c25bf348b538",
    "0x59f111f1b605d019",
    "0x923f82a4af194f9b",
    "0xab1c5ed5da6d8118",
    "0xd807aa98a3030242",
    "0x12835b0145706fbe",
    "0x243185be4ee4b28c",
    "0x550c7dc3d5ffb4e2",
    "0x72be5d74f27b896f",
    "0x80deb1fe3b1696b1",
    "0x9bdc06a725c71235",
    "0xc19bf174cf692694",
    "0xe49b69c19ef14ad2",
    "0xefbe4786384f25e3",
    "0x0fc19dc68b8cd5b5",
    "0x240ca1cc77ac9c65",
    "0x2de92c6f592b0275",
    "0x4a7484aa6ea6e483",
    "0x5cb0a9dcbd41fbd4",
    "0x76f988da831153b5",
    "0x983e5152ee66dfab",
    "0xa831c66d2db43210",
    "0xb00327c898fb213f",
    "0xbf597fc7beef0ee4",
    "0xc6e00bf33da88fc2",
    "0xd5a79147930aa725",
    "0x06ca6351e003826f",
    "0x142929670a0e6e70",
    "0x27b70a8546d22ffc",
    "0x2e1b21385c26c926",
    "0x4d2c6dfc5ac42aed",
    "0x53380d139d95b3df",
    "0x650a73548baf63de",
    "0x766a0abb3c77b2a8",
    "0x81c2c92e47edaee6",
    "0x92722c851482353b",
    "0xa2bfe8a14cf10364",
    "0xa81a664bbc423001",
    "0xc24b8b70d0f89791",
    "0xc76c51a30654be30",
    "0xd192e819d6ef5218",
    "0xd69906245565a910",
    "0xf40e35855771202a",
    "0x106aa07032bbd1b8",
    "0x19a4c116b8d2d0c8",
    "0x1e376c085141ab53",
    "0x2748774cdf8eeb99",
    "0x34b0bcb5e19b48a8",
    "0x391c0cb3c5c95a63",
    "0x4ed8aa4ae3418acb",
    "0x5b9cca4f7763e373",
    "0x682e6ff3d6b2b8a3",
    "0x748f82ee5defb2fc",
    "0x78a5636f43172f60",
    "0x84c87814a1f0ab72",
    "0x8cc702081a6439ec",
    "0x90befffa23631e28",
    "0xa4506cebde82bde9",
    "0xbef9a3f7b2c67915",
    "0xc67178f2e372532b",
    "0xca273eceea26619c",
    "0xd186b8c721c0c207",
    "0xeada7dd6cde0eb1e",
    "0xf57d4f7fee6ed178",
    "0x06f067aa72176fba",
    "0x0a637dc5a2c898a6",
    "0x113f9804bef90dae",
    "0x1b710b35131c471b",
    "0x28db77f523047d84",
    "0x32caab7b40c72493",
    "0x3c9ebe0a15c9bebc",
    "0x431d67c49c100d4c",
    "0x4cc5d4becb3e42b6",
    "0x597f299cfc657e2a",
    "0x5fcb6fab3ad6faec",
    "0x6c44198c4a475817"
  ].map((e) => BigInt(e))), Oc = Uo[0], Nc = Uo[1], pe = /* @__PURE__ */ new Uint32Array(80), fe = /* @__PURE__ */ new Uint32Array(80), Be = class extends Ze {
    // We cannot use array here since array allows indexing by variable
    // which means optimizer/compiler cannot use registers.
    // h -- high 32 bits, l -- low 32 bits
    // Numeric initializers matter: starting the fields as `undefined` changes
    // V8's field representation and slows hashing down (measured on sha256).
    Ah = 0;
    Al = 0;
    Bh = 0;
    Bl = 0;
    Ch = 0;
    Cl = 0;
    Dh = 0;
    Dl = 0;
    Eh = 0;
    El = 0;
    Fh = 0;
    Fl = 0;
    Gh = 0;
    Gl = 0;
    Hh = 0;
    Hl = 0;
    constructor(t, n) {
      super(128, t, 16, !1), this.Ah = n[0] | 0, this.Al = n[1] | 0, this.Bh = n[2] | 0, this.Bl = n[3] | 0, this.Ch = n[4] | 0, this.Cl = n[5] | 0, this.Dh = n[6] | 0, this.Dl = n[7] | 0, this.Eh = n[8] | 0, this.El = n[9] | 0, this.Fh = n[10] | 0, this.Fl = n[11] | 0, this.Gh = n[12] | 0, this.Gl = n[13] | 0, this.Hh = n[14] | 0, this.Hl = n[15] | 0;
    }
    // prettier-ignore
    get() {
      let { Ah: t, Al: n, Bh: o, Bl: r, Ch: i, Cl: s, Dh: c, Dl: u, Eh: p, El: g, Fh: f, Fl: m, Gh: l, Gl: d, Hh: y, Hl: h } = this;
      return [t, n, o, r, i, s, c, u, p, g, f, m, l, d, y, h];
    }
    // prettier-ignore
    set(t, n, o, r, i, s, c, u, p, g, f, m, l, d, y, h) {
      this.Ah = t | 0, this.Al = n | 0, this.Bh = o | 0, this.Bl = r | 0, this.Ch = i | 0, this.Cl = s | 0, this.Dh = c | 0, this.Dl = u | 0, this.Eh = p | 0, this.El = g | 0, this.Fh = f | 0, this.Fl = m | 0, this.Gh = l | 0, this.Gl = d | 0, this.Hh = y | 0, this.Hl = h | 0;
    }
    _cloneInto(t) {
      return (t ||= new this.constructor()).set(...this.get()), this._cloneIntoMeta(t);
    }
    process(t, n) {
      for (let R = 0; R < 16; R++, n += 4)
        pe[R] = t.getUint32(n), fe[R] = t.getUint32(n += 4);
      for (let R = 16; R < 80; R++) {
        let S = pe[R - 15] | 0, x = fe[R - 15] | 0, E = Ae(S, x, 1) ^ Ae(S, x, 8) ^ hn(S, x, 7), P = Ce(S, x, 1) ^ Ce(S, x, 8) ^ gn(S, x, 7), _ = pe[R - 2] | 0, C = fe[R - 2] | 0, O = Ae(_, C, 19) ^ Ke(_, C, 61) ^ hn(_, C, 6), I = Ce(_, C, 19) ^ Ve(_, C, 61) ^ gn(_, C, 6), v = xo(P, I, fe[R - 7], fe[R - 16]), z = Eo(v, E, O, pe[R - 7], pe[R - 16]);
        pe[R] = z | 0, fe[R] = v | 0;
      }
      let { Ah: o, Al: r, Bh: i, Bl: s, Ch: c, Cl: u, Dh: p, Dl: g, Eh: f, El: m, Fh: l, Fl: d, Gh: y, Gl: h, Hh: b, Hl: w } = this;
      for (let R = 0; R < 80; R++) {
        let S = Ae(f, m, 14) ^ Ae(f, m, 18) ^ Ke(f, m, 41), x = Ce(f, m, 14) ^ Ce(f, m, 18) ^ Ve(f, m, 41), E = f & l ^ ~f & y, P = m & d ^ ~m & h, _ = To(w, x, P, Nc[R], fe[R]), C = ko(_, b, S, E, Oc[R], pe[R]), O = _ | 0, I = Ae(o, r, 28) ^ Ke(o, r, 34) ^ Ke(o, r, 39), v = Ce(o, r, 28) ^ Ve(o, r, 34) ^ Ve(o, r, 39), z = o & i ^ o & c ^ i & c, V = r & s ^ r & u ^ s & u;
        b = y | 0, w = h | 0, y = l | 0, h = d | 0, l = f | 0, d = m | 0, { h: f, l: m } = ne(p | 0, g | 0, C | 0, O | 0), p = c | 0, g = u | 0, c = i | 0, u = s | 0, i = o | 0, s = r | 0;
        let j = Ro(O, v, V);
        o = So(j, C, I, z), r = j | 0;
      }
      ({ h: o, l: r } = ne(this.Ah | 0, this.Al | 0, o | 0, r | 0)), { h: i, l: s } = ne(this.Bh | 0, this.Bl | 0, i | 0, s | 0), { h: c, l: u } = ne(this.Ch | 0, this.Cl | 0, c | 0, u | 0), { h: p, l: g } = ne(this.Dh | 0, this.Dl | 0, p | 0, g | 0), { h: f, l: m } = ne(this.Eh | 0, this.El | 0, f | 0, m | 0), { h: l, l: d } = ne(this.Fh | 0, this.Fl | 0, l | 0, d | 0), { h: y, l: h } = ne(this.Gh | 0, this.Gl | 0, y | 0, h | 0), { h: b, l: w } = ne(this.Hh | 0, this.Hl | 0, b | 0, w | 0), this.set(o, r, i, s, c, u, p, g, f, m, l, d, y, h, b, w);
    }
    roundClean() {
      Ye(pe, fe);
    }
    destroy() {
      this.destroyed = !0, Ye(this.buffer), this.set(0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0);
    }
  }, Tt = class extends Be {
    constructor() {
      super(64, Oo);
    }
  }, kt = class extends Be {
    constructor() {
      super(48, Mo);
    }
  }, Uc = /* @__PURE__ */ Uint32Array.from([
    2352822216,
    424955298,
    1944164710,
    2312950998,
    502970286,
    855612546,
    1738396948,
    1479516111,
    258812777,
    2077511080,
    2011393907,
    79989058,
    1067287976,
    1780299464,
    286451373,
    2446758561
  ]), Lc = /* @__PURE__ */ Uint32Array.from([
    573645204,
    4230739756,
    2673172387,
    3360449730,
    596883563,
    1867755857,
    2520282905,
    1497426621,
    2519219938,
    2827943907,
    3193839141,
    1401305490,
    721525244,
    746961066,
    246885852,
    2177182882
  ]), At = class extends Be {
    constructor() {
      super(28, Uc);
    }
  }, Ct = class extends Be {
    constructor() {
      super(32, Lc);
    }
  }, Fc = /* @__PURE__ */ _e(
    () => new xt(),
    /* @__PURE__ */ ve(1)
  ), Bc = /* @__PURE__ */ _e(
    () => new Et(),
    /* @__PURE__ */ ve(4)
  ), Gc = /* @__PURE__ */ _e(
    () => new Tt(),
    /* @__PURE__ */ ve(3)
  ), Hc = /* @__PURE__ */ _e(
    () => new kt(),
    /* @__PURE__ */ ve(2)
  ), zc = /* @__PURE__ */ _e(
    () => new Ct(),
    /* @__PURE__ */ ve(6)
  ), $c = /* @__PURE__ */ _e(
    () => new At(),
    /* @__PURE__ */ ve(5)
  );
});

// openclaw/ui/src/lib/nodes/index.ts
var jc, Bo, Sn = A(() => {
  po();
  N();
  ho();
  fn();
  go();
  mo();
  jc = () => Promise.resolve().then(() => (Fo(), Lo)), Bo = pn.sha512Async;
  pn.sha512Async = async (e) => globalThis.crypto?.subtle && Bo ? await Bo(e) : Uint8Array.from((await jc()).sha512(e));
});

// openclaw/node_modules/.pnpm/punycode.js@2.3.1/node_modules/punycode.js/punycode.js
var Gi = Jn((Yw, Bi) => {
  "use strict";
  var Vl = /^xn--/, Yl = /[^\0-\x7F]/, Zl = /[\x2E\u3002\uFF0E\uFF61]/g, Jl = {
    overflow: "Overflow: input needs wider integers to process",
    "not-basic": "Illegal input >= 0x80 (not a basic code point)",
    "invalid-input": "Invalid input"
  }, Nn = 35, re = Math.floor, Un = String.fromCharCode;
  function ge(e) {
    throw new RangeError(Jl[e]);
  }
  function Xl(e, t) {
    let n = [], o = e.length;
    for (; o--; )
      n[o] = t(e[o]);
    return n;
  }
  function Oi(e, t) {
    let n = e.split("@"), o = "";
    n.length > 1 && (o = n[0] + "@", e = n[1]), e = e.replace(Zl, ".");
    let r = e.split("."), i = Xl(r, t).join(".");
    return o + i;
  }
  function Ni(e) {
    let t = [], n = 0, o = e.length;
    for (; n < o; ) {
      let r = e.charCodeAt(n++);
      if (r >= 55296 && r <= 56319 && n < o) {
        let i = e.charCodeAt(n++);
        (i & 64512) == 56320 ? t.push(((r & 1023) << 10) + (i & 1023) + 65536) : (t.push(r), n--);
      } else
        t.push(r);
    }
    return t;
  }
  var Ql = (e) => String.fromCodePoint(...e), eu = function(e) {
    return e >= 48 && e < 58 ? 26 + (e - 48) : e >= 65 && e < 91 ? e - 65 : e >= 97 && e < 123 ? e - 97 : 36;
  }, Mi = function(e, t) {
    return e + 22 + 75 * (e < 26) - ((t != 0) << 5);
  }, Ui = function(e, t, n) {
    let o = 0;
    for (e = n ? re(e / 700) : e >> 1, e += re(e / t); e > Nn * 26 >> 1; o += 36)
      e = re(e / Nn);
    return re(o + (Nn + 1) * e / (e + 38));
  }, Li = function(e) {
    let t = [], n = e.length, o = 0, r = 128, i = 72, s = e.lastIndexOf("-");
    s < 0 && (s = 0);
    for (let c = 0; c < s; ++c)
      e.charCodeAt(c) >= 128 && ge("not-basic"), t.push(e.charCodeAt(c));
    for (let c = s > 0 ? s + 1 : 0; c < n; ) {
      let u = o;
      for (let g = 1, f = 36; ; f += 36) {
        c >= n && ge("invalid-input");
        let m = eu(e.charCodeAt(c++));
        m >= 36 && ge("invalid-input"), m > re((2147483647 - o) / g) && ge("overflow"), o += m * g;
        let l = f <= i ? 1 : f >= i + 26 ? 26 : f - i;
        if (m < l)
          break;
        let d = 36 - l;
        g > re(2147483647 / d) && ge("overflow"), g *= d;
      }
      let p = t.length + 1;
      i = Ui(o - u, p, u == 0), re(o / p) > 2147483647 - r && ge("overflow"), r += re(o / p), o %= p, t.splice(o++, 0, r);
    }
    return String.fromCodePoint(...t);
  }, Fi = function(e) {
    let t = [];
    e = Ni(e);
    let n = e.length, o = 128, r = 0, i = 72;
    for (let u of e)
      u < 128 && t.push(Un(u));
    let s = t.length, c = s;
    for (s && t.push("-"); c < n; ) {
      let u = 2147483647;
      for (let g of e)
        g >= o && g < u && (u = g);
      let p = c + 1;
      u - o > re((2147483647 - r) / p) && ge("overflow"), r += (u - o) * p, o = u;
      for (let g of e)
        if (g < o && ++r > 2147483647 && ge("overflow"), g === o) {
          let f = r;
          for (let m = 36; ; m += 36) {
            let l = m <= i ? 1 : m >= i + 26 ? 26 : m - i;
            if (f < l)
              break;
            let d = f - l, y = 36 - l;
            t.push(
              Un(Mi(l + d % y, 0))
            ), f = re(d / y);
          }
          t.push(Un(Mi(f, 0))), i = Ui(r, p, c === s), r = 0, ++c;
        }
      ++r, ++o;
    }
    return t.join("");
  }, tu = function(e) {
    return Oi(e, function(t) {
      return Vl.test(t) ? Li(t.slice(4).toLowerCase()) : t;
    });
  }, nu = function(e) {
    return Oi(e, function(t) {
      return Yl.test(t) ? "xn--" + Fi(t) : t;
    });
  }, ru = {
    /**
     * A string representing the current Punycode.js version number.
     * @memberOf punycode
     * @type String
     */
    version: "2.3.1",
    /**
     * An object of methods to convert from JavaScript's internal character
     * representation (UCS-2) to Unicode code points, and back.
     * @see <https://mathiasbynens.be/notes/javascript-encoding>
     * @memberOf punycode
     * @type Object
     */
    ucs2: {
      decode: Ni,
      encode: Ql
    },
    decode: Li,
    encode: Fi,
    toASCII: nu,
    toUnicode: tu
  };
  Bi.exports = ru;
});

// openclaw/node_modules/.pnpm/ipaddr.js@2.5.0/node_modules/ipaddr.js/lib/ipaddr.js
var ms = Jn((gs, $t) => {
  (function(e) {
    "use strict";
    let t = "(0?\\d+|0x[a-f0-9]+)", n = {
      fourOctet: new RegExp(`^${t}\\.${t}\\.${t}\\.${t}$`, "i"),
      threeOctet: new RegExp(`^${t}\\.${t}\\.${t}$`, "i"),
      twoOctet: new RegExp(`^${t}\\.${t}$`, "i"),
      longValue: new RegExp(`^${t}$`, "i")
    }, o = new RegExp("^0[0-7]+$", "i"), r = new RegExp("^0x[a-f0-9]+$", "i"), i = "%[0-9a-z]{1,}", s = "(?:[0-9a-f]+::?)+", c = {
      zoneIndex: new RegExp(i, "i"),
      native: new RegExp(`^(::)?(${s})?([0-9a-f]+)?(::)?(${i})?$`, "i"),
      deprecatedTransitional: new RegExp(`^(?:::)(${t}\\.${t}\\.${t}\\.${t}(${i})?)$`, "i"),
      transitional: new RegExp(`^((?:${s})|(?:::)(?:${s})?)${t}\\.${t}\\.${t}\\.${t}(${i})?$`, "i")
    };
    function u(l, d) {
      if (l.indexOf("::") !== l.lastIndexOf("::"))
        return null;
      let y = 0, h = -1, b = (l.match(c.zoneIndex) || [])[0], w, R;
      for (b && (b = b.substring(1), l = l.replace(/%.+$/, "")); (h = l.indexOf(":", h + 1)) >= 0; )
        y++;
      if (l.substr(0, 2) === "::" && y--, l.substr(-2, 2) === "::" && y--, y >= d)
        return null;
      for (R = d - y, w = ":"; R--; )
        w += "0:";
      return l = l.replace("::", w), l[0] === ":" && (l = l.slice(1)), l[l.length - 1] === ":" && (l = l.slice(0, -1)), d = (function() {
        let S = l.split(":"), x = [];
        for (let E = 0; E < S.length; E++)
          x.push(S[E].length > 4 ? NaN : parseInt(S[E], 16));
        return x;
      })(), {
        parts: d,
        zoneId: b
      };
    }
    function p(l, d, y, h) {
      if (l.length !== d.length)
        throw new Error("ipaddr: cannot match CIDR for objects with different lengths");
      let b = 0, w;
      for (; h > 0; ) {
        if (w = y - h, w < 0 && (w = 0), l[b] >> w !== d[b] >> w)
          return !1;
        h -= y, b += 1;
      }
      return !0;
    }
    function g(l) {
      if (r.test(l))
        return parseInt(l, 16);
      if (l[0] === "0" && !isNaN(parseInt(l[1], 10))) {
        if (o.test(l))
          return parseInt(l, 8);
        throw new Error(`ipaddr: cannot parse ${l} as octal`);
      }
      return parseInt(l, 10);
    }
    function f(l, d) {
      for (; l.length < d; )
        l = `0${l}`;
      return l;
    }
    let m = {};
    m.IPv4 = (function() {
      function l(d) {
        if (d.length !== 4)
          throw new Error("ipaddr: ipv4 octet count should be 4");
        let y, h;
        for (y = 0; y < d.length; y++)
          if (h = d[y], !(0 <= h && h <= 255))
            throw new Error("ipaddr: ipv4 octet should fit in 8 bits");
        this.octets = d;
      }
      return l.prototype.SpecialRanges = {
        unspecified: [[new l([0, 0, 0, 0]), 8]],
        broadcast: [[new l([255, 255, 255, 255]), 32]],
        // RFC3171
        multicast: [[new l([224, 0, 0, 0]), 4]],
        // RFC3927
        linkLocal: [[new l([169, 254, 0, 0]), 16]],
        // RFC5735
        loopback: [[new l([127, 0, 0, 0]), 8]],
        // RFC6598
        carrierGradeNat: [[new l([100, 64, 0, 0]), 10]],
        // RFC1918
        private: [
          [new l([10, 0, 0, 0]), 8],
          [new l([172, 16, 0, 0]), 12],
          [new l([192, 168, 0, 0]), 16]
        ],
        // Reserved and testing-only ranges; RFCs 5735, 5737, 2544, 1700
        reserved: [
          [new l([192, 0, 0, 0]), 24],
          [new l([192, 0, 2, 0]), 24],
          [new l([192, 88, 99, 0]), 24],
          [new l([198, 18, 0, 0]), 15],
          [new l([198, 51, 100, 0]), 24],
          [new l([203, 0, 113, 0]), 24],
          [new l([240, 0, 0, 0]), 4]
        ],
        // RFC7534, RFC7535
        as112: [
          [new l([192, 175, 48, 0]), 24],
          [new l([192, 31, 196, 0]), 24]
        ],
        // RFC7450
        amt: [
          [new l([192, 52, 193, 0]), 24]
        ]
      }, l.prototype.kind = function() {
        return "ipv4";
      }, l.prototype.match = function(d, y) {
        let h;
        if (y === void 0 && (h = d, d = h[0], y = h[1]), d.kind() !== "ipv4")
          throw new Error("ipaddr: cannot match ipv4 address with non-ipv4 one");
        return p(this.octets, d.octets, 8, y);
      }, l.prototype.prefixLengthFromSubnetMask = function() {
        let d = 0, y = !1, h = {
          0: 8,
          128: 7,
          192: 6,
          224: 5,
          240: 4,
          248: 3,
          252: 2,
          254: 1,
          255: 0
        }, b, w, R;
        for (b = 3; b >= 0; b -= 1)
          if (w = this.octets[b], w in h) {
            if (R = h[w], y && R !== 0)
              return null;
            R !== 8 && (y = !0), d += R;
          } else
            return null;
        return 32 - d;
      }, l.prototype.range = function() {
        return m.subnetMatch(this, this.SpecialRanges);
      }, l.prototype.toByteArray = function() {
        return this.octets.slice(0);
      }, l.prototype.toIPv4MappedAddress = function() {
        return m.IPv6.parse(`::ffff:${this.toString()}`);
      }, l.prototype.toNormalizedString = function() {
        return this.toString();
      }, l.prototype.toString = function() {
        return this.octets.join(".");
      }, l;
    })(), m.IPv4.broadcastAddressFromCIDR = function(l) {
      try {
        let d = this.parseCIDR(l), y = d[0].toByteArray(), h = this.subnetMaskFromPrefixLength(d[1]).toByteArray(), b = [], w = 0;
        for (; w < 4; )
          b.push(parseInt(y[w], 10) | parseInt(h[w], 10) ^ 255), w++;
        return new this(b);
      } catch (d) {
        throw new Error("ipaddr: the address does not have IPv4 CIDR format", { cause: d });
      }
    }, m.IPv4.isIPv4 = function(l) {
      return this.parser(l) !== null;
    }, m.IPv4.isValid = function(l) {
      try {
        return new this(this.parser(l)), !0;
      } catch {
        return !1;
      }
    }, m.IPv4.isValidCIDR = function(l) {
      try {
        return this.parseCIDR(l), !0;
      } catch {
        return !1;
      }
    }, m.IPv4.isValidFourPartDecimal = function(l) {
      return !!(m.IPv4.isValid(l) && l.match(/^(0|[1-9]\d*)(\.(0|[1-9]\d*)){3}$/));
    }, m.IPv4.isValidCIDRFourPartDecimal = function(l) {
      let d = l.match(/^(.+)\/(\d+)$/);
      return !m.IPv4.isValidCIDR(l) || !d ? !1 : m.IPv4.isValidFourPartDecimal(d[1]);
    }, m.IPv4.networkAddressFromCIDR = function(l) {
      let d, y, h, b, w;
      try {
        for (d = this.parseCIDR(l), h = d[0].toByteArray(), w = this.subnetMaskFromPrefixLength(d[1]).toByteArray(), b = [], y = 0; y < 4; )
          b.push(parseInt(h[y], 10) & parseInt(w[y], 10)), y++;
        return new this(b);
      } catch (R) {
        throw new Error("ipaddr: the address does not have IPv4 CIDR format", { cause: R });
      }
    }, m.IPv4.parse = function(l) {
      let d = this.parser(l);
      if (d === null)
        throw new Error("ipaddr: string is not formatted like an IPv4 Address");
      return new this(d);
    }, m.IPv4.parseCIDR = function(l) {
      let d;
      if (d = l.match(/^(.+)\/(\d+)$/)) {
        let y = parseInt(d[2]);
        if (y >= 0 && y <= 32) {
          let h = [this.parse(d[1]), y];
          return Object.defineProperty(h, "toString", {
            value: function() {
              return this.join("/");
            }
          }), h;
        }
      }
      throw new Error("ipaddr: string is not formatted like an IPv4 CIDR range");
    }, m.IPv4.parser = function(l) {
      let d, y, h;
      if (d = l.match(n.fourOctet))
        return (function() {
          let b = d.slice(1, 6), w = [];
          for (let R = 0; R < b.length; R++)
            y = b[R], w.push(g(y));
          return w;
        })();
      if (d = l.match(n.longValue)) {
        if (h = g(d[1]), h > 4294967295 || h < 0)
          throw new Error("ipaddr: address outside defined range");
        return (function() {
          let b = [], w;
          for (w = 0; w <= 24; w += 8)
            b.push(h >> w & 255);
          return b;
        })().reverse();
      } else return (d = l.match(n.twoOctet)) ? (function() {
        let b = d.slice(1, 4), w = [];
        if (h = g(b[1]), h > 16777215 || h < 0)
          throw new Error("ipaddr: address outside defined range");
        return w.push(g(b[0])), w.push(h >> 16 & 255), w.push(h >> 8 & 255), w.push(h & 255), w;
      })() : (d = l.match(n.threeOctet)) ? (function() {
        let b = d.slice(1, 5), w = [];
        if (h = g(b[2]), h > 65535 || h < 0)
          throw new Error("ipaddr: address outside defined range");
        return w.push(g(b[0])), w.push(g(b[1])), w.push(h >> 8 & 255), w.push(h & 255), w;
      })() : null;
    }, m.IPv4.subnetMaskFromPrefixLength = function(l) {
      if (l = parseInt(l), Number.isNaN(l) || l < 0 || l > 32)
        throw new Error("ipaddr: invalid IPv4 prefix length");
      let d = [0, 0, 0, 0], y = 0, h = Math.floor(l / 8);
      for (; y < h; )
        d[y] = 255, y++;
      return h < 4 && (d[h] = Math.pow(2, l % 8) - 1 << 8 - l % 8), new this(d);
    }, m.IPv6 = (function() {
      function l(d, y) {
        let h, b;
        if (d.length === 16)
          for (this.parts = [], h = 0; h <= 14; h += 2)
            this.parts.push(d[h] << 8 | d[h + 1]);
        else if (d.length === 8)
          this.parts = d;
        else
          throw new Error("ipaddr: ipv6 part count should be 8 or 16");
        for (h = 0; h < this.parts.length; h++)
          if (b = this.parts[h], !(0 <= b && b <= 65535))
            throw new Error("ipaddr: ipv6 part should fit in 16 bits");
        y && (this.zoneId = y);
      }
      return l.prototype.SpecialRanges = {
        // RFC4291, here and after
        unspecified: [new l([0, 0, 0, 0, 0, 0, 0, 0]), 128],
        linkLocal: [new l([65152, 0, 0, 0, 0, 0, 0, 0]), 10],
        multicast: [new l([65280, 0, 0, 0, 0, 0, 0, 0]), 8],
        loopback: [new l([0, 0, 0, 0, 0, 0, 0, 1]), 128],
        uniqueLocal: [new l([64512, 0, 0, 0, 0, 0, 0, 0]), 7],
        ipv4Mapped: [new l([0, 0, 0, 0, 0, 65535, 0, 0]), 96],
        // RFC3879
        deprecatedSiteLocal: [new l([65216, 0, 0, 0, 0, 0, 0, 0]), 10],
        // RFC6666
        discard: [new l([256, 0, 0, 0, 0, 0, 0, 0]), 64],
        // RFC6145
        rfc6145: [new l([0, 0, 0, 0, 65535, 0, 0, 0]), 96],
        rfc6052: [
          // RFC6052
          [new l([100, 65435, 0, 0, 0, 0, 0, 0]), 96],
          // RFC8215
          [new l([100, 65435, 1, 0, 0, 0, 0, 0]), 48]
        ],
        // RFC3056
        "6to4": [new l([8194, 0, 0, 0, 0, 0, 0, 0]), 16],
        // RFC6052, RFC6146
        teredo: [new l([8193, 0, 0, 0, 0, 0, 0, 0]), 32],
        // RFC5180
        benchmarking: [new l([8193, 2, 0, 0, 0, 0, 0, 0]), 48],
        // RFC7450
        amt: [new l([8193, 3, 0, 0, 0, 0, 0, 0]), 32],
        as112v6: [
          // RFC7535
          [new l([8193, 4, 274, 0, 0, 0, 0, 0]), 48],
          // RFC7534
          [new l([9760, 79, 32768, 0, 0, 0, 0, 0]), 48]
        ],
        // RFC4843
        deprecatedOrchid: [new l([8193, 16, 0, 0, 0, 0, 0, 0]), 28],
        // RFC7343
        orchid2: [new l([8193, 32, 0, 0, 0, 0, 0, 0]), 28],
        // RFC9374
        droneRemoteIdProtocolEntityTags: [new l([8193, 48, 0, 0, 0, 0, 0, 0]), 28],
        // RFC9602
        segmentRouting: [new l([24320, 0, 0, 0, 0, 0, 0, 0]), 16],
        reserved: [
          // RFC3849
          [new l([8193, 0, 0, 0, 0, 0, 0, 0]), 23],
          // RFC2928
          [new l([8193, 3512, 0, 0, 0, 0, 0, 0]), 32],
          // RFC9637
          [new l([16383, 0, 0, 0, 0, 0, 0, 0]), 20]
        ]
      }, l.prototype.isIPv4MappedAddress = function() {
        return this.range() === "ipv4Mapped";
      }, l.prototype.kind = function() {
        return "ipv6";
      }, l.prototype.match = function(d, y) {
        let h;
        if (y === void 0 && (h = d, d = h[0], y = h[1]), d.kind() !== "ipv6")
          throw new Error("ipaddr: cannot match ipv6 address with non-ipv6 one");
        return p(this.parts, d.parts, 16, y);
      }, l.prototype.prefixLengthFromSubnetMask = function() {
        let d = 0, y = !1, h = {
          0: 16,
          32768: 15,
          49152: 14,
          57344: 13,
          61440: 12,
          63488: 11,
          64512: 10,
          65024: 9,
          65280: 8,
          65408: 7,
          65472: 6,
          65504: 5,
          65520: 4,
          65528: 3,
          65532: 2,
          65534: 1,
          65535: 0
        }, b, w;
        for (let R = 7; R >= 0; R -= 1)
          if (b = this.parts[R], b in h) {
            if (w = h[b], y && w !== 0)
              return null;
            w !== 16 && (y = !0), d += w;
          } else
            return null;
        return 128 - d;
      }, l.prototype.range = function() {
        return m.subnetMatch(this, this.SpecialRanges);
      }, l.prototype.toByteArray = function() {
        let d, y = [], h = this.parts;
        for (let b = 0; b < h.length; b++)
          d = h[b], y.push(d >> 8), y.push(d & 255);
        return y;
      }, l.prototype.toFixedLengthString = function() {
        let d = (function() {
          let h = [];
          for (let b = 0; b < this.parts.length; b++)
            h.push(f(this.parts[b].toString(16), 4));
          return h;
        }).call(this).join(":"), y = "";
        return this.zoneId && (y = `%${this.zoneId}`), d + y;
      }, l.prototype.toIPv4Address = function() {
        if (!this.isIPv4MappedAddress())
          throw new Error("ipaddr: trying to convert a generic ipv6 address to ipv4");
        let d = this.parts.slice(-2), y = d[0], h = d[1];
        return new m.IPv4([y >> 8, y & 255, h >> 8, h & 255]);
      }, l.prototype.toNormalizedString = function() {
        let d = (function() {
          let h = [];
          for (let b = 0; b < this.parts.length; b++)
            h.push(this.parts[b].toString(16));
          return h;
        }).call(this).join(":"), y = "";
        return this.zoneId && (y = `%${this.zoneId}`), d + y;
      }, l.prototype.toRFC5952String = function() {
        let d = /((^|:)(0(:|$)){2,})/g, y = "";
        this.zoneId && (y = `%${this.zoneId}`);
        let h = this.toNormalizedString(), b = h.slice(0, h.length - y.length), w = 0, R = -1, S = -1, x;
        for (; x = d.exec(b); ) {
          let E = (x[0].match(/0/g) || []).length;
          E > S && (S = E, w = x.index, R = x[0].length);
        }
        return R < 0 ? b + y : `${b.substring(0, w)}::${b.substring(w + R)}${y}`;
      }, l.prototype.toString = function() {
        return this.toRFC5952String();
      }, l;
    })(), m.IPv6.broadcastAddressFromCIDR = function(l) {
      try {
        let d = this.parseCIDR(l), y = d[0].toByteArray(), h = this.subnetMaskFromPrefixLength(d[1]).toByteArray(), b = [], w = 0;
        for (; w < 16; )
          b.push(parseInt(y[w], 10) | parseInt(h[w], 10) ^ 255), w++;
        return new this(b);
      } catch (d) {
        throw new Error("ipaddr: the address does not have IPv6 CIDR format", { cause: d });
      }
    }, m.IPv6.isIPv6 = function(l) {
      return this.parser(l) !== null;
    }, m.IPv6.isValid = function(l) {
      if (typeof l == "string" && l.indexOf(":") === -1)
        return !1;
      try {
        let d = this.parser(l);
        return new this(d.parts, d.zoneId), !0;
      } catch {
        return !1;
      }
    }, m.IPv6.isValidCIDR = function(l) {
      if (typeof l == "string" && l.indexOf(":") === -1)
        return !1;
      try {
        return this.parseCIDR(l), !0;
      } catch {
        return !1;
      }
    }, m.IPv6.networkAddressFromCIDR = function(l) {
      let d, y, h, b, w;
      try {
        for (d = this.parseCIDR(l), h = d[0].toByteArray(), w = this.subnetMaskFromPrefixLength(d[1]).toByteArray(), b = [], y = 0; y < 16; )
          b.push(parseInt(h[y], 10) & parseInt(w[y], 10)), y++;
        return new this(b);
      } catch (R) {
        throw new Error("ipaddr: the address does not have IPv6 CIDR format", { cause: R });
      }
    }, m.IPv6.parse = function(l) {
      let d = this.parser(l);
      if (d === null)
        throw new Error("ipaddr: string is not formatted like an IPv6 Address");
      return new this(d.parts, d.zoneId);
    }, m.IPv6.parseCIDR = function(l) {
      let d, y, h;
      if ((y = l.match(/^(.+)\/(\d+)$/)) && (d = parseInt(y[2]), d >= 0 && d <= 128))
        return h = [this.parse(y[1]), d], Object.defineProperty(h, "toString", {
          value: function() {
            return this.join("/");
          }
        }), h;
      throw new Error("ipaddr: string is not formatted like an IPv6 CIDR range");
    }, m.IPv6.parser = function(l) {
      let d, y, h, b, w, R;
      if (h = l.match(c.deprecatedTransitional))
        return this.parser(`::ffff:${h[1]}`);
      if (c.native.test(l))
        return u(l, 8);
      if ((h = l.match(c.transitional)) && (R = h[6] || "", d = h[1], h[1].endsWith("::") || (d = d.slice(0, -1)), d = u(d + R, 6), d && d.parts)) {
        for (w = [
          parseInt(h[2]),
          parseInt(h[3]),
          parseInt(h[4]),
          parseInt(h[5])
        ], y = 0; y < w.length; y++)
          if (b = w[y], !(0 <= b && b <= 255))
            return null;
        return d.parts.push(w[0] << 8 | w[1]), d.parts.push(w[2] << 8 | w[3]), {
          parts: d.parts,
          zoneId: d.zoneId
        };
      }
      return null;
    }, m.IPv6.subnetMaskFromPrefixLength = function(l) {
      if (l = parseInt(l), Number.isNaN(l) || l < 0 || l > 128)
        throw new Error("ipaddr: invalid IPv6 prefix length");
      let d = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], y = 0, h = Math.floor(l / 8);
      for (; y < h; )
        d[y] = 255, y++;
      return h < 16 && (d[h] = Math.pow(2, l % 8) - 1 << 8 - l % 8), new this(d);
    }, m.fromByteArray = function(l) {
      let d = l.length;
      if (d === 4)
        return new m.IPv4(l);
      if (d === 16)
        return new m.IPv6(l);
      throw new Error("ipaddr: the binary input is neither an IPv6 nor IPv4 address");
    }, m.isValid = function(l) {
      return m.IPv6.isValid(l) || m.IPv4.isValid(l);
    }, m.isValidCIDR = function(l) {
      return m.IPv6.isValidCIDR(l) || m.IPv4.isValidCIDR(l);
    }, m.parse = function(l) {
      if (m.IPv6.isValid(l))
        return m.IPv6.parse(l);
      if (m.IPv4.isValid(l))
        return m.IPv4.parse(l);
      throw new Error("ipaddr: the address has neither IPv6 nor IPv4 format");
    }, m.parseCIDR = function(l) {
      try {
        return m.IPv6.parseCIDR(l);
      } catch {
        try {
          return m.IPv4.parseCIDR(l);
        } catch (d) {
          throw new Error("ipaddr: the address has neither IPv6 nor IPv4 CIDR format", { cause: d });
        }
      }
    }, m.process = function(l) {
      let d = this.parse(l);
      return d.kind() === "ipv6" && d.isIPv4MappedAddress() ? d.toIPv4Address() : d;
    }, m.subnetMatch = function(l, d, y) {
      let h, b, w, R;
      y == null && (y = "unicast");
      for (b in d)
        if (Object.prototype.hasOwnProperty.call(d, b)) {
          for (w = d[b], w[0] && !(w[0] instanceof Array) && (w = [w]), h = 0; h < w.length; h++)
            if (R = w[h], l.kind() === R[0].kind() && l.match.apply(l, R))
              return b;
        }
      return y;
    }, typeof $t < "u" && $t.exports ? $t.exports = m : e.ipaddr = m;
  })(gs);
});

// openclaw/ui/src/lib/chat/browser-tab-preview.ts
N();

// openclaw/ui/src/components/browser/browser-client.ts
ae();
N();
B();

// openclaw/ui/src/api/gateway.ts
N();
Yt();

// openclaw/ui/src/app/native-gateway-auth.ts
N();
gt();

// openclaw/ui/src/lib/uuid.ts
Jt();

// openclaw/ui/src/api/gateway.ts
gt();
Sn();

// openclaw/ui/src/api/gateway-browser-socket.ts
gt();

// openclaw/ui/src/api/gateway-chat-events.ts
N();

// openclaw/packages/session-url-contract/src/index.ts
lt();
B();

// openclaw/packages/session-url-contract/src/grammar.ts
B();

// openclaw/packages/session-url-contract/src/session-key.ts
lt();
B();

// openclaw/packages/session-url-contract/src/focus.ts
B();

// openclaw/packages/session-url-contract/src/share.ts
var Yc = Object.freeze([
  "activity",
  "ai-agents",
  "appearance",
  "approve",
  "apps",
  "ask",
  "automation",
  "automations",
  "channels",
  "chat",
  "claws",
  "communications",
  "config",
  "cron",
  "custodian",
  "dashboard",
  "dashboards",
  "debug",
  "focus",
  "infrastructure",
  "lobsterdex",
  "logs",
  "mcp",
  "meetings",
  "memory-import",
  "model-providers",
  "model-setup",
  "new",
  "nodes",
  "plugin",
  "plugins",
  "portals",
  "profile",
  "sessions",
  "settings",
  "share",
  "skills",
  "systems",
  "terminal",
  "usage",
  "workboard",
  "worktrees"
]);

// openclaw/ui/src/api/gateway-session-row-events.ts
N();

// openclaw/src/shared/device-bootstrap-profile.ts
fn();
var _t = [
  "operator.approvals",
  "operator.questions",
  "operator.read",
  "operator.talk.secrets",
  "operator.write"
], hm = new Set(_t), xn = [
  "operator.admin",
  "operator.approvals",
  "operator.pairing",
  "operator.questions",
  "operator.read",
  "operator.talk.secrets",
  "operator.write"
], gm = new Set(
  xn
), $o = [
  "operator.admin",
  ..._t
], mm = new Set($o);
var ym = {
  // QR/setup-code bootstrap must hand off both tokens for native onboarding:
  // iOS/Android suppress the operator loop while bootstrap auth is active and
  // only start it after persisting this bounded operator token.
  roles: ["node", "operator"],
  scopes: [..._t]
}, bm = {
  roles: ["operator"],
  scopes: [...xn],
  purpose: "control-ui-owner"
}, wm = {
  roles: ["node", "operator"],
  scopes: [...$o],
  purpose: "mobile-full"
};

// openclaw/ui/src/i18n/locales/en-agents.ts
var qo = {
  menuLabel: "Agent menu",
  agents: "Agents",
  showAll: "Show all",
  createAgent: "Create new agent",
  newAgent: "New agent",
  creatingAgent: "Creating new agent\u2026",
  namedSettings: "{name} settings",
  newConversation: "New conversation",
  workspaceMenuLabel: "Workspace menu",
  switchAgent: "Switch agent",
  working: "Working\u2026",
  ready: "Ready to chat",
  help: "Help",
  getHelp: "Get help",
  getApps: "Get the apps",
  discord: "Discord community",
  viewChangelog: "View changelog"
}, Wo = {
  label: "Agent",
  allAgents: "All agents"
}, jo = {
  pinToSwitcher: "Pin to switcher",
  unpinFromSwitcher: "Unpin from switcher"
};

// openclaw/ui/src/i18n/locales/en.ts
var Je = {
  pluginUi: {
    sessionRecentMessages: "Recent messages",
    sessionHistoryUnavailable: "Session history could not be loaded. Try again.",
    sessionHistoryEmpty: "No recent messages.",
    customize: "Customize UI",
    selectionScope: "Choose views for this browser window. Built-in views are always available.",
    builtin: "Built-in view",
    retryView: "Retry plugin view",
    reload: "Reload plugin UI",
    dashboardTitle: "Session dashboard",
    dashboardEmpty: "This session has no dashboard widgets yet.",
    customPluginsDisabled: "Custom plugin UI is off",
    customPluginsEnableHint: "Enable Custom plugin UI in Labs.",
    openLabs: "Open Labs",
    surface: {
      "session-list": "Session list",
      composer: "Composer",
      workspace: "Workspace",
      transcript: "Transcript",
      "tool-result": "Tool results"
    }
  },
  capacityMeter: {
    workerSlots: "{used} of {total} slots busy",
    unavailable: "Slot utilization unavailable",
    execHost: "Codex exec"
  },
  agentsHome: {},
  outputs: {
    viewAll: "View all",
    dashboard: "Dashboard",
    files: "Files",
    loading: "Loading outputs\u2026",
    updating: "Updating outputs\u2026",
    loadingDashboard: "Loading dashboard\u2026",
    emptyTitle: "No outputs yet",
    emptyDescription: "Files and dashboards from the session appear here."
  },
  common: {
    uploadsDisabled: "File and image uploads are disabled.",
    health: "Health",
    ok: "OK",
    yes: "Yes",
    no: "No",
    default: "Default",
    active: "Active",
    loading: "Loading\u2026",
    gatewayStarting: "Gateway starting\u2026",
    refreshing: "Refreshing\u2026",
    offline: "Offline",
    connect: "Connect",
    connected: "Connected",
    refresh: "Refresh",
    retry: "Retry",
    staleData: "Showing stale data.",
    reload: "Reload",
    reset: "Reset",
    restore: "Restore",
    unarchive: "Unarchive",
    undo: "Undo",
    probe: "Check connection",
    call: "Call",
    confirm: "Confirm",
    dontAskAgain: "Don't ask me again",
    cancel: "Cancel",
    close: "Close",
    previous: "Previous",
    next: "Next",
    continue: "Continue",
    back: "Back",
    create: "Create",
    copy: "Copy",
    copied: "Copied!",
    copyFailed: "Copy failed",
    copyCode: "Copy code",
    copyTable: "Copy table",
    expandTable: "Expand table",
    expandedTable: "Expanded table",
    closeTable: "Close expanded table",
    resizeSplitView: "Resize split view",
    delete: "Delete",
    remove: "Remove",
    dismiss: "Dismiss",
    dismissAndDontShowAgain: "Dismiss and don't show again",
    unselect: "Unselect",
    enabled: "Enabled",
    disabled: "Disabled",
    failed: "Failed",
    none: "none",
    na: "n/a",
    never: "never",
    justNow: "just now",
    now: "now",
    unknown: "Unknown",
    configured: "Configured",
    running: "Running",
    queued: "Queued",
    completed: "Completed",
    cancelled: "Cancelled",
    linked: "Linked",
    mode: "Mode",
    system: "System",
    light: "Light",
    dark: "Dark",
    baseUrl: "Base URL",
    lastStart: "Last start",
    lastProbe: "Last connection check",
    lastConnect: "Last connect",
    lastMessage: "Last message",
    authAge: "Auth age",
    credential: "Credential",
    audience: "Audience",
    publicKey: "Public Key",
    probeOk: "Connection check passed",
    probeFailed: "Connection check failed",
    reloadConfig: "Reload Config",
    multiSelect: {
      addCustom: "Add \u201C{value}\u201D",
      noMatches: "No matches",
      remove: "Remove {value}"
    },
    loadConfig: "Load config",
    loadApprovals: "Load approvals",
    settingsSections: "Settings sections",
    version: "Version",
    docs: "Docs",
    learnMore: "Learn more",
    colorMode: "Color mode",
    colorModeOption: "Color mode: {mode}",
    search: "Search",
    pickerNoMatches: "No matches",
    save: "Save",
    saving: "Saving\u2026",
    saveAndPublish: "Save & Publish",
    importing: "Importing\u2026",
    importFromRelays: "Import from Relays",
    showAdvanced: "Show Advanced",
    hideAdvanced: "Hide Advanced",
    unsavedChanges: "You have unsaved changes",
    working: "Working\u2026",
    showQr: "Show QR",
    relink: "Relink",
    waitForScan: "Wait for scan",
    logout: "Logout",
    skipToMainContent: "Skip to main content"
  },
  focus: {
    unsupported: "This focused view is not supported."
  },
  shortcutsOverlay: { title: "Keyboard shortcuts" },
  optionCard: {
    recommended: "Recommended",
    skip: "Skip for now"
  },
  nativeConversation: {
    openDashboardFailed: "Couldn't open that page in the Dashboard"
  },
  nativeLinkMenu: {
    label: "Link actions",
    openInline: "Open in Browser Panel",
    openExternal: "Open in Default Browser",
    copy: "Copy Link"
  },
  browserLinkPreferences: {
    openInControlUi: "Open links in Control UI browser"
  },
  filePreview: {
    bundle: {},
    label: "Support files"
  },
  mcpApp: {},
  sessionHovercard: {
    ariaLabel: "Session information",
    linkedChannel: "Linked to {channel}",
    moreParticipants: "+{count}",
    moreParticipantsLabel: "{count} more participants",
    projectLabel: "Project",
    workspaceLabel: "Workspace",
    branchLabel: "Branch",
    runsOn: "Runs on {providerId} \xB7 {profileId}",
    machineLabel: "Machine",
    machineCpu: "{cpu} vCPU",
    machineMemory: "{memory} GB",
    more: "+{count} more",
    changedFile: "{count} file",
    changedFiles: "{count} files",
    states: {},
    checks: {}
  },
  sessionProgressCard: {
    title: "Progress",
    composerTitle: "Task progress",
    stepCount: "Step {current} of {total}",
    hide: "Hide this card",
    noteLabel: "Progress note",
    dismiss: "Dismiss progress card",
    clearSaved: "Clear saved progress for everyone",
    clearFailed: "Could not clear saved progress card.",
    refresh: {
      label: "Refresh task progress",
      retry: "Retry progress refresh",
      pending: "Refreshing task progress\u2026",
      failed: "Could not refresh. Previous update kept.",
      timeout: "No new update yet. The request may still be running.",
      updated: "Task progress updated"
    },
    widgetLabel: "Session progress",
    widgetLoading: "Loading session progress\u2026",
    widgetEmpty: "No progress card yet",
    detailsEmptyTitle: "No saved progress",
    detailsEmptyDescription: "Progress saved by this session appears here.",
    showInChat: "Show in chat",
    widgetUnavailable: "Session progress is unavailable.",
    widgetAccessDenied: "Select a session you can access or change sharing for this session.",
    countLabel: "{completed} of {total} completed",
    activity: {
      updated: "Updated {time}",
      completed: "Completed {time}",
      failed: "Failed {time}",
      stopped: "Stopped {time}"
    },
    outcome: {
      completed: "Completed",
      failed: "Failed",
      stopped: "Stopped"
    },
    stepLabel: "{step}, {status}",
    status: {
      completed: "completed",
      failed: "failed",
      inProgress: "in progress",
      paused: "paused",
      pending: "pending",
      stopped: "stopped"
    },
    receipt: {
      updating: "Updating progress",
      failed: "Progress update failed",
      skipped: "Progress update skipped",
      updated: "Progress updated \u2014 {completed}/{total} \xB7 {current}",
      noteUpdated: "Progress note updated",
      cleared: "Progress cleared"
    }
  },
  channels: {
    lastError: {},
    refreshingStaleSnapshot: {},
    hub: {},
    pairing: {},
    setup: {},
    config: {},
    generic: {},
    discord: {},
    googleChat: {},
    imessage: {},
    signal: {},
    slack: {},
    telegram: {},
    whatsapp: {
      loggedOut: "Logged out.",
      logoutNotCleared: "No stored WhatsApp session was cleared. It may already be absent, or its auth directory may require manual cleanup."
    }
  },
  agentStartup: {
    title: "Starting up",
    description: "The agent is getting ready. This view will load automatically.",
    short: "Starting up\u2026"
  },
  lazyView: {
    errorTitle: "Panel failed to load",
    genericSubtitle: "Something went wrong while loading this panel.",
    staleTitle: "This view could not load",
    staleSubtitle: "Some interface files could not be downloaded. Check your connection, then reload.",
    reloading: "Reloading\u2026",
    retry: "Retry",
    stylesFailed: "Styles failed to load, so the page may look broken."
  },
  communityInvite: {
    title: "Pull up a chair.",
    body: "There\u2019s a place for you in the AI future. Join the Community on Reddit, Discord, and X.",
    join: "Join",
    follow: "Follow",
    dismissForever: "Dismiss and don't show again",
    dismissFailed: "Invitation dismissed, but your preference couldn't be saved.",
    joinPlatform: "Join the OpenClaw community on {platform}",
    followPlatform: "Follow OpenClaw on {platform}"
  },
  updates: {
    adminRequired: "Administrator access is required to change update settings or start an update.",
    refreshFailed: "Could not refresh. Check your connection and try again.",
    campaign: {
      countdown: "Updating in {time}",
      waitingForIdle: "Waiting for active work \xB7 forced update in {time}",
      held: "Update held \xB7 resumes in {time}",
      applying: "Applying update\u2026"
    },
    holdOneHour: "Hold 1 h",
    reviewUpdate: "Review update",
    run: {
      title: "Update progress",
      phases: "Update phases",
      steps: "Installation steps",
      details: "Step details",
      noDetails: "No step details recorded yet.",
      verification: "Verification checks",
      report: "Update report",
      restarting: "Gateway restarting\u2026",
      reconnecting: "Reconnecting automatically. Update progress is saved on the gateway.",
      progress: "{completed} of {total} phases complete",
      phase: {
        requested: "Requested",
        staging: "Staging",
        validating: "Validating",
        repairing: "Repairing",
        activating: "Activating",
        restarting: "Restarting",
        verifying: "Verifying",
        finished: "Finished"
      },
      step: {
        completed: "Complete",
        in_progress: "In progress",
        pending: "Pending",
        failed: "Failed",
        skipped: "Skipped"
      },
      oracle: {
        service: "Service",
        version: "Version",
        plugins: "Plugins",
        channels: "Channels",
        inference: "Inference"
      },
      oracleState: {
        pass: "Passed",
        warn: "Not verified",
        fail: "Failed",
        pending: "Pending"
      }
    },
    confirm: {
      action: "Update and restart"
    },
    target: {
      version: "v{version}",
      commitBehind: "{count} commit behind",
      commitsBehind: "{count} commits behind",
      viewChanges: "Compare on GitHub"
    },
    sidebar: {
      campaignTarget: "{status} \xB7 {target}",
      checking: "Checking for updates\u2026",
      checkFailed: "Could not check the latest update. Try again.",
      updating: "Updating Gateway\u2026",
      availableTitle: "Update available",
      availableBadge: "Available",
      availableSummary: "A newer revision is ready.",
      blockedTitle: "Update blocked",
      blockedSummary: "The selected revision could not be applied to this checkout.",
      blockedWaiting: "Blocked \xB7 waiting for active work \xB7 {target}",
      waitingForIdle: "Waiting for active work"
    },
    dialog: {
      disconnected: "The Gateway disconnected during the update. This page reconnects on its own. If it stays disconnected, run `openclaw triage` on the Gateway host to open a local coding agent for diagnosis and repair.",
      restarting: "The Gateway is restarting. This page disconnects and reconnects on its own. If it stays disconnected, run `openclaw triage` on the Gateway host to open a local coding agent for diagnosis and repair."
    },
    channel: {},
    installKind: {},
    page: {},
    coalescedRestart: "Update installed. A gateway restart is already in progress; status will refresh after it reconnects.",
    error: "Update error: {error}",
    checkError: "Could not check for updates: {error}",
    status: "Update {status}: {reason}. {guidance}",
    verificationFailedWithIdentity: "Update finished, but the running install does not match the expected revision. Expected {expected}, running {actual}. Run `openclaw triage` on the Gateway host before retrying.",
    handoffTimeout: "Update completion was not confirmed. Run `openclaw triage` on the Gateway host and inspect the result before retrying.",
    outcomeUnknown: "The update outcome is unknown. Run `openclaw triage` on the Gateway host and inspect the result before retrying.",
    triage: {
      hostHint: "If Ask OpenClaw is unavailable, run `openclaw triage` on the Gateway host to open a local coding agent for diagnosis and repair. Diagnose the cause before retrying."
    },
    report: {},
    failureReasons: {
      dirty: "Commit or stash changes, then retry.",
      noUpstream: "Set an upstream branch, then retry.",
      notGitInstall: "Not a git checkout. Run `openclaw update` from the CLI for a global reinstall.",
      notOpenclawRoot: "Run the update from an OpenClaw checkout or use the CLI global reinstall path.",
      depsInstallFailed: "Dependency install failed. Fix the install error and retry.",
      buildFailed: "Build failed. Fix the build error and retry.",
      buildDirty: "The selected revision's build changed checkout files. Retry with a revision that includes its generated artifacts.",
      uiBuildFailed: "The control UI rebuild failed. Fix the UI build error and retry.",
      globalInstallFailed: "The global package install did not verify on disk. Retry or reinstall from the CLI.",
      restartDisabled: "The update was not applied because gateway restarts are disabled. Enable restarts in config, then retry.",
      restartUnavailable: "This global install cannot be safely replaced while restarts are disabled and no supervisor is present.",
      externalSupervisorUpdateRequired: "This Gateway is managed by an external supervisor. Use your server or deployment's update workflow to update OpenClaw and restart the Gateway. The Control UI and `openclaw update` cannot update this installation. No package changes or Gateway restart were attempted.",
      restartUnhealthy: "The replacement process never became healthy. The previous process stayed up so you can recover.",
      restartRevisionMismatch: "The restarted Gateway is running a different revision. Check the service install root and retry.",
      restartRevisionUnavailable: "The restarted Gateway could not report its revision. Check the service install root and logs before retrying.",
      alreadyCurrent: "This checkout is already at its tracked upstream revision.",
      managedServiceHandoffAlreadyRunning: "Another managed update is already running. Wait for it to complete, then refresh update status.",
      managedServiceHandoffUnavailable: "Stop the foreground Gateway, run `openclaw update`, then launch it again. For automatic updates, install a managed Gateway service.",
      doctorFailed: "Doctor repair failed. Run `openclaw doctor --non-interactive` and retry.",
      managedServiceHandoffFailed: "The update helper stopped before finishing. Run `openclaw update` in the terminal to see why.",
      managedServiceHandoffSpawnFailed: "The Gateway could not start the update helper. Run `openclaw update` in the terminal instead.",
      managedServiceHandoffParentTimeout: "The Gateway stayed up too long for the update helper. Start the update again, or run `openclaw update`.",
      default: "See the gateway logs for the exact failure and retry once the cause is fixed."
    },
    failedAtStep: "The update failed at {step}: {cause}.",
    succeededVersion: "Gateway updated to v{version}.",
    succeededCommit: "Gateway updated \xB7 now on {sha}.",
    succeeded: "Gateway updated and restarted."
  },
  devices: {
    readOnly: {},
    // The trigger and load failure stay eager; dialog copy follows its lazy renderer.
    pairing: {
      button: "Pair device",
      adminRequired: "Administrator access is required to create setup codes.",
      title: "Pair a device",
      loadFailed: "Could not load the pairing dialog. Check your connection and try again."
    },
    binding: {},
    inventory: {},
    // Lazy: en-devices.ts registers this subtree when the Devices page renders chips.
    capabilities: {},
    execApprovals: {}
  },
  worktrees: {
    adminRequired: "Browsing only. Worktree changes require operator.admin access.",
    newWorktree: "New worktree",
    ownerManual: "Manual",
    ownerSession: "Session",
    ownerWorkboard: "Workboard",
    title: "Managed Worktrees",
    subtitle: "Isolated repository checkouts owned by OpenClaw.",
    cleanNow: "Clean up now",
    name: "Name",
    namePlaceholder: "auto",
    baseBranch: "Base branch",
    baseBranchPlaceholder: "Remote default",
    repo: "Repository",
    empty: "No managed worktrees.",
    restorable: "Restorable",
    restore: "Restore",
    confirmDelete: "Snapshot and delete {name}?",
    confirmForceDelete: `Snapshot failed: {error}

Delete without a snapshot?`
  },
  agentChip: qo,
  agentScope: Wo,
  newSession: {
    title: "New session",
    hint: "Pick where this session works, then say what to do.",
    placementReloadBlocked: "Recovery needs a reload. Unsaved starts will be lost.",
    discardUnsavedAndReload: "Discard unsaved starts and reload"
  },
  dashboardsPage: {
    emptyTitle: "No dashboards yet",
    emptyDescription: "Dashboards created in your tasks will appear here.",
    loadError: "Could not load dashboards: {error}",
    openFocusMode: "Open dashboard in focus mode",
    live: "Live",
    byAuthor: "By {author}",
    updated: "Updated {time}",
    updatedUnknown: "Update time unknown",
    totalLabel: "dashboards",
    searchLabel: "Search dashboards",
    searchPlaceholder: "Search dashboards\u2026",
    authorFilter: "Author",
    allAuthors: "All authors",
    sortLabel: "Sort",
    sortUpdated: "Recently updated",
    sortTitle: "Title A\u2013Z",
    resultCount: "Dashboards: {count}",
    noResultsTitle: "No matching dashboards",
    noResultsDescription: "Try another search or author."
  },
  dashboardDocument: {
    close: "Close dashboard",
    missingSession: "No dashboard session was specified.",
    notFound: "This session could not be found.",
    unavailable: "Session dashboards are unavailable for this connection.",
    loadFailed: "Could not load this dashboard: {error}. Check the Gateway connection and try again."
  },
  sessionsView: {
    pullRequestCount: "{count} pull requests",
    subagentPrefix: "Subagent:",
    automationPrefix: "Automation:",
    actionRequiresConnection: "Connect to the Gateway to change sessions.",
    actionUnavailable: "This Gateway does not support this session action.",
    actionRequiresScope: "This action requires {scope} access.",
    actionRequiresOwnership: "Only the session creator or an admin can make this change.",
    draftCleanupFailed: "Session deleted; browser draft remains. Clear site data.",
    createdBy: "Created by {name}",
    ownedBy: "Owned by {name}",
    archivedBy: "Archived by {name}",
    viewingNow: "viewing now",
    owners: "Owners",
    allOwners: "All owners",
    involvingMe: "Involving me",
    withParticipant: "with {name}",
    withMoreParticipants: "+{count} more",
    snoozeWakes: "Wakes {time}",
    snoozeTomorrowTime: "tomorrow {time}",
    user: "User",
    assistant: "Assistant",
    opensAsDashboard: "Opens as dashboard",
    approvalNeeded: "Approval needed",
    messageNeedsAttention: "{count} message needs attention",
    messagesNeedAttention: "{count} messages need attention",
    unsentDraft: "Unsent draft",
    noArchivedSessions: "No archived sessions.",
    status: "Status",
    statusLive: "Live",
    statusIdle: "Idle",
    statusUnknown: "Unknown",
    statusQueued: "Queued",
    statusRunning: "Running",
    statusDone: "Done",
    statusFailed: "Failed",
    statusInterrupted: "Interrupted",
    statusKilled: "Killed",
    statusTimeout: "Timed out",
    waitingForAnswer: "Waiting for your answer",
    waitingForApproval: "Waiting for approval",
    questionsNeedAnswer: "{count} questions need your answer",
    approvalsNeedApproval: "{count} requests need approval",
    attentionMore: "+{count} more",
    runFailedReason: "Run failed: {reason}",
    childRunFailedReason: "Child session {label} failed: {reason}",
    runErrorTimedOut: "Timed out",
    runErrorUnknown: "Unknown error",
    attentionRequired: "Session needs attention",
    openSession: "Open session",
    provider: "Provider",
    lastActive: "Last active {time}",
    activeRun: "Active run",
    subagentsWorking: "Subagents working",
    showChildSessions: "Show {count} child sessions for {session}",
    hideChildSessions: "Hide {count} child sessions for {session}",
    childSessions: "Child sessions",
    showMoreChildren: "Show {count} more",
    archived: "Archived",
    unread: "Unread",
    automationAttached: "Automation attached",
    incognito: "Incognito session",
    incognitoLabel: "Incognito",
    incognitoDescription: "Incognito session. History expires 24 hours after creation or when the Gateway restarts, whichever comes first.",
    incognitoLimits: "Your model provider still processes messages. Tools, plugins, and uploads may save data.",
    cloudWorkerPlacement: "Placement: {state}",
    placementWorkspaceConflict: "{placement} \xB7 1 workspace conflict",
    placementWorkspaceConflicts: "{placement} \xB7 {count} workspace conflicts",
    cloudWorkerDiskWarning: "Cloud session disk space is low",
    cloudWorkerDiskCritical: "Cloud session disk space is critically low",
    cloudWorkerDescendantConflict: "Cloud worker child: 1 workspace conflict",
    cloudWorkerDescendantConflicts: "Cloud worker children: {count} workspace conflicts",
    sessionColor: "Session color: {color}",
    colors: {
      red: "Red",
      blue: "Blue",
      green: "Green",
      yellow: "Yellow",
      purple: "Purple",
      orange: "Orange",
      pink: "Pink",
      cyan: "Cyan"
    },
    pinSession: "Pin session",
    unpinSession: "Unpin session",
    forkedSession: "Forked session",
    archiveSession: "Archive session",
    restoreSession: "Restore session",
    deleteSessionStale: 'Gateway connection replaced before "{session}" was deleted. Try again.',
    deleteSessionsStale: "Gateway connection replaced before {count} sessions were deleted. Try again.",
    groupMenu: "Group options for {group}",
    newSessionInGroup: "New session in {group}",
    groupDefaultsStale: "Gateway connection replaced before the defaults were saved. Try again.",
    moveToTopLevel: "Move to top level"
  },
  agents: {
    noAgents: "No agents",
    createdBy: {},
    defaults: {},
    copyId: {},
    default: "Default",
    setDefault: {},
    ...jo,
    selectTitle: {},
    selectSubtitle: {},
    tabs: {},
    context: {},
    identity: {},
    overview: {
      title: {},
      subtitle: {},
      selectedSkills: "{count} selected",
      allSkills: "all skills",
      unsavedConfig: {},
      modelSelection: {},
      primaryModel: {},
      primaryModelDefault: {},
      notSet: {},
      inheritDefault: {},
      inheritDefaultModel: {},
      fallbacks: {},
      addFallback: {}
    },
    toolCatalog: {},
    skillsPanel: {},
    channels: {},
    cronPanel: {},
    files: {}
  },
  debug: {
    lanes: {
      lane: "Lane",
      active: "Active",
      queued: "Queued",
      blocked: "Blocked"
    },
    overlay: {
      title: "System busyness",
      eyebrow: "Live diagnostics",
      move: "Move system busyness with arrow keys, or drag",
      minimize: "Minimize system busyness",
      expand: "Expand system busyness",
      lanes: "Lanes",
      status: "Event loop / status",
      activeRuns: "Active runs",
      events: "Events",
      cpu: "CPU",
      memory: "Memory",
      delayP99: "Delay p99"
    }
  },
  configForm: {
    redactedPlaceholder: "[redacted - click reveal to view]",
    sectionHelp: "Help for {section}",
    advancedDivider: "Advanced",
    advancedSettings: "Advanced settings",
    hideValue: "Hide value",
    revealValue: "Reveal value",
    disableStreamToReveal: "Disable stream mode to reveal value",
    storedSecretNotRevealable: "This editor cannot reveal the stored value.",
    unsupportedType: "Unsupported type: {type}. Use Raw mode.",
    structuredSecretRaw: "Structured value (SecretRef) - use Raw mode to edit",
    structuredSecretFile: "Structured value (SecretRef) - edit the config file directly",
    defaultValue: "Default: {value}",
    select: "Select...",
    enumOn: "On",
    enumOff: "Off",
    enumAuto: "Auto",
    nullValue: "null",
    jsonValue: "JSON value",
    invalidJson: "Enter valid JSON before leaving this field.",
    invalidString: "Enter a value that matches this setting's constraints.",
    invalidNumber: "Enter a value within the allowed range and step.",
    draftRejected: "This setting could not be saved. Your draft is still here.",
    unsupportedArray: "Unsupported array schema. Use Raw mode.",
    itemCountOne: "{count} item",
    itemCount: "{count} items",
    add: "Add",
    noItems: 'No items yet. Click "Add" to create one.',
    removeItem: "Remove item",
    customEntries: "Custom entries",
    addEntry: "Add Entry",
    key: "Key",
    removeEntry: "Remove entry",
    renameRedactedBlocked: "This entry holds a stored secret. Add the new key with its value, then remove this one.",
    schemaUnavailable: "Schema unavailable.",
    unsupportedSchema: "Unsupported schema. Use Raw.",
    unsupportedNode: "Unsupported schema node. Use Raw mode.",
    noSettingsMatch: 'No settings match "{query}"',
    noSettingsInSection: "No settings in this section",
    sections: {}
  },
  // Historical namespace from the pre-restructure "quick settings" page; its
  // keys now serve Models, Privacy & Security, Appearance, and Profile.
  // Renaming would force retranslation of every key, so the name stays.
  quickSettings: {
    language: "Language",
    model: {
      title: "Model & Thinking",
      model: "Model",
      thinking: "Thinking",
      fastMode: "Fast Mode",
      default: "Default",
      modelPolicy: "Model policy",
      thinkingLevels: {
        off: "Off",
        low: "Low",
        medium: "Medium",
        high: "High"
      },
      fastModes: {
        auto: "Auto",
        fast: "Fast",
        standard: "Standard",
        on: "On",
        off: "Off"
      }
    },
    channels: {
      title: "Channels",
      connect: "Connect \u2192"
    },
    appearance: {
      lobsterVisits: "Lobster visits",
      lobsterVisitsOn: "Drops by occasionally",
      lobsterVisitsThemeHidden: "The lobster stays home while the {theme} theme is active. Other visitors still drop by.",
      lobsterVisitsOff: "Never visits",
      lobsterSounds: "Lobster sounds",
      lobsterSoundsOn: "Tiny blubs when touched",
      lobsterSoundsOff: "Silent",
      lobsterdex: "Lobsterdex",
      lobsterdexSeen: "{seen}/{total} visited",
      lobsterdexFirstVisited: "{name} \xB7 first visited {date}",
      lobsterdexCardFirstVisited: "First visited {date}",
      lobsterdexCardShinySeen: "\u2726 Shiny spotted {date}",
      lobsterdexCardCopyLink: "Copy link",
      lobsterdexOpen: "Open Lobsterdex",
      lobsterdexThemeHidden: "This theme hides Lobsterdex. Your collection and preferences are preserved."
    },
    security: {
      intro: "Review gateway access, tool policy, device authentication, and approvals.",
      title: "Security",
      gatewayAuth: "Gateway auth",
      execPolicy: "Exec policy",
      browserEnabled: "Browser enabled",
      toolProfile: "Available tools",
      toolProfileDefault: "Using core and default plugin tools. Choose Full to include available optional plugin tools."
    },
    system: {
      gatewayHost: "Gateway Host",
      up: "Up {duration}",
      cpu: "CPU",
      memory: "Memory",
      disk: "Disk",
      usage: "{label} usage",
      loadAverage: "Load average: {values}",
      core: "{count} core",
      cores: "{count} cores",
      load: "load",
      used: "used",
      freeOf: "{free} free of {total}",
      runtime: "Node {version} \xB7 PID {pid}"
    },
    personal: {
      browserOnly: "Stored in this browser only."
    }
  },
  configPage: {},
  configView: {
    adminRequired: "Configuration changes require operator.admin access.",
    channelSettings: "Channel settings",
    categories: {},
    sections: {},
    themes: {},
    textSizes: {},
    profileSyncedHint: "Saved to your profile \u2014 follows you on every device.",
    syncedHint: "Synced across your devices through the gateway.",
    syncPendingHint: "Waiting to sync through the gateway.",
    notifications: {},
    appearance: {},
    chatPrefs: {},
    sidebarPrefs: {},
    sessionObserver: {},
    connection: {},
    root: "<root>",
    itemCount: "[{count} item]",
    itemCountPlural: "[{count} items]",
    form: "Form",
    raw: "Raw",
    formUnsafeTitle: "Form view can't safely edit some fields",
    rawTitle: "Edit raw JSON/JSON5 config",
    rawUnavailableTitle: "Raw mode unavailable for this snapshot",
    open: "Open",
    fileOpenedOnGateway: "Configuration file opened on Gateway host.",
    applying: "Applying\u2026",
    autoSaveSaving: "Saving\u2026",
    autoSaveSaved: "Saved",
    autoSavePaused: "Autosave paused after reconnect",
    saveNow: "Save",
    autoSaveFailed: "Save failed",
    autoSaveRejected: "Settings not applied",
    autoSaveRejectedHint: "Current settings are unchanged.",
    rejectionDetails: "Show reason",
    recoveryNotRestored: "Settings could not be restored. Your draft is kept. Check {path} before saving again.",
    recoveryUnknown: "Settings restoration could not be confirmed. Your draft is kept. Check {path} before saving again.",
    recoveryBackup: "Inspect the recovery backup at {path}.",
    recoveryReload: "Discard draft and reload",
    discardUnconfirmed: "The last save could not be confirmed. Your draft is kept. Reload configuration before discarding this setting.",
    writeGatewayChanged: "This unsettled change belongs to a different Gateway. Reconnect to that Gateway to retry, or discard the draft.",
    writeUnconfirmed: "The last configuration change could not be confirmed. Your draft is kept. Retry before changing other settings.",
    autoSaveConflict: "Settings changed elsewhere",
    retry: "Retry",
    applyChanges: "Apply changes",
    rawDiscard: "Discard",
    reloadBlocked: "Finish saving or discard pending config changes before reloading.",
    rawDraftBlocksApply: "Save or discard edits in the Raw editor before applying changes.",
    rawDraftPendingFormTitle: "Unsaved raw config edits \u2014 save or discard them before switching to Form.",
    rawDraftBlocksFormEdit: "Unsaved raw config edits could not be parsed; resolve them in the Raw editor before changing settings.",
    rawDraftUnverified: "Cannot verify the raw draft against the saved configuration; reload and retry.",
    invalidConfig: "Your configuration is invalid. Some settings may not work as expected.",
    dismissWarning: "Don't remind again",
    viewPendingChangesRaw: "View pending changes",
    rawDiffUnavailable: "Changes detected (JSON diff not available)",
    hideEnvValues: "Hide env values",
    revealEnvValues: "Reveal env values",
    peek: "Peek",
    loadingSchema: "Loading schema\u2026",
    formUnsafeCount: "1 setting in this config can only be edited as text: {paths}",
    formUnsafeCountPlural: "{count} settings in this config can only be edited as text: {paths}",
    formUnsafeMore: "+{count} more",
    openRawEditor: "Open Raw editor",
    rawConfig: "Raw config (JSON/JSON5)",
    secretCount: "{count} secret",
    secretCountPlural: "{count} secrets",
    redacted: "redacted",
    visible: "visible",
    revealSensitive: "Reveal sensitive values",
    hideSensitive: "Hide sensitive values",
    toggleRawRedaction: "Toggle raw config redaction",
    sensitiveHidden: "{count} sensitive value hidden. Use the reveal button above to edit the raw config.",
    sensitiveHiddenPlural: "{count} sensitive values hidden. Use the reveal button above to edit the raw config."
  },
  execApproval: {
    watcherApprovalScope: "Approval applies to this saved watcher. Source changes or reactivation may require approval again.",
    watcherSandboxSummary: "Runs in your sandbox after you leave this chat, until stopped. Restarts automatically after interruptions.",
    watcherGatewaySummary: "Runs on the Gateway after you leave this chat, until stopped. Restarts automatically after interruptions.",
    watcherSummary: "Runs after you leave this chat, until stopped. Restarts automatically after interruptions.",
    startWatcher: "Start watching",
    saveWatcher: "Save watcher change",
    cancelWatcher: "Cancel",
    scope: {
      standingGrant: 'Always allow runs this exact command for "{automation}" without asking, until revoked (revocable)',
      standingGrantDays: 'Always allow runs this exact command for "{automation}" without asking, for {count} days (revocable)',
      messageSend: "Sends to {count} recipient(s) via {target}",
      payment: "Pays {amount} {currency} to {target}",
      externalPost: "Posts externally to {target}"
    },
    expiresIn: "expires in {time}",
    expired: "expired",
    execApprovalNeeded: "Exec approval needed",
    runCommand: "Run this command?",
    pluginApprovalNeeded: "Plugin approval needed",
    requestedBySession: "Approval requested by session {session}",
    pending: "{count} pending",
    otherPending: "Other pending requests",
    reviewRequest: "Review approval from {agent}: {command}",
    decisionRequest: "{decision}: {command}",
    agentPendingOne: "{count} pending approval",
    agentPending: "{count} pending approvals",
    allowOnce: "Allow once",
    alwaysAllow: "Always allow",
    alwaysAllowHere: "Always allow here",
    allowAlwaysUnavailable: "Allow Always is unavailable for this command.",
    reviewOnly: "Review only. Sign in with approval access to record a decision.",
    deny: "Deny",
    details: "Details",
    labels: {
      host: "Host",
      session: "Session",
      cwd: "CWD",
      directory: "Directory",
      resolved: "Resolved",
      security: "Security",
      ask: "Ask"
    }
  },
  approvalPage: {},
  agentTools: {},
  skillGroups: {
    workspace: "Workspace Skills",
    learned: "Learned Skills",
    builtIn: "Built-in Skills",
    installed: "Installed Skills",
    extra: "Extra Skills",
    other: "Other Skills"
  },
  skillsPage: {},
  skillStatus: {
    bundled: "bundled",
    eligible: "eligible",
    blocked: "blocked",
    disabled: "disabled",
    blockedAllowlist: "blocked by allowlist",
    blockedAgentFilter: "blocked by agent filter"
  },
  nav: {
    gateway: {
      sectionLabel: "Gateway",
      menuLabel: "Gateway: {gateway}",
      primaryTag: "primary",
      setPrimary: "Set as primary\u2026",
      openSettings: "Gateway settings\u2026",
      connected: "Connected",
      unreachable: "Unreachable",
      unknown: "Unknown status"
    },
    owner: "Owner",
    back: "Back",
    forward: "Forward",
    settings: "Settings",
    askOpenClaw: "Ask OpenClaw",
    askBrand: "Ask {brand}",
    settingsGroupDevice: "This Mac",
    settingsGroupThisComputer: "This computer",
    settingsGroupThisIPhone: "This iPhone",
    settingsGroupThisIPad: "This iPad",
    settingsGroupThisDevice: "This device",
    settingsGroupConnections: "Connections",
    settingsGroupAgents: "Agents & Tools",
    settingsGroupSecurity: "Privacy & Security",
    settingsGroupSystem: "System",
    settingsSearchLabel: "Search settings",
    settingsSearchPlaceholder: "Search settings\u2026",
    settingsSearchNoResults: "No matching settings.",
    settingsSearchClear: "Clear settings search",
    settingsLoadFailed: "Settings navigation could not load.",
    exitSettings: "Back to app",
    expand: "Expand sidebar",
    collapse: "Collapse sidebar",
    resize: "Resize sidebar",
    more: "More",
    home: "Home",
    pages: "Pages",
    pin: "Pin",
    unpin: "Unpin",
    customize: "Edit pinned items",
    customizeReset: "Reset pinned items",
    workboardGroup: "WorkBoard"
  },
  terminal: {
    title: "Terminal",
    availableSessions: "Available sessions",
    inputLabel: "Terminal input",
    sendInput: "Send terminal input",
    closeSessionMessage: "Close this terminal session? Its running process will end.",
    sessionsLabel: "Sessions",
    addFilesLabel: "Add files",
    copiedToClipboard: "Copied to clipboard",
    toggle: "Toggle terminal",
    open: "Open terminal",
    openWindow: "Open terminal in new window",
    hide: "Hide terminal",
    resize: "Resize terminal panel",
    newSession: "New terminal session",
    addFiles: "Add files to terminal",
    dropFiles: "Drop files to add them",
    uploadProgress: "Uploading {current} of {total}",
    uploadFailed: "Upload failed",
    retryUpload: "Retry",
    insertUploadedPaths: "Insert uploaded paths",
    uploadExpired: "Uploaded files may have expired. Cancel this batch and choose the files again.",
    closeSession: "Close terminal session",
    sessions: "Terminal sessions",
    refreshSessions: "Refresh",
    loadingSessions: "Loading sessions\u2026",
    noSessions: "No live terminal sessions",
    currentSession: "current",
    sessionAttached: "attached",
    attachSession: "Attach session",
    attachFailed: "Could not attach terminal session",
    deliveryFailed: "Terminal delivery could not be confirmed. Reconnect before trying again.",
    inputPaused: "Terminal input is paused until the Gateway reconnects.",
    startCancelled: "Terminal start was cancelled. Try again.",
    connecting: "Connecting to session\u2026",
    connectionTimedOut: "Session did not connect within 30 seconds.",
    refreshRequired: "Control UI updated. Reload this page to continue the terminal action.",
    tabLabel: "shell {n}",
    tabHint: "{agent} \xB7 {cwd}",
    agentOwnedBadge: "agent",
    exited: "exited",
    exitedCode: "exited ({code})",
    exitedSignal: "exited (signal {signal})",
    detached: "detached",
    dockBottom: "Dock to bottom",
    dockRight: "Dock to right",
    dockMain: "Fill main content area",
    dockMode: "Terminal panel position",
    unavailable: "The terminal is not available on this gateway.",
    unusableSession: "The Gateway returned an unusable terminal session (missing {field}). The Gateway is likely older than this Control UI \u2014 update it, then retry.",
    uploadTooLarge: "File exceeds the 16 MiB terminal upload limit: {file}",
    uploadUnsafeCmdPath: "Cannot safely insert an uploaded path containing % or ! into cmd.exe",
    uploadUnsupportedShell: "Cannot safely insert an uploaded path into unsupported shell: {shell}",
    uploadInvalidNativePath: "Cannot safely insert the uploaded native file path"
  },
  browser: {
    nativeTab: "App tab",
    remoteTab: "Agent browser tab",
    stop: "Stop loading",
    profile: "Browser profile: {profile}",
    title: "Browser",
    open: "Open",
    openPanel: "Open browser panel",
    moreActions: "More actions",
    copyUrl: "Copy URL",
    openNewTab: "Open in new tab",
    openWithinOpenClaw: "Open in OpenClaw",
    toggle: "Toggle browser panel",
    close: "Close browser panel",
    resize: "Resize browser panel",
    newTab: "New tab",
    closeTab: "Close tab",
    untitledTab: "New tab",
    tweetPost: "Post on X",
    openPost: "Open post",
    back: "Back",
    forward: "Forward",
    reload: "Reload",
    openExternal: "Open in your browser",
    urlPlaceholder: "Enter a URL and press Enter",
    dockBottom: "Dock to bottom",
    dockRight: "Dock to right",
    annotate: "Annotate page",
    inspect: "Inspect element",
    annotateSend: "Send to chat",
    annotateUndo: "Undo",
    annotateClear: "Clear",
    annotateDone: "Exit annotate mode",
    annotateHint: "Draw on the page, then send the markup to your chat.",
    inspectName: "Name",
    inspectRole: "Role",
    inspectFocusable: "Focusable",
    loading: "Loading page\u2026",
    notRunning: "The gateway browser is not running.",
    start: "Start browser",
    errors: {},
    annotatePrompt: {}
  },
  desktop: {
    title: "Desktop",
    openWindow: "Open desktop in new window",
    unavailable: "Desktop viewing is unavailable for this connection.",
    toggle: "Toggle desktop panel",
    reconnect: "Reconnect",
    connecting: "Connecting to desktop\u2026"
  },
  systems: {},
  routeTitles: {
    modelProviders: "Models",
    notifications: "Notifications",
    advanced: "Advanced"
  },
  tabs: {
    device: "This Mac",
    devicePermissions: "Permissions",
    agentsHome: "Agents",
    agents: "Agents",
    activity: "Activity",
    meetings: "Meetings",
    apps: "Apps",
    portals: "Portals",
    approvals: "Approvals",
    workboard: "Workboard",
    worktrees: "Worktrees",
    channels: "Channels",
    connection: "Gateway",
    sessions: "Sessions",
    systems: "Systems",
    usage: "Usage",
    cron: "Automations",
    skills: "Skills",
    plugins: "Plugins",
    skillWorkshop: "Skill workshop",
    devices: "Devices",
    claws: "Claws",
    cloudWorkers: "Cloud environments",
    chat: "Chat",
    dashboards: "Dashboards",
    custodian: "OpenClaw",
    profile: "Profile",
    communications: "Communications",
    appearance: "Appearance",
    lobsterdex: "Lobsterdex",
    automation: "Automation",
    mcp: "MCP",
    memory: "Memory",
    search: "Search",
    talk: "Talk",
    infrastructure: "Infrastructure",
    labs: "Labs",
    updates: "Updates",
    about: "About",
    aiAgents: "Agent Defaults",
    modelSetup: "Model Setup",
    memoryImport: "Import Memory",
    security: "Privacy & Security",
    secrets: "Secrets",
    debug: "Debug",
    logs: "Logs",
    plugin: "Plugin"
  },
  subtitles: {
    device: "App settings and capabilities on this Mac.",
    devicePermissions: "Manage macOS access, location, and computer presence.",
    agentsHome: "Who is on your team and what they are doing",
    agents: "Workspaces, tools, identities.",
    activity: "Recent sessions across people using this gateway.",
    meetings: "Meeting notes and transcripts across this gateway.",
    apps: "Companion apps for phone, watch, desktop, and browser.",
    portals: "Live previews from agent-run applications.",
    approvals: "Recent exec, plugin, and system-agent approvals.",
    workboard: "Agent work queue and session handoff.",
    worktrees: "Isolated agent task checkouts and recovery snapshots.",
    channels: "Channels and settings.",
    connection: "Gateway endpoint, credentials, and handshake status.",
    sessions: "Active sessions and defaults.",
    systems: "Machines and desktops.",
    usage: "API usage and costs.",
    cron: "Scheduled tasks and recurring agent runs.",
    skills: "Manage your agent skills",
    plugins: "Extend your Claw with tools",
    skillWorkshop: "Skills your agent learned, recent changes, and undo.",
    devices: "Paired devices, pairing approvals, and exec bindings.",
    claws: "Explore and add official Claws.",
    cloudWorkers: "Repository snapshots and machines for cloud sessions.",
    chat: "Gateway chat for quick interventions.",
    dashboards: "Tasks with saved dashboards.",
    custodian: "System setup and care.",
    config: "Legacy settings route; opens Appearance.",
    profile: "Your display name, avatar, and identity on this gateway.",
    communications: "Messages, text-to-speech, and meeting capture settings.",
    appearance: "Theme and UI settings.",
    lobsterdex: "Every lobster palette that has visited this browser.",
    automation: "Commands, hooks, automations, and plugins.",
    mcp: "MCP servers, auth, tools, and diagnostics.",
    memory: "Memory engine, search, and dreaming.",
    search: "Choose how agents search the web and check provider health.",
    talk: "Realtime voice: provider, model, and speaker voice.",
    infrastructure: "Gateway, browser, node host, discovery, and ACP settings.",
    labs: "Experimental agent and tool capabilities.",
    updates: "Release channel, automatic updates, and current update status.",
    about: "Control UI and connected Gateway build identity.",
    aiAgents: "Global agent defaults: skills, tools, and session.",
    modelSetup: "Connect a verified AI model",
    modelProviders: "Default models, behavior, provider access, usage, and cost.",
    memoryImport: "Bring Codex and Claude Code memory into an agent workspace.",
    notifications: "Browser push notifications from your gateway.",
    security: "Gateway auth, exec policy, tool profile, and approvals.",
    advanced: "Every remaining config section, plus the raw file editor.",
    debug: "Snapshots, events, RPC.",
    logs: "Live gateway logs.",
    plugin: "Plugin-provided panel."
  },
  meetingCapture: {
    title: "Meeting capture",
    description: "Choose which sources can save meeting notes on this Gateway.",
    sources: "Auto-start sources"
  },
  cloudWorkersPage: {},
  portalsPage: {},
  modelSetup: {
    discovery: {},
    missingAuth: "No provider credential is configured for this model. Set it up in Model Setup.",
    commandHint: "Try /models or /help.",
    heading: {},
    intro: {},
    required: {
      title: "No AI provider configured",
      body: "Connect a provider and choose a model to send messages.",
      action: "Connect an AI provider"
    },
    loading: {},
    testing: {},
    retry: {},
    checkAgain: {},
    recovery: {},
    verify: {},
    access: {},
    candidates: {
      title: {},
      recommended: {},
      credentialsReady: {},
      signInNeeded: "Sign-in needed",
      detected: {},
      testAndUse: {},
      retry: {},
      testingButton: {}
    },
    nativeDiscovery: {},
    nativeModels: {},
    empty: {},
    signIn: {},
    prepare: {},
    manual: {},
    success: {},
    utility: {},
    failure: {
      auth: "Authentication failed"
    },
    failureGuidance: {
      auth: "Review the provider credential or sign-in, then retry."
    },
    errors: {},
    wizard: {},
    waitingForApproval: {},
    providerConnected: {}
  },
  memoryImport: {},
  onboarding: {
    memoryImport: {
      title: "Bring your assistant memory with you",
      body: "OpenClaw found memory from other coding assistants. Import it into your agent workspace?",
      plannedCount: "{count} ready to import",
      alreadyImported: "Already imported: {count}",
      sourceUnavailable: "Source path unavailable",
      import: "Import",
      skip: "Skip",
      reviewDetails: "Review details",
      importingProvider: "Importing\u2026",
      providerResult: "Migrated {migrated}, skipped {skipped}",
      providerIncomplete: "Migrated {migrated}, skipped {skipped}, {errors} failed, {conflicts} conflicts",
      providerError: "Import failed: {error}",
      connectionChanged: "Skipped: the Gateway connection changed during the import",
      unknownError: "Request failed",
      doneTitle: "Memory import finished",
      doneBody: "Migrated {migrated}, skipped {skipped}. You can continue setting up OpenClaw."
    }
  },
  assistantPanel: {
    title: "Assistant sidebar",
    home: "Home",
    toggle: "Talk to your Home agent",
    openHome: "Open Home full page",
    close: "Close assistant sidebar",
    resize: "Resize assistant sidebar",
    dockBottom: "Dock assistant sidebar at bottom",
    dockRight: "Dock assistant sidebar at right",
    context: "Working on: {context}",
    contextOff: "Work context off",
    removeContext: "Remove work context",
    includeContext: "Include work context",
    selection: "Selected text",
    attachSelection: "Attach selected text",
    removeSelection: "Remove selected text"
  },
  custodian: {
    title: {},
    subtitleCaretaker: {},
    exitSetup: {},
    newAgent: "New agent",
    hatchDraft: {},
    placeholder: {},
    sensitivePlaceholder: {},
    sensitiveReply: {},
    cancel: {},
    send: {},
    thinking: {},
    earlier: {},
    requestFailed: {},
    connectionChanged: {},
    sessionRestarted: {},
    unsupportedGateway: {},
    accessRequired: {},
    autoSetup: { thisComputer: "This computer" },
    panel: {},
    history: {},
    nudge: {}
  },
  mcpServers: {},
  mcpPage: {},
  talkPage: {},
  memoryPage: {},
  sessionsPage: {
    hubTablistLabel: "Session sections"
  },
  pluginsPage: {
    installed: "Installed",
    official: "Official",
    install: "Install"
  },
  labsPage: {
    intro: "Labs contains experimental capabilities that may change, break, or disappear between releases.",
    sectionTitle: "Experimental features",
    sectionDescription: "Changes save without restarting the Gateway. Code Mode and Tool Search apply to future agent runs.",
    documentation: "Documentation",
    restartRequired: "Gateway restart required.",
    saveErrorTitle: "Could not update feature",
    saveFailed: "The feature setting could not be saved.",
    decisionAssistance: {},
    codeMode: {},
    swarm: {
      title: "Swarm",
      groupTitle: "Parallel tasks",
      defaultPhase: "Unphased",
      progress: "{complete} of {total}",
      active: "{running} running \xB7 {queued} queued \xB7 {failed} failed or stopped",
      finished: "{done} completed \xB7 {failed} failed or stopped",
      completed: "{done} completed",
      failedOrStopped: "Failed or stopped",
      childOutcome: "Child runs finished. Check the conversation for the final response.",
      childOutcomeProcessing: "Child runs finished. The parent is processing their results.",
      details: "Child details",
      detailsUnavailable: "Child details are unavailable. Counts include all accepted workers.",
      otherGroups: "{count} more active groups"
    },
    toolSearch: {},
    customPluginUi: {},
    hostDesktop: {},
    workerDesktop: {}
  },
  aboutPage: {
    productName: "OpenClaw",
    tagline: "Your personal AI assistant, running on your own devices.",
    waveHello: "Wave hello to Clawd",
    linksLabel: "Community and resources",
    linkWebsite: "Website",
    linkDocs: "Docs",
    linkGitHub: "GitHub",
    linkDiscord: "Discord",
    linkX: "X (Twitter)",
    linkChangelog: "Changelog",
    license: "\xA9 2026 OpenClaw Foundation \u2014 MIT License.",
    artifactTitle: "Control UI",
    artifactSubtitle: "Identity embedded when this browser artifact was built.",
    artifactDetails: "Control UI build details",
    version: "Version",
    commit: "Commit",
    branch: "Branch",
    built: "Built",
    unavailable: "Unavailable",
    copyCommit: "Copy full commit hash",
    copyingCommit: "Copying commit hash",
    copiedCommit: "Commit hash copied",
    copyCommitFailed: "Could not copy commit hash",
    gateway: "Gateway",
    gatewayVersion: "Connected Gateway version",
    gatewayVersionHint: "Reported by the active Gateway connection; separate from this Control UI build."
  },
  appsPage: {},
  presence: {
    sharedOwner: {
      name: "Shared owner",
      hint: "Connected with the Gateway token or over a tunnel, not a personal sign-in."
    },
    rosterTitle: "Online",
    usersTitle: "Users",
    allUsers: "All users",
    directoryFailed: "Could not load all users. Retry",
    filters: {
      label: "Filter & sort people",
      noMatches: "No people match this filter",
      presence: "Active people first",
      reset: "Reset to defaults",
      running: "Running sessions",
      total: "Total sessions",
      name: "Name"
    },
    active: "Active",
    onlineActive: "Online \xB7 Active",
    onlineIdle: "Online \xB7 Idle",
    idle: "Idle",
    offline: "Offline",
    sessions: {
      openCount: "{count}\xA0open",
      runningCount: "{count}\xA0running",
      openHint: "Owned, unarchived conversations you can access across agents. Excludes hidden subagents, automation, and system sessions.",
      runningHint: "Open sessions actively executing an agent turn. Queued work is not running.",
      counts: "{open} open sessions, {running} running",
      unavailable: "Session counts unavailable",
      retry: "Counts may be out of date. Retry"
    },
    card: {
      details: "Details for {name}",
      loadFailed: "Could not open details. Try again, or open this person\u2019s Activity page.",
      ariaLabel: "Activity for {name}",
      person: "Person",
      onlineFor: "Online for",
      where: "Where",
      reportedTimeZone: "Reported time zone: {zone}",
      lastActivity: "Last interaction",
      notObserved: "Activity unavailable",
      viewingNow: "Viewing now",
      recentSessions: "Recent sessions",
      noVisibleSessions: "No visible sessions being viewed.",
      noRecentSessions: "No recent visible sessions.",
      sessionUpdated: "Session updated",
      ago: "ago",
      viewActivity: "View activity",
      web: "Web app",
      cli: "Command line",
      terminal: "Terminal",
      app: "App"
    }
  },
  activityFeed: {
    partialHistory: "People and counts describe visible recorded session associations; retained history and this people list may be incomplete.",
    sessionsMode: "Sessions",
    searchPlaceholder: "Search session titles\u2026",
    time: "Time",
    time24h: "Last 24 hours",
    time7d: "Last 7 days",
    time30d: "Last 30 days",
    timeAll: "All time",
    everyone: "Everyone",
    peopleButtonLabel: "Filter sessions by person",
    lastActive: "\xB7 {time}",
    unresolvedIdentities: "Unresolved identities",
    clearPersonFilter: "Clear person filter",
    showing: "Showing {shown} of {total}",
    today: "Today",
    yesterday: "Yesterday",
    unknownDate: "Unknown date",
    noSessions: "No sessions match these filters.",
    automationGroup: "{count} automation sessions",
    automation: "Automation",
    inspectRun: "Inspect run",
    recap: "Session recap",
    recapMissing: "No recap yet",
    recapUpdating: "Updating recap\u2026",
    recapStale: "New activity since this recap",
    recapUnavailable: "Recap unavailable",
    recapRefreshFailed: "Couldn\u2019t refresh recap",
    recapRetry: "Retry recap",
    recapUpdated: "Recap updated {time}",
    backToSessions: "Back to sessions",
    channelLabel: "Channel: {value}",
    agentLabel: "Agent: {value}",
    online: "Online",
    idle: "Idle",
    offline: "Offline",
    unknownConnection: "Unknown client",
    connectionDetails: "Connection details \xB7 {count}",
    connectionOne: "1 connection",
    connectionMany: "{count} connections",
    lastInput: "Last input {time} ago",
    viewingNow: "Viewing now",
    notViewing: "Not viewing a session right now.",
    notFoundTitle: "Person not found",
    notFoundDescription: "No online presence or visible session association matches this identity."
  },
  githubPublication: {
    newAction: "Choose a new publication",
    capacity: 'Too many publications are awaiting review. Finish an existing publication, then select "{newAction}" to make room. Existing retries remain available.'
  },
  githubConnections: {
    title: "GitHub connections",
    mine: "My GitHub",
    system: "System GitHub",
    forMe: "For me",
    forSystem: "For the system"
  },
  profilePage: {
    personalInstructions: {
      title: "Personal instructions",
      description: "Tell this agent about you and how you like to work. This edits only your personal USER.md, not the shared workspace file."
    },
    offline: "Connect to the gateway to meet your agent.",
    access: {},
    usageStatistics: "Usage statistics",
    usageStatisticsDescription: "View activity, costs, and usage trends.",
    identity: {
      title: "Identity",
      menuLabel: "Identity menu",
      menuButtonLabel: "Identity and app menu for {name}",
      description: "Your profile on this gateway.",
      avatar: "Avatar",
      chooseAvatar: "Choose image",
      displayName: "Display name",
      linkedEmails: "Linked emails"
    },
    modelAccounts: {}
  },
  skillWorkshop: {},
  // Chat swarm summaries render before the lazy Activity catalog loads.
  // Keep their shared label in startup English; Activity replaces the full namespace on entry.
  activity: {
    status: {
      done: "Done"
    }
  },
  gatewayLogs: {},
  pluginTabs: {
    unavailableTitle: "Plugin panel unavailable",
    unavailableSubtitle: "The plugin that owns this tab is not active on the connected gateway, or it did not provide a panel."
  },
  logbook: {},
  board: {
    label: "Session dashboard",
    tabsLabel: "Dashboard tabs",
    moreTabs: "More dashboard tabs",
    gridLabel: "Dashboard widgets",
    emptyTitle: "A clear board, ready for work",
    emptyHint: "Your agent can pin widgets here \u2014 try asking for a status card.",
    actionFailed: "The dashboard change could not be saved.",
    actionInProgress: "Another dashboard change is still being saved.",
    announcement: {
      moved: "Moved {title}.",
      resized: "Resized {title}.",
      removed: "Removed {title}.",
      granted: "Widget access allowed.",
      rejected: "Widget access rejected."
    },
    widget: {
      cellLabel: "Dashboard widget: {title}. Use arrow keys to navigate. Hold Alt and press an arrow key to move it.",
      moveHandle: "Move {title}",
      resizeHandle: "Resize {title}",
      menuLabel: "Widget options",
      moveToTab: "Move to tab",
      noOtherTabs: "No other tabs",
      resize: "Resize",
      autoHeight: "Auto height",
      remove: "Delete",
      kindMcp: "MCP",
      kindHtml: "HTML",
      kindPlugin: "Plugin",
      kindReport: "Report",
      kindWebsite: "Website",
      kindBrowserDashboard: "Browser dashboard",
      pluginLoading: "Loading plugin widget\u2026",
      disabledPlugin: "Widget from disabled plugin {pluginId}"
    }
  },
  connection: {
    browserSignIn: {
      title: "Sign in to continue loading content",
      description: "Your website sign-in has expired. Images and files cannot load until you sign in again. Your conversation and draft will stay open.",
      action: "Sign in",
      dismiss: "Not now",
      returnHint: "Finish signing in in the new tab, then return here. Visible attachments will retry automatically.",
      checkAgain: "Check again",
      checking: "Checking access\u2026",
      stillRequired: "Sign-in is still required. Finish signing in, then check again.",
      unavailable: "Could not verify access. Check your connection and try again."
    },
    connecting: "Connecting\u2026",
    starting: "Starting\u2026",
    restoring: "Restoring\u2026",
    "reload-required": "Refresh required",
    offline: "Disconnected",
    reconnecting: "Reconnecting\u2026",
    interruptedRetrying: "Connection to the Gateway was interrupted. Reconnecting automatically. (WebSocket {code})",
    interrupted: "Connection to the Gateway was interrupted. Check your connection and try again. (WebSocket {code})",
    restarting: "Restarting\u2026",
    suspending: "Suspending\u2026",
    suspended: "Suspended",
    retryNow: "Retry now",
    queued: "{count} queued",
    offlineChangesDiscarded: "Offline changes discarded: {count}",
    offlineChangesReloadBlocked: "Offline changes are waiting to reconnect. Reloading would discard them.",
    sessionMoveRefreshFailed: "The session move was saved, but refreshing the list failed: {error}",
    sessionMoveUncertain: "The session move could not be confirmed. Refresh and check its group before retrying. {error}",
    sessionOperationCompletedPreviousConnection: "The session operation completed on the previous connection. Check the current session list before continuing.",
    sessionOperationCompletedPreviousConnectionWithRefreshError: "The session operation completed on the previous connection, but refreshing the current session list failed: {error}",
    scopeUpgrade: {},
    // Settings → Gateway copy lives in the lazy en-settings catalog; the anchor keeps its merge target.
    access: {},
    switchGateway: {
      title: "Switch to a different Gateway?",
      summary: "This link asks the browser to connect somewhere else.",
      current: "Current",
      next: "Link",
      note: "Anything you enter after switching goes to that host.",
      noteToken: "The link also carries a token for it.",
      noteScoped: "Your saved credential for {host} stays here and is not sent.",
      confirm: "Switch to {host}",
      cancel: "Keep current Gateway"
    },
    help: {
      title: "How to connect",
      step1: "Start the gateway on your host machine:",
      step2: "Get a tokenized dashboard URL:",
      step3: "Paste the Gateway URL and secret above, or open that URL directly.",
      docsLink: "Read the docs \u2192",
      copyCommand: "Copy command",
      copyCommandAria: "Copy command: {command}"
    }
  },
  // The Inbox loader renders before its diagnostics catalog loads.
  attention: {
    issues: "Inbox"
  },
  standingGrants: {},
  approvalHistory: {},
  commandPalette: {},
  palette: {
    placeholder: "Search or start a task\u2026",
    categories: { navigation: "Navigation" }
  },
  dreaming: {},
  modelProviders: {},
  searchPage: {},
  usage: {
    common: {
      emptyValue: "\u2014",
      unknown: "unknown",
      atLeast: "\u2265 {value}"
    },
    loading: {
      title: "Usage Overview",
      badge: "Loading"
    },
    metrics: {
      tokens: "Tokens",
      cost: "Cost",
      session: "session",
      sessions: "sessions"
    },
    heatmap: {
      title: "Token Activity",
      subtitle: "Daily token intensity for the selected range, up to one year.",
      cellTokens: "{tokens} tokens",
      less: "Less",
      more: "More"
    },
    providerUsage: {
      title: "Provider plans & billing",
      subtitle: "Live plan, quota, balance, and budget data reported by configured providers.",
      stalled: "Provider usage did not finish loading. Refresh to retry.",
      unavailable: "Provider usage is unavailable; the last request failed. Refresh to retry.",
      balance: "Balance",
      spend: "Usage",
      budget: "Budget",
      today: "Today",
      last7Days: "7 days",
      lastDays: "{count} days",
      dailyCost: "Daily provider cost",
      requests: "{count} requests",
      inputTokens: "{count} input",
      cacheTokens: "{count} cache",
      outputTokens: "{count} output",
      topModels: "Top models",
      costCategories: "Cost categories",
      remaining: "{percent}% left",
      resets: "Resets {date}"
    },
    presets: {},
    scope: {},
    filters: {},
    query: {},
    export: {},
    cacheStatus: {},
    empty: {},
    daily: {},
    costWindows: {},
    breakdown: {
      output: "Output",
      input: "Input",
      cacheWrite: "Cache Write",
      cacheRead: "Cache Read",
      total: "Total",
      tokensByType: "Tokens by Type",
      costByType: "Cost by Type"
    },
    overview: {
      title: "Usage Overview"
    },
    sessions: {},
    details: {
      noUsageData: "No usage data for this session.",
      duration: "Duration",
      modelMix: "Model Mix",
      filtered: "(filtered)",
      close: "Close session details",
      noTimeline: "No timeline data",
      loadFailed: "Could not load {detail}: {error}",
      noDataInRange: "No data in range",
      usageOverTime: "Usage Over Time",
      rangeStart: "Range start",
      rangeEnd: "Range end",
      reset: "Reset",
      perTurn: "Per Turn",
      cumulative: "Cumulative",
      turnRange: "Turns {start}\u2013{end} of {total}",
      assistantOutputTokens: "Assistant output tokens",
      userToolInputTokens: "User + tool input tokens",
      tokensWrittenToCache: "Tokens written to cache",
      tokensReadFromCache: "Tokens read from cache",
      noContextData: "No context data",
      contextOutOfDate: "These context details are out of date. Refresh usage and try again.",
      systemPromptBreakdown: "System Prompt Breakdown",
      collapse: "Collapse",
      collapseAll: "Collapse All",
      expandAll: "Expand All",
      baseContextPerMessage: "Base context per message",
      system: "System",
      systemShort: "Sys",
      skills: "Skills",
      tools: "Tools",
      files: "Files",
      ofInput: "of input",
      of: "of",
      timelineFiltered: "timeline filtered",
      loadedIntervalMessages: "Loaded conversation \xB7 selected interval",
      conversation: "Conversation",
      noMessages: "No messages",
      tool: "Tool",
      toolResult: "Tool result",
      hasTools: "Has tools",
      searchConversation: "Search conversation",
      filterByRole: "Filter by role",
      filterByTool: "Filter by tool",
      you: "You",
      noMessagesMatch: "No messages match the filters."
    },
    mosaic: {}
  },
  // Login copy lives in the lazy en-login catalog; the anchor keeps its merge target.
  login: {},
  chat: {
    sessionAutomation: {},
    activityPills: {},
    mobileDetails: {
      people: "People",
      outputs: "Outputs",
      generatedFiles: "Generated files"
    },
    sessionDetails: {
      automations: "Automations",
      progressOptions: "Task progress options",
      automationError: "Couldn't load automations.",
      automationUnavailable: "Automations unavailable for this session.",
      automationLoading: "Loading automations\u2026",
      automationEmpty: "No automations for this session",
      automationMore: "Load more automations",
      automationAttention: "Needs attention",
      automationPaused: "Paused",
      automationEnabled: "Enabled"
    },
    agentDatabaseWarming: "This agent is still starting. Retry in a moment.",
    historyRequestTimedOut: "Chat history request timed out. Retry to load the conversation.",
    clawhub: {
      retryStatus: "Status unavailable \xB7 Retry",
      viewDetails: "View details"
    },
    modelAccounts: {
      section: "Account",
      automatic: "Automatic (new-chat default)",
      manage: "Manage saved accounts\u2026"
    },
    mentions: {},
    cloudWorkerFailed: "Runner failed: {error}",
    errorDetails: "Error details",
    errorReplySummary: "Couldn't finish this reply. Check the conversation before trying again.",
    errorReplyTitle: "Couldn\u2019t finish this reply",
    historyUnavailableTitle: "Couldn\u2019t load this conversation",
    historyUnavailableBody: "Try again to load its messages.",
    recovery: {
      retrying: "Retrying\u2026",
      retryingIn: "Retrying in {seconds}s",
      tryingFallback: "Trying fallback model\u2026",
      failedTitle: "Unable to finish this reply",
      failedHelp: "Automatic recovery has stopped. Check any completed work before trying again.",
      tryAgain: "Try again",
      continuePrompt: "Continue from where you stopped. Check which actions already completed before retrying anything."
    },
    errorBusySummary: "OpenClaw is busy. Check status before trying again.",
    errorSignInSummary: "Couldn't sign in to the AI service. Sign in again under Models.",
    errorStartSummary: "Couldn't start this conversation. Open Settings \u2192 Logs for details.",
    checkStatus: "Check status",
    details: "Details",
    usageLimit: {},
    copyError: "Copy error",
    providerAccessRemoved: "This reply stopped because the provider was signed out. Sign in again or choose another model.",
    providerReview: {},
    providerPolicy: {},
    diskSpace: {},
    workerRuntimeInstall: {},
    sendErrors: {},
    waitingForApproval: "Waiting for approval\u2026",
    waitingOnSubagents: "Waiting on subagents",
    waitingForMessage: "Waiting for a message",
    turnElapsed: "Total time since your message, including subagent waits",
    waitingOnSubagent: "Waiting on {name}",
    subagentsRunning: "{count} subagents running",
    subagentsRunningOne: "1 subagent running",
    startupStatus: {
      preparingWorkspace: "Preparing workspace\u2026",
      namingWorktree: "Naming worktree\u2026",
      creatingWorktree: "Creating worktree\u2026",
      runningSetup: "Running setup\u2026",
      provisioningEnvironment: "Provisioning environment\u2026",
      startingFromSnapshot: "Starting from snapshot\u2026",
      preparingCloudEnvironment: "Preparing cloud environment\u2026",
      savingSnapshot: "Saving snapshot\u2026",
      preparingContext: "Preparing this turn\u2026",
      waitingForTurn: "Waiting for turn to start\u2026",
      memoryFlushing: "Saving conversation memory\u2026",
      startingModel: "Waiting for a response",
      waitingForLocalModel: "Waiting for the local model to respond",
      waitingForModelSlot: "Waiting for a free model slot",
      waitingForState: "Temporarily busy\u2014retrying\u2026"
    },
    archivedSessionDisabled: "This session is archived. Unarchive it to continue the conversation.",
    subagentViewOnly: "View-only subagent",
    subagentSessionDisabled: "Continue in {parent}.",
    processesPanel: { title: "Processes", refresh: "Refresh processes" },
    subagentsPanel: {},
    parentSession: "the parent session",
    openParentSession: "Open parent session",
    parentSessionUnavailable: "Parent session information is unavailable.",
    sessionRoute: {
      chooseTitle: "Choose a session",
      multipleMatches: "More than one session matches {shortId}.",
      additionalMatches: "Search results remain. Use a longer id prefix.",
      notFoundTitle: "Session not found",
      notFoundExplanation: "The session may have been removed, or the link may be incorrect.",
      goToMain: "Go to main session",
      viewSessions: "View sessions",
      catalogShareUnavailable: "This shared session route is unavailable.",
      catalogShareInvalid: "This {catalog} share URL is invalid."
    },
    commandResults: {
      startingNewThread: "Starting new session...",
      resettingThread: "Resetting session...",
      stoppingCurrentRun: "Stopping current run...",
      chatHistoryCleared: "Chat history cleared.",
      emptyExport: "There are no messages to export yet.",
      exportPathUnsupported: "Control UI exports Markdown through your browser. Run /export without a file path.",
      unknownCommand: "Unknown command: `{command}`",
      options: "Options: {options}.",
      sessionUnavailable: "Session capability is unavailable",
      help: {},
      compaction: {},
      model: {},
      thinking: {},
      verbose: {},
      fast: {
        autoValue: "auto ({seconds} sec)",
        on: "on",
        off: "off",
        sourceSession: " (session)",
        sourceAgent: " (default: agent)",
        sourceModel: " (default: model)",
        sourceDefault: " (default)",
        current: "Current fast mode: {value}"
      },
      usage: {},
      agents: {},
      steer: {},
      redirect: {}
    },
    sessionSharing: {
      draft: "Draft"
    },
    reactions: {},
    sessionSuggestions: {
      suggest: "Suggest",
      suggestMessage: "Suggest message",
      attachmentsUnsupported: "Remove attachments before submitting a text suggestion.",
      sendNow: "Send {author}'s suggestion now",
      queue: "Queue {author}'s suggestion",
      edit: "Edit {author}'s suggestion",
      dismiss: "Dismiss {author}'s suggestion",
      typing: "{name} is typing\u2026",
      typingMany: "{names} are typing\u2026",
      typingSeveral: "Several people are typing\u2026",
      typingOthers: "{count} others",
      otherCollaborators: "Other collaborators",
      typingDraftState: "is typing...",
      pausedDraftState: "Draft",
      state: {
        pending: "Pending",
        accepted: "Accepted",
        dismissed: "Dismissed"
      }
    },
    sessionHeader: {},
    board: {},
    catalog: {
      remoteViewOnly: "This session is on a paired device and is view-only.",
      unsupportedViewOnly: "This external session source is view-only.",
      sessionMenu: "External session actions",
      openInOpenClaw: "Open in OpenClaw",
      importToOpenClaw: "Import to OpenClaw",
      importComplete: "Imported {count} transcript items.",
      importUnchanged: "The imported transcript is up to date.",
      importIncomplete: "Imported {count} transcript items. Older history exceeded the import limit.",
      openImportedSession: "Open imported session",
      openInTerminal: "Open in terminal",
      deleteSession: "Delete",
      deleteSessionConfirm: "Delete this external session from OpenClaw? Make sure no other runner is using it. Beamed sessions are deleted permanently. Sessions kept by another tool, such as Codex, are archived there and may be restorable.",
      terminalUnavailable: "Terminal opening is unavailable for this session."
    },
    taskSuggestions: {},
    pullRequests: {
      open: "Open",
      draft: "Draft",
      merged: "Merged",
      closed: "Closed"
    },
    usageRemaining: "Usage Remaining",
    view: {},
    sendShortcut: "Send shortcut",
    sendShortcutEnter: "Enter",
    sendShortcutModifierEnter: "\u2318/Ctrl+Enter",
    followUpMode: "Follow-ups while the agent is working",
    followUpModeQueue: "Queue until the run ends",
    followUpModeServer: "Server default ({mode})",
    followUpModeLoading: "loading\u2026",
    followUpModeSteer: "Steer into the active run",
    followUpModeOverriding: "Overriding server default ({mode})",
    followUpModeReset: "Reset to server default",
    catalogOpenTarget: "Open external sessions in",
    catalogOpenTargetViewer: "OpenClaw viewer",
    catalogOpenTargetTerminal: "Terminal",
    catalogOutputTruncated: "[Output truncated]",
    onboardingDisabled: "Disabled during setup",
    commandPaletteTitle: "Search or jump to\u2026 (\u2318K)",
    openCommandPalette: "Command palette",
    updating: "Updating\u2026",
    actions: {
      copyAsMarkdown: "Copy as markdown",
      dismissError: "Dismiss error",
      exitFocusMode: "Exit focus mode",
      scrollToLatest: "Scroll to latest"
    },
    markdown: {
      truncated: "\u2026 truncated ({total} chars, showing first {shown})."
    },
    mermaid: {
      title: "Mermaid diagram",
      options: "Diagram options",
      diagram: "Show diagram",
      source: "Show source",
      copySource: "Copy source",
      expand: "Expand diagram",
      rendering: "Rendering diagram\u2026",
      error: "This diagram could not be rendered. Check the source or simplify the diagram.",
      rendererError: "The Mermaid renderer could not load or finish. Reload the dashboard; if this continues, check proxy or authentication rules for its renderer asset URLs.",
      imageError: "The diagram image could not be displayed. Reload the dashboard to try again."
    },
    codeBlock: {},
    workspaceConflict: {},
    compaction: {
      label: "Compacted history",
      savedTokens: "saved {count} tokens"
    },
    sessionReset: {
      label: "Session reset",
      description: "The earlier conversation was cleared."
    },
    outboxRecoveryReviewTitle: "Review in this chat?",
    outboxRecoveryConfirm: "Add this saved copy to \u201C{chat}\u201D for review? Nothing will be sent.",
    outboxRecoveryRestore: "Restore",
    outboxRecoveryConflict: "Keep or clear the draft and pending messages in this chat first, or open another non-Incognito chat. Your saved copy is unchanged.",
    outboxRecoveryStorageFailed: "We could not access your saved messages. Reload to try again. Do not clear browser site data if you want to keep them.",
    outboxRecoveryFull: "There are more saved messages than we can show. Review or delete the copies below to make room. The remaining messages are still saved in this browser.",
    outboxRecoveryDraft: "Draft",
    outboxRecoveryQueued: "Unsent",
    outboxRecoverySource: "from {chat}",
    outboxRecoveryUpdated: "Last updated {time}",
    outboxRecoveryGoal: "Includes an unsent goal change",
    outboxRecoveryReply: "Reply to: {text}",
    outboxRecoveryAttachments: "Attachments: {files}",
    outboxRecoveryUnconfirmedLabel: "may have been sent",
    outboxRecoveryUnconfirmed: "Delivery unconfirmed. This message may already have been sent. Check the original chat before sending it again.",
    outboxRecoveryAttachmentMissing: "An attachment could not be loaded. Review the message and reattach the file before sending.",
    outboxRecoveryDelete: "Delete",
    outboxRecoveryDeleteTitle: "Delete this saved copy?",
    outboxRecoveryDeleteConfirm: "This removes the draft and any saved messages or attachments shown with it from this browser. It cannot be undone. Messages already sent to a chat will not be deleted.",
    outboxRecoveryDeleteConflict: "This saved copy changed while you were reviewing it. Nothing was deleted. Reload and review it again.",
    privateDraftReload: {
      blocked: "An unsent Incognito draft is keeping this tab open. Review it before refreshing.",
      review: "Review private draft",
      title: "Unsent Incognito draft",
      description: "This draft stays only in this tab. Copy its text or download its attachments before discarding it to refresh. Keeping this tab open leaves the draft unchanged.",
      text: "Draft text",
      copy: "Copy text",
      goal: "This draft includes an unsent goal change.",
      reading: "Some attachments are still being read. Keep this tab open, then review the draft again when they finish.",
      changed: "The draft changed while you were reviewing it. It has not been discarded; review the current draft before refreshing.",
      copyFailed: "The text could not be copied. Select it in the draft field and copy it manually.",
      attachmentUnavailable: "This attachment is no longer available to download. Keep the draft open and recover the original file before discarding it.",
      download: "Download {name}",
      discard: "Discard this draft and refresh",
      keep: "Keep in this tab",
      unavailable: "The private draft could not be opened. It remains in this tab; try Review private draft again."
    },
    incognitoExpiredTitle: "Incognito session expired",
    incognitoExpiredBody: "Incognito sessions last for 24 hours or until the Gateway restarts. Your unsent input stays in this tab.",
    newIncognitoSession: "New Incognito session",
    restartRecoveryTitle: "This task was interrupted by a restart.",
    restartRecoveryDisabled: "Your transcript is safe. Resume to continue in this session.",
    restartRecoveryNewSession: "This provider cannot safely resume tool work here. Your transcript can continue in a new session.",
    resumeSession: "Resume",
    resumeInNewSession: "Resume in new session",
    resumingSession: "Resuming\u2026",
    systemNotice: {
      event: "{count} system event",
      events: "{count} system events",
      updatesNotDelivered: "Updates not delivered",
      guardian: {
        approvedSummary: "Guardian approved {action}.",
        deniedLabel: "Guardian denied",
        deniedSummary: `{action} \xB7 risk: {risk}

{rationale}`,
        warningLabel: "Guardian warning",
        warningFallback: "Guardian stopped the requested action.",
        strictReviewRequiredLabel: "Guardian review required",
        strictReviewRequiredSummary: "Guardian is reviewing this action before it can continue.",
        requestedAction: "Requested action",
        unknownRisk: "unknown",
        noRationale: "No rationale was provided."
      },
      restartRecovery: {
        label: "System \xB7 restart recovery",
        interrupted: "The Gateway restarted. Automatic recovery was interrupted before the agent could resume. Send a message to continue.",
        cancelled: "The Gateway restarted. Automatic recovery was cancelled before the agent could resume. Send a message to continue."
      },
      automationRecovery: {
        label: "System \xB7 automation recovery",
        summary: "An automation failed \u2014 asked the agent to investigate and continue if needed."
      },
      gatewayRestarted: {
        label: "System \xB7 gateway restarted"
      },
      cliHarnessContext: {
        label: "System \xB7 injected context"
      },
      claudeCliTaskNotification: {
        label: "System \xB7 background task"
      },
      pluginSteering: {
        label: "{plugin} guidance"
      }
    },
    skillLearned: {},
    progressLabels: {
      shelling: "Shelling",
      scuttling: "Scuttling",
      clawing: "Clawing",
      pinching: "Pinching",
      molting: "Molting",
      bubbling: "Bubbling",
      tiding: "Tiding",
      reefing: "Reefing",
      cracking: "Cracking",
      sifting: "Sifting",
      brining: "Brining",
      nautiling: "Nautiling",
      krilling: "Krilling",
      barnacling: "Barnacling",
      lobstering: "Lobstering",
      tidepooling: "Tidepooling",
      pearling: "Pearling",
      snapping: "Snapping",
      surfacing: "Surfacing"
    },
    turnRecap: {
      doneIn: "Done in {duration}",
      tokens: "{count} output tokens",
      tokensOne: "1 output token"
    },
    commands: {},
    skills: {
      menu: "Skill references",
      label: "Skills",
      loading: "Loading skills\u2026"
    },
    splitView: {
      chooseConversation: "Choose a conversation",
      missingOwner: "Select this pane, then choose Home or a conversation in the sidebar to restore it.",
      open: "Open split view",
      splitRight: "Split right",
      splitDown: "Split down",
      closePane: "Close pane",
      panePosition: "Column {column}, row {row} ({pane})",
      dropSplit: "Split",
      dropOpenHere: "Open here"
    },
    sidebar: {
      mySessions: "My sessions",
      updateMacAndGateway: "Update Mac app + Gateway",
      updateGateway: "Update Gateway",
      serverUpdatedTitle: "Server updated",
      serverUpdatedRefresh: "Refresh for full capabilities",
      threads: "Sessions",
      otherSessions: "Other",
      groups: "Groups",
      coding: "Coding",
      catalogViewOptions: "View options",
      reorderItem: "Reorder {item}",
      moveUp: "Move up",
      moveDown: "Move down",
      hideFromSidebar: "Hide from sidebar",
      sectionHidden: "{section} hidden.",
      sectionHiddenRecovery: "Show it again in Settings > Appearance > Sidebar.",
      hiddenSessionSections: "Hidden session sections",
      showSessionSection: "Show",
      catalogGroupByProject: "Project",
      catalogGroupByPerson: "Person",
      openSessionMenu: "Open session menu",
      sortBy: "Sort by",
      sortCreated: "Created",
      menuFilters: "Filters",
      menuDisplay: "Display",
      hideEmpty: "Hide empty",
      activeFilterCount: "Active filters: {count}",
      sortSessions: "Filter & sort",
      sessionSources: "Session sources",
      showAllSessions: "Show all sessions",
      noActiveSessionsForFilter: "No active sessions match this filter",
      sortUpdated: "Last updated",
      sessionMenu: "Actions for {session}",
      sessionMenuMany: "Actions for {count} sessions",
      catalogDiscoveryHelp: "{error}. Configure automatic session discovery in Settings > Appearance > Session sources.",
      catalogPaginationFailed: "Session catalog returned a repeated page cursor",
      catalogPageMissingHost: "Session catalog page did not include the requested host"
    },
    welcome: { suggestions: { whatCanYouDo: "What can you do?" } },
    runControls: {
      newSession: "New session",
      newSessionWorktree: "New session in worktree",
      exportChat: "Export chat",
      queue: "Queue",
      queueMessage: "Queue message",
      stop: "Stop",
      stopWithShortcut: "Stop (Esc)",
      stopGenerating: "Stop generating",
      send: "Send",
      sendMessage: "Send message"
    },
    queue: {},
    goals: {},
    asyncQuestions: {},
    questions: {
      showSecret: "Show secret",
      hideSecret: "Hide secret",
      resourcePreview: "Preview resource",
      addResources: "Add resources",
      resourceUploadTooLarge: "Selected resources exceed the upload limits.",
      other: "Type your own answer here",
      multilineHint: "Enter adds a line \xB7 {shortcut} to continue",
      answer: "Answer",
      answerPlaceholder: "{label}",
      openLink: "Open link",
      externalStepHint: "Complete the step in the new tab, then return here to submit your answer.",
      submit: "Submit",
      next: "Next",
      back: "Back",
      skip: "Skip",
      skipping: "Skipping\u2026",
      skipped: "Skipped",
      collapse: "Collapse question",
      expand: "Expand question",
      eyebrow: "Waiting for your answer",
      summaryLabel: "Question outcome",
      ownAnswerFor: "Your own answer for {header}",
      storeRequestedBy: "Requested by {agent} \xB7 {session}",
      storeEntry: "Stores {name} as {kind}",
      storeReplacement: "Replaces {name} \u2014 last updated {updated}",
      storeReplacementBy: "Replaces {name} \u2014 last updated {updated} by {updatedBy}",
      submitting: "Submitting\u2026",
      submitFailed: "Could not submit: {error}",
      answered: "Answered",
      answeredElsewhere: "Answered elsewhere",
      unavailable: "Unavailable",
      expired: "Expired",
      disconnected: "Not connected. Try again after reconnecting.",
      loadFailed: "Could not load this question. Try again."
    },
    imageLightbox: {
      loadingDetail: "Loading sharper image\u2026",
      detailFailed: "Preview shown. Sharper image could not load.",
      actions: "Image actions",
      previous: "Previous image",
      next: "Next image",
      position: "{current} / {total}",
      label: "Image preview: {title}",
      open: "Open image {title}",
      openOriginal: "Open in new tab",
      copy: "Copy image",
      download: "Download image",
      copyFailed: "Could not copy this image. Check clipboard access and try again.",
      downloadFailed: "Could not download this image. Try again.",
      loadFailed: "Could not load this image. Try again.",
      zoomIn: "Zoom in",
      zoomOut: "Zoom out",
      resetZoom: "Reset zoom",
      close: "Close image preview",
      untitled: "Image"
    },
    externalImage: { notLoaded: "External image not loaded", open: "Open image" },
    messages: {
      copySelection: "Copy",
      replyingTo: "Replying to {name}",
      message: "message",
      showLess: "Show less",
      showMore: "Show more",
      tooLargeToDisplay: "This message is too large to display here.",
      unattributedSender: "Message",
      toolSender: "Tool",
      errorSender: "Error"
    },
    mediaPlayer: {
      play: "Play",
      pause: "Pause",
      seek: "Seek media",
      mute: "Mute",
      unmute: "Unmute",
      volume: "Volume",
      download: "Download {filename}",
      preparing: "Preparing playback\u2026",
      openVideo: "Expand {filename} in the media overlay",
      videoPreview: "Video preview: {title}",
      closeVideoPreview: "Close video preview"
    },
    youtube: {},
    modelControls: {},
    nativeRuntimeRecovery: {},
    permissionControls: {},
    rail: {},
    detailPanel: {},
    sidebarColumns: {
      close: "Close {panel}"
    },
    sidePanel: {
      label: "Side panel",
      quickAccess: "Quick access",
      explorePanels: "Explore panels",
      addTab: "Add side panel tab",
      closeNewTab: "Close New tab",
      closeAll: "Close all",
      closeAllTabs: "Close all tabs",
      closeOtherTabs: "Close other tabs",
      closeFileChanges: "Save changes to {file} before closing?",
      reviewFileChanges: "Open the file to review its unsaved changes before closing.",
      expand: "Focus",
      expandPanel: "Expand {panel}",
      restore: "Restore split",
      useViewAsDefault: "Use current view as default",
      currentViewIsDefault: "This is the default view",
      defaultViewDescription: "Used when anyone opens this dashboard. Personal layout choices still apply.",
      savingDefault: "Saving default\u2026",
      defaultSaved: "Dashboard default saved for future opens.",
      defaultSaveFailed: "Could not save the dashboard default. Check the connection and try again.",
      defaultSaveError: "Could not save the dashboard default: {error}",
      swap: "Swap {main} and {side}",
      layout: "Layout",
      panelPosition: "Panel position",
      dockLeft: "Move side panel left",
      dockRight: "Move side panel right",
      dockBottom: "Move side panel below",
      positionLeft: "Left",
      positionRight: "Right",
      positionBelow: "Below",
      conversation: "Chat",
      showChat: "Show this conversation",
      hideChat: "Hide this conversation",
      conversationEmpty: "The conversation for this task.",
      minimize: "Minimize side panel",
      resize: "Resize side panel",
      review: "Review",
      reviewEmpty: "Open a change, file, image, or tool result to review it here.",
      terminal: "Terminal",
      terminalEmpty: "Open a shell for this session's workspace.",
      browser: "Browser",
      browserEmpty: "A shared browser for you and the agent.",
      browserUnavailableReason: {
        permission: "You need operator.admin to use Browser.",
        disconnected: "Disconnected.",
        unavailable: "Browser unavailable."
      },
      files: "Files",
      filesEmpty: "Browse files, artifacts, and changes from this session.",
      companion: "Side chat",
      companionEmpty: "Ask a focused question about this session.",
      processes: "Processes",
      processesEmpty: "Inspect background commands and their output for this conversation.",
      subagents: "Subagents",
      subagentsEmpty: "Follow delegated work from this conversation.",
      desktop: "Desktop",
      desktopEmpty: "Connect to an available remote desktop.",
      portal: "Portal",
      portalEmpty: "Preview a web application running for this task.",
      discussion: "Discussion",
      discussionEmpty: "Open the shared discussion for this session.",
      dashboard: "Dashboard",
      dashboardOptions: "Dashboard options",
      dashboardSize: "Size",
      dashboardEmpty: "This task does not have a dashboard yet."
    },
    thread: {},
    pendingInputs: {
      agentUpdate: {
        cancelled: "This agent update was cancelled before delivery.",
        interrupted: "Delivery interrupted. This saved agent update is not scheduled to retry."
      },
      waitingForWorkspaceSync: "Received \xB7 waiting for workspace sync",
      waitingForWorkerSetup: "Received \xB7 waiting for worker setup",
      cancelled: "Cancelled before the agent started it. It will not run automatically; copy it and send again.",
      interrupted: "Interrupted before the agent started it. If it does not resume, copy it and send again.",
      earlier: "Show earlier messages",
      latest: "Show latest messages"
    },
    pairingQrExpired: {
      title: "Pairing QR expired",
      reason: "Run /pair qr again to generate a fresh setup code.",
      badge: "Expired"
    },
    composer: {},
    attachments: {
      allowImage: "Allow image",
      attachedFile: "Attached file",
      audio: "Audio",
      download: "Download",
      expand: "Open {filename} in the side panel",
      open: "Open",
      previewUnavailable: "Preview unavailable",
      textPreviewUnavailable: "Could not preview this file. Text previews require UTF-8 files up to 256 KiB. Download it to read the full file.",
      htmlPreviewUnavailable: "Could not preview this HTML file. HTML previews require UTF-8 files up to 2 MiB. Download it to read the full file.",
      readFailed: "Could not attach file. Try again.",
      imagesOnly: "Side chat accepts image attachments only.",
      tooLarge: "Too large to send: {names}{more}",
      tooLargeToast: "File too large. Try a smaller file.",
      openOriginal: "Open original",
      compressToFit: "Compress to fit",
      compressionHint: "Video is too large. Compress a copy on this device; the original stays unchanged.",
      compressing: "Compressing\u2026 {progress}%",
      compressionUnsupported: "This browser cannot compress this video.",
      compressionTooLarge: "Video is still too large. Try a smaller file.",
      compressionFailed: "Could not compress video. Try again.",
      showInTextField: "Show in text field",
      pastedText: "Pasted text",
      outsideAllowedFolders: "Outside allowed folders",
      unavailable: "Unavailable",
      failureDeliveryFailed: "Delivery failed. Try sending this file again.",
      failureInvalidReference: "Use a public HTTPS URL without credentials or attach a local file by a safe path.",
      failureFileNotFound: "File not found. Check the path and try again.",
      failureUnsupportedFormat: "Rejected by the local attachment allowlist. Send a supported file type.",
      history: "History",
      image: "Image",
      notSent: "Not sent",
      omittedFromHistory: "Omitted from history",
      omittedFromHistoryWithSize: "Omitted from history \xB7 {size}",
      video: "Video"
    },
    voice: {},
    selectors: {
      loadMoreSessions: "Show more",
      loadMoreRosterSessions: "Load more sessions",
      model: "Chat model",
      modelSection: "Model",
      modelLocked: "Locked",
      modelLockedLabel: "Model selection controlled for this session",
      lockedSessionModel: "Session model",
      thinkingLevel: "Chat thinking level"
    },
    permissions: {},
    toolCards: {
      tool: "Tool",
      canvas: "Canvas",
      summary: "Summary",
      toolInput: "Tool input",
      toolOutput: "Tool output",
      providerResponse: "Provider tool response",
      executionOutput: "Execution output",
      showFullOutput: "Show full output",
      fullOutputUnavailable: "Full output unavailable. Only the captured output is shown.",
      copyOutput: "Copy available output",
      downloadOutput: "Download available output",
      outputLoadFailed: "Could not load the full output. Try again.",
      outputDownloadFailed: "Could not download the output. Try again.",
      toolError: "Tool error",
      rawDetails: "Raw details",
      activity: {
        titleOne: "1 operation",
        titleMany: "{count} operations",
        commandsOne: "1 command",
        commandsMany: "{count} commands",
        readsOne: "1 read",
        readsMany: "{count} reads",
        editsOne: "1 edit",
        editsMany: "{count} edits",
        writesOne: "1 write",
        writesMany: "{count} writes",
        searchesOne: "1 search",
        searchesMany: "{count} searches",
        fetchesOne: "1 fetch",
        fetchesMany: "{count} fetches",
        otherOne: "1 other operation",
        otherMany: "{count} other operations",
        subagentsOne: "1 subagent",
        subagentsMany: "{count} subagents",
        failed: "{count} failed",
        blocked: "{count} blocked",
        unknown: "{count} unknown"
      },
      showRawDetails: "Show raw details",
      hideRawDetails: "Hide raw details",
      viewMode: "Tool detail view",
      diff: "Diff",
      raw: "Raw",
      openFile: "Open file",
      openDetails: "Open tool details in side panel",
      widgetActions: "Widget actions",
      copyToClipboard: "Copy to clipboard",
      downloadFile: "Download file",
      copyAsImage: "Copy as image",
      downloadAsImage: "Download as image",
      widgetExportRerender: "This widget needs to be re-rendered to export as an image.",
      widgetExportHtmlFallback: "Image unavailable. Downloaded the widget as HTML instead.",
      widgetExportFailed: "Widget export failed. Try again.",
      pinToDashboard: "Pin to dashboard",
      pinToDashboardPending: "Pinning\u2026",
      pinToDashboardFailed: "Could not pin to dashboard. Try again.",
      pinnedToDashboard: "Pinned",
      fileChanges: "File changes",
      attemptedChanges: "Attempted changes",
      failed: "failed",
      skipped: "Skipped",
      skippedCount: "{count} skipped",
      running: "Running",
      subagentRunning: "running",
      subagentStopped: "stopped",
      openSubagent: "Open subagent session",
      completed: "Completed",
      blocked: "Blocked",
      outcomeUnknown: "Outcome unknown",
      exitCode: "Exit code {code}",
      failureCount: "{count} failed",
      noOutputFailed: "No output \u2014 tool failed.",
      noOutputSucceeded: "No output \u2014 tool completed successfully.",
      noResult: "No result available.",
      review: {
        reviewing: "{reviewer} reviewing",
        approved: "{reviewer} approved",
        denied: "{reviewer} denied",
        timedOut: "{reviewer} timed out",
        aborted: "{reviewer} stopped",
        risk: "{level} risk",
        authorization: "{level} authorization",
        noRationale: "No rationale was provided."
      },
      verbs: {
        read: "Read",
        edit: "Edit",
        editing: "Editing",
        edited: "Edited",
        create: "Create",
        creating: "Creating",
        created: "Created",
        delete: "Delete",
        deleting: "Deleting",
        deleted: "Deleted",
        change: "Change",
        changing: "Changing",
        changed: "Changed",
        write: "Write",
        writing: "Writing",
        wrote: "Wrote",
        searched: "Searched",
        fetched: "Fetched"
      }
    },
    workRun: {
      workedFor: "Worked for {duration}",
      worked: "Worked",
      toolCallsOne: "1 tool call",
      toolCallsMany: "{count} tool calls"
    },
    sessionDiff: {
      title: "Changes",
      show: "Show session changes"
    },
    sessionDiscussion: {},
    workspaceFiles: {
      copyPath: "Copy path"
    }
  },
  languages: {
    en: "English",
    zhCN: "\u7B80\u4F53\u4E2D\u6587 (Simplified Chinese)",
    zhTW: "\u7E41\u9AD4\u4E2D\u6587 (Traditional Chinese)",
    ptBR: "Portugu\xEAs (Brazilian Portuguese)",
    de: "Deutsch (German)",
    es: "Espa\xF1ol (Spanish)",
    jaJP: "\u65E5\u672C\u8A9E (Japanese)",
    ko: "\uD55C\uAD6D\uC5B4 (Korean)",
    fr: "Fran\xE7ais (French)",
    hi: "\u0939\u093F\u0928\u094D\u0926\u0940 (Hindi)",
    ar: "\u0627\u0644\u0639\u0631\u0628\u064A\u0629 (Arabic)",
    it: "Italiano (Italian)",
    tr: "T\xFCrk\xE7e (Turkish)",
    uk: "\u0423\u043A\u0440\u0430\u0457\u043D\u0441\u044C\u043A\u0430 (Ukrainian)",
    id: "Bahasa Indonesia (Indonesian)",
    pl: "Polski (Polish)",
    th: "\u0E44\u0E17\u0E22 (Thai)",
    vi: "Ti\u1EBFng Vi\u1EC7t (Vietnamese)",
    nl: "Nederlands (Dutch)",
    fa: "\u0641\u0627\u0631\u0633\u06CC (Persian)",
    ru: "\u0420\u0443\u0441\u0441\u043A\u0438\u0439 (Russian)",
    sv: "Svenska (Swedish)"
  },
  // Navigation and in-chat secret requests render before the Secrets page loads.
  secretsStore: {
    allowedHosts: "Allowed hosts",
    allowedHostsPlaceholder: "api.example.com",
    protectedSecret: "Protected secret",
    agentReadable: "Agent-readable environment",
    hint: "Choose protected, write-only secrets or intentionally agent-readable Gateway environment values."
  },
  cron: {
    adminRequired: "Browsing only. Automation changes require operator.admin access.",
    tabs: {},
    list: {},
    suggestions: {},
    stats: {},
    detail: {},
    actions: {},
    // Shared cron actions report outcomes before the automation page loads.
    runNotStarted: {
      notDue: "This automation is not due yet.",
      alreadyRunning: "This automation is already running.",
      recoveryPending: "Scheduler recovery is still in progress.",
      invalidSpec: "This automation has an invalid schedule or payload.",
      stopped: "The scheduler is stopped.",
      unknown: "This automation could not be started."
    },
    jobs: {},
    runs: {},
    form: {},
    jobState: {},
    runEntry: {},
    errors: {
      nameRequired: "Name is required.",
      activeHoursTime: "Enter HH:MM (24:00 is allowed only for the end).",
      activeHoursTimezone: "Enter a valid IANA timezone, local, or user.",
      scheduleAtInvalid: "Enter a valid date/time.",
      everyAmountInvalid: "Interval must be greater than 0.",
      triggerIntervalTooShort: "Condition-triggered automations must run at least every 30 seconds.",
      cronExprRequired: "Cron expression is required.",
      staggerAmountInvalid: "Stagger must be greater than 0.",
      triggerScriptRequired: "Trigger script is required when the condition trigger is enabled.",
      triggerScriptPayloadUnsupported: "Script payloads cannot use condition triggers because both own the same saved state.",
      triggerScheduleUnsupported: "Condition triggers require an interval, cron, or stream schedule.",
      systemTextRequired: "System text is required.",
      agentMessageRequired: "Agent message is required.",
      timeoutInvalid: "If set, timeout must be 0 or greater (0 disables this timeout).",
      deliveryModeRequired: "Choose a delivery mode explicitly, or run openclaw doctor --fix to repair legacy settings.",
      webhookUrlRequired: "Webhook URL is required.",
      webhookUrlInvalid: "Webhook URL must be a valid http(s):// URL without embedded credentials.",
      invalidRunTime: "Invalid run time.",
      invalidIntervalAmount: "Invalid interval amount.",
      cronExprRequiredShort: "Cron expression required.",
      invalidStaggerAmount: "Invalid stagger amount.",
      systemEventTextRequired: "System event text required.",
      agentMessageRequiredShort: "Agent message required.",
      nameRequiredShort: "Name required."
    }
  },
  linkReader: {
    loadingPreview: "Loading preview\u2026",
    title: "Link reader",
    urlPlaceholder: "Supported link URL"
  }
};

// openclaw/ui/src/api/gateway-connect-plan.ts
Sn();

// openclaw/ui/src/i18n/locales/en-browser.ts
var Ko = {
  browser: {
    address: "Page address",
    go: "Go",
    actions: "Browser actions",
    navigation: "Browser navigation",
    loadFailed: "Couldn\u2019t load browser",
    newBrowserTab: "New browser tab",
    unavailable: "Browser control is unavailable for this connection. Reconnect with browser access.",
    navigationBlocked: "The current browser navigation rules block this address. Select another tab or enter an allowed address.",
    navigationCheckFailed: "OpenClaw couldn\u2019t verify this tab\u2019s address. Refresh to try again.",
    tabUnavailable: "This tab is no longer available. Select another tab.",
    noChatTarget: "Open a chat session first so the annotation has somewhere to go.",
    annotationLimitReached: "Remove a browser annotation before retrying (maximum 4 cards and 8,000 characters of generated context).",
    inspectUnavailable: "Element inspection is disabled (browser.evaluateEnabled=false).",
    annotationSent: "Annotation added to the chat composer.",
    dashboardSessionShared: "You and your agent share this isolated session browser",
    dashboardShared: "You and your agent share this browser page",
    dashboardStopped: "This dashboard's browser is stopped.",
    dashboardStopping: "Browser stop is pending. Retry to finish closing its tab.",
    dashboardStop: "Stop browser",
    dashboardRetryStop: "Retry stop",
    dashboardResume: "Resume browser",
    dashboardReconnect: "Reconnect",
    dashboardUnavailable: "Connect to a Gateway with browser access to use this dashboard.",
    dashboardMissingIdentity: "Save this dashboard widget again before opening its browser.",
    dashboardInvalidReply: "The browser response does not match this dashboard. Reconnect and try again.",
    downloading: "Downloading\u2026",
    downloadFile: "Download file",
    inputLabel: "Browser input: click a field in the page, then type or paste",
    manualTextCorrection: "Autocorrect is unavailable in browser control. Edit the text directly.",
    errors: {
      pasteFailed: "Could not paste. Reconnect to a managed browser and try again.",
      requestFailed: "Browser request failed: {error}",
      downloadFailed: "Could not download this file: {error}. Try again, or open it in your browser to save it.",
      downloadEmpty: "No file returned.",
      screenshotPathMissing: "Browser screenshot did not return a media path.",
      screenshotFetchTimedOut: "Screenshot fetch timed out.",
      screenshotFetchFailed: "Screenshot fetch failed ({status}).",
      screenshotReadFailed: "Screenshot read failed.",
      screenshotDecodeFailed: "Screenshot decode failed.",
      canvasUnavailable: "Canvas 2D context unavailable."
    },
    annotatePrompt: {
      browserTarget: "Browser target: {target}",
      // introTitled/elementDetail (not intro/element): translated keys never
      // retranslate on source-wording changes, so the provenance-label rewrite
      // required fresh key names to propagate to all locales.
      introTitled: 'I annotated the page at {url} (page-reported title: "{title}") \u2014 the attached screenshot shows my markup.',
      introUntitled: "I annotated the page at {url} \u2014 the attached screenshot shows my markup.",
      region: "Marked region {index}: centered around {x}% across / {y}% down, spanning about {width}% \xD7 {height}% of the view.",
      moreRegions: "\u2026plus {count} more marked region(s), all visible in the screenshot.",
      elementDetail: "Marked element (page-reported): {descriptor} \u2014 {width}\xD7{height}px at ({x}, {y}).",
      outro: "Please look at the marked area and tell me what you make of it."
    }
  }
}, Vo = Object.assign(
  () => {
    let { errors: e, annotatePrompt: t, ...n } = Ko.browser;
    Object.assign(Je.browser, n), Object.assign(Je.browser.errors, e), Object.assign(Je.browser.annotatePrompt, t);
  },
  { catalog: Ko }
);

// openclaw/ui/src/components/browser/browser-inspect-script.ts
var Xc = String.raw`function openclawInspectBrowserElement(x, y) {
  const el = document.elementFromPoint(x, y);
  if (!el) return null;
  const rect = el.getBoundingClientRect();
  const label = el.getAttribute("aria-label") || el.getAttribute("alt") || el.getAttribute("title") || "";
  const text = (el.textContent || "").replace(/\s+/g, " ").trim();
  const nameSource = label || text;
  const nameLimit = 120;
  // This serialized page function cannot call imported helpers; back up only when the cap splits a surrogate pair.
  const nameEnd = (nameSource.codePointAt(nameLimit - 1) || 0) > 0xffff ? nameLimit - 1 : nameLimit;
  return {
    tag: el.tagName.toLowerCase(),
    id: el.id || "",
    classes: Array.from(el.classList).slice(0, 6),
    role: el.getAttribute("role") || "",
    name: nameSource.slice(0, nameEnd),
    rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
    focusable: typeof el.tabIndex === "number" && el.tabIndex >= 0,
  };
}`;

// openclaw/ui/src/components/browser/browser-target.ts
N();
function En(e, t = 128) {
  return typeof e == "string" && e.length > 0 && e.length <= t && e.trim() === e;
}
function Tn(e) {
  let t = G(e);
  if (!En(t?.targetId) || !En(t.profile))
    return;
  let n = { targetId: t.targetId, profile: t.profile };
  if (t.target === "host" && t.node === void 0)
    return { ...n, target: "host" };
  if (t.target === "node" && En(t.node, 256))
    return { ...n, target: "node", node: t.node };
}
function Yo(e) {
  return JSON.stringify([e.target, e.node, e.profile, e.targetId]);
}

// openclaw/ui/src/components/browser/browser-client.ts
Vo();

// openclaw/ui/src/lib/chat/tool-cards.ts
Sr();

// openclaw/packages/net-policy/src/url-protocol.ts
function el(e) {
  return e instanceof URL ? e : URL.parse(e);
}
function Zo(e) {
  let t = el(e);
  return t?.protocol === "http:" || t?.protocol === "https:";
}

// openclaw/ui/src/lib/chat/tool-cards.ts
X();
N();
B();
Oe();

// openclaw/src/agents/tool-display-call.ts
N();

// openclaw/src/chat/canvas-render.ts
X();
ae();
N();
B();

// openclaw/src/shared/text/code-regions.ts
X();

// openclaw/packages/markdown-core/src/reasoning-tag-parser.ts
X();
var Jo = [
  "think",
  "thinking",
  "thought",
  "reasoning",
  "internal",
  "antthinking",
  "antml:think",
  "antml:thinking",
  "antml:thought",
  "antml:reasoning",
  "mm:think",
  "mm:thinking",
  "mm:thought",
  "mm:reasoning"
], $y = new Set(Jo);

// openclaw/src/chat/canvas-render.ts
function nl(e) {
  let t = U(e?.viewId);
  if (!t || t.length > 128)
    return;
  let n = U(e?.serverName), o = U(e?.toolName), r = U(e?.uiResourceUri), i = U(e?.toolCallId), s = U(e?.originSessionKey), c = e?.resultMetaState === "unavailable" ? "unavailable" : void 0;
  return !!(n && n.length <= 256 && o && o.length <= 256 && r?.startsWith("ui://") && r.length <= 2048 && i && i.length <= 512) ? {
    viewId: t,
    serverName: n,
    toolName: o,
    uiResourceUri: r,
    toolCallId: i,
    ...s && s.length <= 512 ? { originSessionKey: s } : {},
    ...c ? { resultMetaState: c } : {}
  } : { viewId: t };
}
function rl(e) {
  return typeof e == "number" && Number.isFinite(e) && e >= 160 ? Math.min(Math.trunc(e), 1200) : void 0;
}
function ei(e) {
  return typeof e == "string" && /^[a-z0-9][a-z0-9._-]{0,63}$/u.test(e);
}
function ti(e) {
  let t = $(e);
  if (!t || U(t?.kind)?.trim().toLowerCase() !== "canvas")
    return;
  let o = $(t.presentation), r = $(t.view), i = $(t.source), s = nl($(t.mcpApp)), c = s?.viewId, p = U(o?.target) ?? U(t?.target) ?? "assistant_message";
  if (p !== "assistant_message" && p !== "node_panel")
    return;
  let g = U(o?.title) ?? U(r?.title), f = rl(
    se(o?.preferred_height) ?? se(o?.preferredHeight) ?? se(r?.preferred_height) ?? se(r?.preferredHeight)
  ), m = U(o?.class_name) ?? U(o?.className), l = U(o?.style), d = U(o?.sandbox), y = U(r?.url) ?? U(r?.entryUrl), h = U(r?.id) ?? U(r?.docId), b = U(r?.boardWidgetName), w = ei(b) ? b : void 0, R = {
    kind: "canvas",
    surface: p,
    render: "url",
    ...g ? { title: g } : {},
    ...f ? { preferredHeight: f } : {},
    ...d === "strict" || d === "scripts" ? { sandbox: d } : {},
    ...s ? { mcpApp: s } : {}
  };
  if (c && h === c)
    return { ...R, viewId: h };
  let S = y ?? (U(i?.type)?.trim().toLowerCase() === "url" ? U(i?.url) : void 0);
  if (S)
    return {
      ...R,
      url: S,
      ...y && h ? { viewId: h } : {},
      ...m ? { className: m } : {},
      ...l ? { style: l } : {},
      ...y && w ? { boardWidgetName: w } : {}
    };
}
function ni(e) {
  let t = $(e);
  return ti(t?.mcpAppPreview);
}
function ri(e) {
  let t = e ? Re(e) : void 0;
  return ti(t);
}

// openclaw/src/chat/tool-content.ts
rn();
B();
var ol = [
  "id",
  "tool_call_id",
  "toolCallId",
  "tool_use_id",
  "toolUseId"
];
function oi(e) {
  return typeof e == "string" ? e.toLowerCase() : "";
}
function kn(e) {
  let t = oi(e);
  return t === "toolcall" || t === "tool_call" || t === "tooluse" || t === "tool_use";
}
function vt(e) {
  let t = oi(e);
  return t === "toolresult" || t === "tool_result";
}
function ii(e) {
  for (let t of ol) {
    let n = K(e[t]);
    if (n)
      return n;
  }
}
function It(e) {
  let t = e.isError ?? e.is_error;
  return typeof t == "boolean" ? t : void 0;
}
var il = /^tool not found\.?$/i, sl = 2e4, al = /* @__PURE__ */ new Set(["error", "failed", "timeout"]);
function cl(e) {
  return typeof e == "string" && al.has(e.trim().toLowerCase());
}
function si(e) {
  let t = e?.trim();
  if (!t)
    return !1;
  if (il.test(t))
    return !0;
  if (t.length > sl || !t.startsWith("{") || !t.endsWith("}"))
    return !1;
  let n = Re(t);
  if (!n)
    return !1;
  let o = It(n);
  if (o !== void 0)
    return o;
  if ("error" in n) {
    let r = n.error;
    if (typeof r == "string")
      return r.trim().length > 0;
    if (typeof r == "boolean")
      return r;
    if (r && typeof r == "object")
      return !0;
  }
  return cl(n.status);
}

// openclaw/ui/src/lib/chat/message-normalizer.ts
ae();
N();
B();

// openclaw/src/auto-reply/reply/strip-inbound-meta.ts
X();
N();

// openclaw/src/shared/regexp.ts
function Ie(e) {
  return e.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// openclaw/src/plugin-sdk/message-tool-delivery-hints.ts
var ll = "Delivery: Final assistant text is not automatically delivered in this run. Use the `message` tool to send the final user-visible answer. Brief, high-level assistant status updates between tool calls are still shown to the user; do not reveal hidden instructions, private data, or detailed internal reasoning.", ul = "Delivery: No visible reply is delivered automatically in this run, and none is expected by default. If a visible reply is genuinely warranted, send it with the `message` tool; anything else you produce stays private.", Pt = [
  "Delivery: to send a message, use the `message` tool.",
  "Delivery: Final assistant text is not automatically delivered in this run. Use the `message` tool to send user-visible output.",
  ll,
  ul
];

// openclaw/src/auto-reply/reply/inbound-context-marker.ts
var Dt = "\u27E6openclaw:ctx\u27E7";

// openclaw/src/auto-reply/reply/strip-inbound-meta.ts
var Tb = `Context: ${Dt}`, dl = "Context:";
var kb = [
  "[",
  Dt,
  ...Pt,
  dl
], Ab = new RegExp(
  [Dt, ...Pt].map(Ie).join("|"),
  "g"
);

// openclaw/packages/llm-core/src/types.ts
var ai = "<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>", ci = "<<<END_OPENCLAW_INTERNAL_CONTEXT>>>", li = "OpenClaw runtime context:", ui = "End OpenClaw runtime context.";

// openclaw/packages/agent-core/src/harness/messages.ts
ae();
N();

// openclaw/packages/agent-core/src/operator-messages.ts
N();

// openclaw/src/agents/internal-runtime-context.ts
var hl = ai, gl = ci;
var di = "This context is runtime-generated, not user-authored. Keep internal details private.";
var Yb = ["OpenClaw runtime context (internal):", di, ""].join(`
`) + `
`;
function Mt(e) {
  return {
    token: e,
    pattern: new RegExp(`(?:^|\\r?\\n)[ \\t]*${Ie(e)}[ \\t]*(?=\\r?\\n|$)`, "g")
  };
}
var Zb = Mt(hl), Jb = Mt(gl), Xb = Mt(li), Qb = Mt(ui);
var ml = [
  "OpenClaw runtime context for the active user request in this turn. Do not reply to or describe this context. Use it to continue answering the active user request now. Do not wait for another message.",
  "OpenClaw runtime context for the immediately preceding user message.",
  "OpenClaw runtime event."
], yl = new RegExp(
  ml.flatMap((e) => {
    let t = e.split(". ");
    return t.map((n, o) => t.slice(o).join(". "));
  }).map((e) => e.split(/\s+/).map(Ie).join("\\s+")).join("|")
), bl = new RegExp(
  di.split(/\s+/).map(Ie).join("\\s+")
), ew = new RegExp(
  `^[ \\t]*(?:${yl.source})\\s+${bl.source}[ \\t]*(?:\\r?\\n|$)`,
  "gm"
);

// openclaw/src/chat/message-client-source.ts
N();
B();
Oe();

// openclaw/src/chat/work-context.ts
N();
Oe();

// openclaw/packages/markdown-core/src/image-spans.ts
X();

// openclaw/node_modules/.pnpm/mdurl@2.1.0/node_modules/mdurl/index.mjs
var An = {};
jt(An, {
  decode: () => Xe,
  encode: () => he,
  format: () => He,
  parse: () => Qe
});

// openclaw/node_modules/.pnpm/mdurl@2.1.0/node_modules/mdurl/lib/decode.mjs
var pi = {};
function Rl(e) {
  let t = pi[e];
  if (t)
    return t;
  t = pi[e] = [];
  for (let n = 0; n < 128; n++) {
    let o = String.fromCharCode(n);
    t.push(o);
  }
  for (let n = 0; n < e.length; n++) {
    let o = e.charCodeAt(n);
    t[o] = "%" + ("0" + o.toString(16).toUpperCase()).slice(-2);
  }
  return t;
}
function Ot(e, t) {
  typeof t != "string" && (t = Ot.defaultChars);
  let n = Rl(t);
  return e.replace(/(%[a-f0-9]{2})+/gi, function(o) {
    let r = "";
    for (let i = 0, s = o.length; i < s; i += 3) {
      let c = parseInt(o.slice(i + 1, i + 3), 16);
      if (c < 128) {
        r += n[c];
        continue;
      }
      if ((c & 224) === 192 && i + 3 < s) {
        let u = parseInt(o.slice(i + 4, i + 6), 16);
        if ((u & 192) === 128) {
          let p = c << 6 & 1984 | u & 63;
          p < 128 ? r += "\uFFFD\uFFFD" : r += String.fromCharCode(p), i += 3;
          continue;
        }
      }
      if ((c & 240) === 224 && i + 6 < s) {
        let u = parseInt(o.slice(i + 4, i + 6), 16), p = parseInt(o.slice(i + 7, i + 9), 16);
        if ((u & 192) === 128 && (p & 192) === 128) {
          let g = c << 12 & 61440 | u << 6 & 4032 | p & 63;
          g < 2048 || g >= 55296 && g <= 57343 ? r += "\uFFFD\uFFFD\uFFFD" : r += String.fromCharCode(g), i += 6;
          continue;
        }
      }
      if ((c & 248) === 240 && i + 9 < s) {
        let u = parseInt(o.slice(i + 4, i + 6), 16), p = parseInt(o.slice(i + 7, i + 9), 16), g = parseInt(o.slice(i + 10, i + 12), 16);
        if ((u & 192) === 128 && (p & 192) === 128 && (g & 192) === 128) {
          let f = c << 18 & 1835008 | u << 12 & 258048 | p << 6 & 4032 | g & 63;
          f < 65536 || f > 1114111 ? r += "\uFFFD\uFFFD\uFFFD\uFFFD" : (f -= 65536, r += String.fromCharCode(55296 + (f >> 10), 56320 + (f & 1023))), i += 9;
          continue;
        }
      }
      r += "\uFFFD";
    }
    return r;
  });
}
Ot.defaultChars = ";/?:@&=+$,#";
Ot.componentChars = "";
var Xe = Ot;

// openclaw/node_modules/.pnpm/mdurl@2.1.0/node_modules/mdurl/lib/encode.mjs
var fi = {};
function Sl(e) {
  let t = fi[e];
  if (t)
    return t;
  t = fi[e] = [];
  for (let n = 0; n < 128; n++) {
    let o = String.fromCharCode(n);
    /^[0-9a-z]$/i.test(o) ? t.push(o) : t.push("%" + ("0" + n.toString(16).toUpperCase()).slice(-2));
  }
  for (let n = 0; n < e.length; n++)
    t[e.charCodeAt(n)] = e[n];
  return t;
}
function Nt(e, t, n) {
  typeof t != "string" && (n = t, t = Nt.defaultChars), typeof n > "u" && (n = !0);
  let o = Sl(t), r = "";
  for (let i = 0, s = e.length; i < s; i++) {
    let c = e.charCodeAt(i);
    if (n && c === 37 && i + 2 < s && /^[0-9a-f]{2}$/i.test(e.slice(i + 1, i + 3))) {
      r += e.slice(i, i + 3), i += 2;
      continue;
    }
    if (c < 128) {
      r += o[c];
      continue;
    }
    if (c >= 55296 && c <= 57343) {
      if (c >= 55296 && c <= 56319 && i + 1 < s) {
        let u = e.charCodeAt(i + 1);
        if (u >= 56320 && u <= 57343) {
          r += encodeURIComponent(e[i] + e[i + 1]), i++;
          continue;
        }
      }
      r += "%EF%BF%BD";
      continue;
    }
    r += encodeURIComponent(e[i]);
  }
  return r;
}
Nt.defaultChars = ";/?:@&=+$,-_.!~*'()#";
Nt.componentChars = "-_.!~*'()";
var he = Nt;

// openclaw/node_modules/.pnpm/mdurl@2.1.0/node_modules/mdurl/lib/format.mjs
function He(e) {
  let t = "";
  return t += e.protocol || "", t += e.slashes ? "//" : "", t += e.auth ? e.auth + "@" : "", e.hostname && e.hostname.indexOf(":") !== -1 ? t += "[" + e.hostname + "]" : t += e.hostname || "", t += e.port ? ":" + e.port : "", t += e.pathname || "", t += e.search || "", t += e.hash || "", t;
}

// openclaw/node_modules/.pnpm/mdurl@2.1.0/node_modules/mdurl/lib/parse.mjs
function Ut() {
  this.protocol = null, this.slashes = null, this.auth = null, this.port = null, this.hostname = null, this.hash = null, this.search = null, this.pathname = null;
}
var xl = /^([a-z0-9.+-]+:)/i, El = /:[0-9]*$/, Tl = /^(\/\/?(?!\/)[^\?\s]*)(\?[^\s]*)?$/, kl = ["<", ">", '"', "`", " ", "\r", `
`, "	"], Al = ["{", "}", "|", "\\", "^", "`"].concat(kl), Cl = ["'"].concat(Al), hi = ["%", "/", "?", ";", "#"].concat(Cl), gi = ["/", "?", "#"], _l = 255, mi = /^[+a-z0-9A-Z_-]{0,63}$/, vl = /^([+a-z0-9A-Z_-]{0,63})(.*)$/, yi = {
  javascript: !0,
  "javascript:": !0
}, bi = {
  http: !0,
  https: !0,
  ftp: !0,
  gopher: !0,
  file: !0,
  "http:": !0,
  "https:": !0,
  "ftp:": !0,
  "gopher:": !0,
  "file:": !0
};
function Il(e, t) {
  if (e && e instanceof Ut) return e;
  let n = new Ut();
  return n.parse(e, t), n;
}
Ut.prototype.parse = function(e, t) {
  let n, o, r, i = e;
  if (i = i.trim(), !t && e.split("#").length === 1) {
    let p = Tl.exec(i);
    if (p)
      return this.pathname = p[1], p[2] && (this.search = p[2]), this;
  }
  let s = xl.exec(i);
  if (s && (s = s[0], n = s.toLowerCase(), this.protocol = s, i = i.substr(s.length)), (t || s || i.match(/^\/\/[^@\/]+@[^@\/]+/)) && (r = i.substr(0, 2) === "//", r && !(s && yi[s]) && (i = i.substr(2), this.slashes = !0)), !yi[s] && (r || s && !bi[s])) {
    let p = -1;
    for (let d = 0; d < gi.length; d++)
      o = i.indexOf(gi[d]), o !== -1 && (p === -1 || o < p) && (p = o);
    let g, f;
    p === -1 ? f = i.lastIndexOf("@") : f = i.lastIndexOf("@", p), f !== -1 && (g = i.slice(0, f), i = i.slice(f + 1), this.auth = g), p = -1;
    for (let d = 0; d < hi.length; d++)
      o = i.indexOf(hi[d]), o !== -1 && (p === -1 || o < p) && (p = o);
    p === -1 && (p = i.length), i[p - 1] === ":" && p--;
    let m = i.slice(0, p);
    i = i.slice(p), this.parseHost(m), this.hostname = this.hostname || "";
    let l = this.hostname[0] === "[" && this.hostname[this.hostname.length - 1] === "]";
    if (!l) {
      let d = this.hostname.split(/\./);
      for (let y = 0, h = d.length; y < h; y++) {
        let b = d[y];
        if (b && !b.match(mi)) {
          let w = "";
          for (let R = 0, S = b.length; R < S; R++)
            b.charCodeAt(R) > 127 ? w += "x" : w += b[R];
          if (!w.match(mi)) {
            let R = d.slice(0, y), S = d.slice(y + 1), x = b.match(vl);
            x && (R.push(x[1]), S.unshift(x[2])), S.length && (i = S.join(".") + i), this.hostname = R.join(".");
            break;
          }
        }
      }
    }
    this.hostname.length > _l && (this.hostname = ""), l && (this.hostname = this.hostname.substr(1, this.hostname.length - 2));
  }
  let c = i.indexOf("#");
  c !== -1 && (this.hash = i.substr(c), i = i.slice(0, c));
  let u = i.indexOf("?");
  return u !== -1 && (this.search = i.substr(u), i = i.slice(0, u)), i && (this.pathname = i), bi[n] && this.hostname && !this.pathname && (this.pathname = ""), this;
};
Ut.prototype.parseHost = function(e) {
  let t = El.exec(e);
  t && (t = t[0], t !== ":" && (this.port = t.substr(1)), e = e.substr(0, e.length - t.length)), e && (this.hostname = e);
};
var Qe = Il;

// openclaw/node_modules/.pnpm/uc.micro@3.0.0/node_modules/uc.micro/build/index.mjs
var Pn = {};
jt(Pn, {
  Any: () => Cn,
  Cc: () => _n,
  Cf: () => Pl,
  P: () => et,
  S: () => vn,
  Z: () => In
});
var Cn = /[\0-\uD7FF\uE000-\uFFFF]|[\uD800-\uDBFF][\uDC00-\uDFFF]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?:[^\uD800-\uDBFF]|^)[\uDC00-\uDFFF]/, _n = /[\0-\x1F\x7F-\x9F]/, Pl = /[\xAD\u0600-\u0605\u061C\u06DD\u070F\u0890\u0891\u08E2\u180E\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u206F\uFEFF\uFFF9-\uFFFB]|\uD804[\uDCBD\uDCCD]|\uD80D[\uDC30-\uDC3F]|\uD82F[\uDCA0-\uDCA3]|\uD834[\uDD73-\uDD7A]|\uDB40[\uDC01\uDC20-\uDC7F]/, et = /[!-#%-\*,-\/:;\?@\[-\]_\{\}\xA1\xA7\xAB\xB6\xB7\xBB\xBF\u037E\u0387\u055A-\u055F\u0589\u058A\u05BE\u05C0\u05C3\u05C6\u05F3\u05F4\u0609\u060A\u060C\u060D\u061B\u061D-\u061F\u066A-\u066D\u06D4\u0700-\u070D\u07F7-\u07F9\u0830-\u083E\u085E\u0964\u0965\u0970\u09FD\u0A76\u0AF0\u0C77\u0C84\u0DF4\u0E4F\u0E5A\u0E5B\u0F04-\u0F12\u0F14\u0F3A-\u0F3D\u0F85\u0FD0-\u0FD4\u0FD9\u0FDA\u104A-\u104F\u10FB\u1360-\u1368\u1400\u166E\u169B\u169C\u16EB-\u16ED\u1735\u1736\u17D4-\u17D6\u17D8-\u17DA\u1800-\u180A\u1944\u1945\u1A1E\u1A1F\u1AA0-\u1AA6\u1AA8-\u1AAD\u1B4E\u1B4F\u1B5A-\u1B60\u1B7D-\u1B7F\u1BFC-\u1BFF\u1C3B-\u1C3F\u1C7E\u1C7F\u1CC0-\u1CC7\u1CD3\u2010-\u2027\u2030-\u2043\u2045-\u2051\u2053-\u205E\u207D\u207E\u208D\u208E\u2308-\u230B\u2329\u232A\u2768-\u2775\u27C5\u27C6\u27E6-\u27EF\u2983-\u2998\u29D8-\u29DB\u29FC\u29FD\u2CF9-\u2CFC\u2CFE\u2CFF\u2D70\u2E00-\u2E2E\u2E30-\u2E4F\u2E52-\u2E5D\u3001-\u3003\u3008-\u3011\u3014-\u301F\u3030\u303D\u30A0\u30FB\uA4FE\uA4FF\uA60D-\uA60F\uA673\uA67E\uA6F2-\uA6F7\uA874-\uA877\uA8CE\uA8CF\uA8F8-\uA8FA\uA8FC\uA92E\uA92F\uA95F\uA9C1-\uA9CD\uA9DE\uA9DF\uAA5C-\uAA5F\uAADE\uAADF\uAAF0\uAAF1\uABEB\uFD3E\uFD3F\uFE10-\uFE19\uFE30-\uFE52\uFE54-\uFE61\uFE63\uFE68\uFE6A\uFE6B\uFF01-\uFF03\uFF05-\uFF0A\uFF0C-\uFF0F\uFF1A\uFF1B\uFF1F\uFF20\uFF3B-\uFF3D\uFF3F\uFF5B\uFF5D\uFF5F-\uFF65]|\uD800[\uDD00-\uDD02\uDF9F\uDFD0]|\uD801\uDD6F|\uD802[\uDC57\uDD1F\uDD3F\uDE50-\uDE58\uDE7F\uDEF0-\uDEF6\uDF39-\uDF3F\uDF99-\uDF9C]|\uD803[\uDD6E\uDEAD\uDED0\uDF55-\uDF59\uDF86-\uDF89]|\uD804[\uDC47-\uDC4D\uDCBB\uDCBC\uDCBE-\uDCC1\uDD40-\uDD43\uDD74\uDD75\uDDC5-\uDDC8\uDDCD\uDDDB\uDDDD-\uDDDF\uDE38-\uDE3D\uDEA9\uDFD4\uDFD5\uDFD7\uDFD8]|\uD805[\uDC4B-\uDC4F\uDC5A\uDC5B\uDC5D\uDCC6\uDDC1-\uDDD7\uDE41-\uDE43\uDE60-\uDE6C\uDEB9\uDF3C-\uDF3E]|\uD806[\uDC3B\uDD44-\uDD46\uDDE2\uDE3F-\uDE46\uDE9A-\uDE9C\uDE9E-\uDEA2\uDF00-\uDF09\uDFE1]|\uD807[\uDC41-\uDC45\uDC70\uDC71\uDEF7\uDEF8\uDF43-\uDF4F\uDFFF]|\uD809[\uDC70-\uDC74]|\uD80B[\uDFF1\uDFF2]|\uD81A[\uDE6E\uDE6F\uDEF5\uDF37-\uDF3B\uDF44]|\uD81B[\uDD6D-\uDD6F\uDE97-\uDE9A\uDFE2]|\uD82F\uDC9F|\uD836[\uDE87-\uDE8B]|\uD839\uDDFF|\uD83A[\uDD5E\uDD5F]/, vn = /[\$\+<->\^`\|~\xA2-\xA6\xA8\xA9\xAC\xAE-\xB1\xB4\xB8\xD7\xF7\u02C2-\u02C5\u02D2-\u02DF\u02E5-\u02EB\u02ED\u02EF-\u02FF\u0375\u0384\u0385\u03F6\u0482\u058D-\u058F\u0606-\u0608\u060B\u060E\u060F\u06DE\u06E9\u06FD\u06FE\u07F6\u07FE\u07FF\u0888\u09F2\u09F3\u09FA\u09FB\u0AF1\u0B70\u0BF3-\u0BFA\u0C7F\u0D4F\u0D79\u0E3F\u0F01-\u0F03\u0F13\u0F15-\u0F17\u0F1A-\u0F1F\u0F34\u0F36\u0F38\u0FBE-\u0FC5\u0FC7-\u0FCC\u0FCE\u0FCF\u0FD5-\u0FD8\u109E\u109F\u1390-\u1399\u166D\u17DB\u1940\u19DE-\u19FF\u1B61-\u1B6A\u1B74-\u1B7C\u1FBD\u1FBF-\u1FC1\u1FCD-\u1FCF\u1FDD-\u1FDF\u1FED-\u1FEF\u1FFD\u1FFE\u2044\u2052\u207A-\u207C\u208A-\u208C\u20A0-\u20C1\u2100\u2101\u2103-\u2106\u2108\u2109\u2114\u2116-\u2118\u211E-\u2123\u2125\u2127\u2129\u212E\u213A\u213B\u2140-\u2144\u214A-\u214D\u214F\u218A\u218B\u2190-\u2307\u230C-\u2328\u232B-\u2429\u2440-\u244A\u249C-\u24E9\u2500-\u2767\u2794-\u27C4\u27C7-\u27E5\u27F0-\u2982\u2999-\u29D7\u29DC-\u29FB\u29FE-\u2B73\u2B76-\u2BFF\u2CE5-\u2CEA\u2E50\u2E51\u2E80-\u2E99\u2E9B-\u2EF3\u2F00-\u2FD5\u2FF0-\u2FFF\u3004\u3012\u3013\u3020\u3036\u3037\u303E\u303F\u309B\u309C\u3190\u3191\u3196-\u319F\u31C0-\u31E5\u31EF\u3200-\u321E\u322A-\u3247\u3250\u3260-\u327F\u328A-\u32B0\u32C0-\u33FF\u4DC0-\u4DFF\uA490-\uA4C6\uA700-\uA716\uA720\uA721\uA789\uA78A\uA828-\uA82B\uA836-\uA839\uAA77-\uAA79\uAB5B\uAB6A\uAB6B\uFB29\uFBB2-\uFBD2\uFD40-\uFD4F\uFD90\uFD91\uFDC8-\uFDCF\uFDFC-\uFDFF\uFE62\uFE64-\uFE66\uFE69\uFF04\uFF0B\uFF1C-\uFF1E\uFF3E\uFF40\uFF5C\uFF5E\uFFE0-\uFFE6\uFFE8-\uFFEE\uFFFC\uFFFD]|\uD800[\uDD37-\uDD3F\uDD79-\uDD89\uDD8C-\uDD8E\uDD90-\uDD9C\uDDA0\uDDD0-\uDDFC]|\uD802[\uDC77\uDC78\uDEC8]|\uD803[\uDD8E\uDD8F\uDED1-\uDED8]|\uD805\uDF3F|\uD807[\uDFD5-\uDFF1]|\uD81A[\uDF3C-\uDF3F\uDF45]|\uD82F\uDC9C|\uD833[\uDC00-\uDCEF\uDCFA-\uDCFC\uDD00-\uDEB3\uDEBA-\uDED0\uDEE0-\uDEF0\uDF50-\uDFC3]|\uD834[\uDC00-\uDCF5\uDD00-\uDD26\uDD29-\uDD64\uDD6A-\uDD6C\uDD83\uDD84\uDD8C-\uDDA9\uDDAE-\uDDEA\uDE00-\uDE41\uDE45\uDF00-\uDF56]|\uD835[\uDEC1\uDEDB\uDEFB\uDF15\uDF35\uDF4F\uDF6F\uDF89\uDFA9\uDFC3]|\uD836[\uDC00-\uDDFF\uDE37-\uDE3A\uDE6D-\uDE74\uDE76-\uDE83\uDE85\uDE86]|\uD838[\uDD4F\uDEFF]|\uD83B[\uDCAC\uDCB0\uDD2E\uDEF0\uDEF1]|\uD83C[\uDC00-\uDC2B\uDC30-\uDC93\uDCA0-\uDCAE\uDCB1-\uDCBF\uDCC1-\uDCCF\uDCD1-\uDCF5\uDD0D-\uDDAD\uDDE6-\uDE02\uDE10-\uDE3B\uDE40-\uDE48\uDE50\uDE51\uDE60-\uDE65\uDF00-\uDFFF]|\uD83D[\uDC00-\uDED8\uDEDC-\uDEEC\uDEF0-\uDEFC\uDF00-\uDFD9\uDFE0-\uDFEB\uDFF0]|\uD83E[\uDC00-\uDC0B\uDC10-\uDC47\uDC50-\uDC59\uDC60-\uDC87\uDC90-\uDCAD\uDCB0-\uDCBB\uDCC0\uDCC1\uDCD0-\uDCD8\uDD00-\uDE57\uDE60-\uDE6D\uDE70-\uDE7C\uDE80-\uDE8A\uDE8E-\uDEC6\uDEC8\uDECD-\uDEDC\uDEDF-\uDEEA\uDEEF-\uDEF8\uDF00-\uDF92\uDF94-\uDFEF\uDFFA]/, In = /[ \xA0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000]/;

// openclaw/node_modules/.pnpm/entities@8.1.0/node_modules/entities/dist/decode-codepoint.js
var Dl = [
  8364,
  0,
  8218,
  402,
  8222,
  8230,
  8224,
  8225,
  710,
  8240,
  352,
  8249,
  338,
  0,
  381,
  0,
  0,
  8216,
  8217,
  8220,
  8221,
  8226,
  8211,
  8212,
  732,
  8482,
  353,
  8250,
  339,
  0,
  382,
  376
];
function Ml(e) {
  return e === 0 || e >= 55296 && e <= 57343 || e > 1114111;
}
function wi(e) {
  return Ml(e) ? 65533 : e >= 128 && e <= 159 && Dl[e - 128] || e;
}
function Ri(e) {
  return e - 1 >>> 0 < 127 || e - 160 >>> 0 < 55136 ? String.fromCharCode(e) : String.fromCodePoint(wi(e));
}

// openclaw/node_modules/.pnpm/entities@8.1.0/node_modules/entities/dist/internal/decode-shared.js
var ee = /* @__PURE__ */ (() => {
  let e = new Uint8Array(127), t = 0;
  for (let n = 33; n <= 126; n++)
    n !== 34 && n !== 36 && n !== 92 && (e[n] = t++);
  return e;
})();
function Si(e, t, n, o, r, i) {
  let c = e.length, u = i * 90, p = 0, g = () => {
    let C = ee[e.charCodeAt(p++)];
    return C < i ? C : C * 91 - u + ee[e.charCodeAt(p++)];
  }, f = n - o, m = n + r, l = new Int32Array(m);
  l.fill(-1, o, i), l.fill(-1, i + f, m);
  let d = new Int32Array(m), y = new Int32Array(m);
  function h(C, O) {
    let I = 0, v = O, z = O + C;
    for (; v < z; ) {
      let V = ee[e.charCodeAt(p++)];
      if (V < 89)
        I += V, l[v++] = I;
      else if (V === 89) {
        let j = ee[e.charCodeAt(p++)] + 2;
        for (; j--; )
          l[v++] = ++I;
      } else {
        let j = ee[e.charCodeAt(p++)];
        I += 89 + // eslint-disable-next-line unicorn/prefer-minimal-ternary -- branches read a different number of side-effecting input bytes
        (j < 90 ? j * 91 + ee[e.charCodeAt(p++)] : ee[e.charCodeAt(p++)] * 8281 + ee[e.charCodeAt(p++)] * 91 + ee[e.charCodeAt(p++)]), l[v++] = I;
      }
    }
  }
  h(o, 0), h(f, i);
  let b = new Int32Array(r * 2), w = 0, R = 0;
  function S(C, O) {
    for (let I = 0; I < C; I++) {
      let v = O + I, z = g(), V = g();
      b[R * 2] = z, b[R * 2 + 1] = V, R += 1, d[v] = w;
      let j = (l[z] < 0 ? y[z] : 1) + (l[V] < 0 ? y[V] : 1);
      y[v] = j, w += j;
    }
  }
  S(r - i + o, i + f), S(i - o, o);
  let x = new Uint16Array(w), E = 0;
  for (let C = 0; C < R; C++)
    for (let O = 0; O < 2; O++) {
      let I = b[C * 2 + O], v = l[I];
      if (v < 0) {
        let z = d[I], V = z + y[I];
        for (; z < V; )
          x[E++] = x[z++];
      } else
        x[E++] = v;
    }
  let P = new Uint16Array(t), _ = 0;
  for (; p < c; ) {
    let C = ee[e.charCodeAt(p++)];
    C >= i && (C = C * 91 - u + ee[e.charCodeAt(p++)]);
    let O = l[C];
    if (O < 0) {
      let I = d[C], v = I + y[C];
      for (; I < v; )
        P[_++] = x[I++];
    } else
      P[_++] = O;
  }
  return P;
}

// openclaw/node_modules/.pnpm/entities@8.1.0/node_modules/entities/dist/generated/decode-data-html.js
var xi = /* @__PURE__ */ Si("!}.&u%}'&}*'~!6*)%&,~!J~!J~%L~y<~!R,~~%Lu~~#GD~~#|)1#%}^%}2%+#.##%##%}&%##%'#%##&%#%#'%#&#%#&#'#%%#&#%##%#)%''%&%#%#'%#%%#%%}%%%#%#&(23#%%#&-%0%('1#(##%#'##+%'*.:1}#%#6-+(%'%%#%%%}#L'2351&('%}&/N'(0(/*-%(%%}#'+&T%7.2}#&%&#%#36/5##%&%%#&#%%#))2%%##%&&'0~!#*+&'%1~!%).'3q?&%'1~!.##%6(~!+%%%(Gw'rT~!E#<nA%#jZ~!H%(~!42##~!*31&~!G%U~#)5~#`3~!J~!Z~%]~%Y~%C~!q~!u~#kz~%#~!6'~!D~!U~!?~#T~!c%~!G#'~%7|~!G~!J~!G&~#pb~(Df}#%}*&}#%##%##%##&#-}&'#'&%#.++}%mI,#,@&(}*%}*'%&##&#%##%}&0}#.},U},%}+%}&%}#%##&}B%(}(%}+%)})%##%#&}&%##%&}<%}>%#%&}*%}(%}9%}/%})%}*%}*%}?&}&%}3%}&*#%})%#%#)}#&#-#+*%E%%'%'#%}#*V##&##I}#&&##%&%#&&Qf%%))w/0+&%#(#.%-''''++++7}>%4'',##1,#%#&%##&#'##&#*#9)%&%}#*}%,#+P(%A&%#'&##wSD',9E00#y#@}(+}&%&>~!#~!X}#*}(&&}(&}(,%}%&#+&}#&}I%#%}%)#(},'%#*}4%%#%}(''}#/##(##),%-##%%)#&}(.}&%#&}%%}*&#%},&&}&%}#%*'#%})%}D&}&%}-&}6&#&}-,%}#%})-(~+`~,=?~I9'9%~!,#%})%})%}@%}?%}(~!?~#<~#pP~#BG~#=1#%K+~#?#~%;)~#A~#mF1~#A'~'X%'~#lR~#N~'N~#r~#m#-~#i'?%#'%~#B%##%,%#~#_%#0%~#]732~,w~2+#:&#%&'0%&>%}#>##F+)#%&&#(+_}4&}-%}(&}@&}O7Fdf0@+/v4}&WU##&/0#&'('B#%}.%}'+#%}#%%&#&%#%##+#&#)#6#'#.},%}c%},%#%##%&#&%#&~#>'*-.%##%##%}#%%}%'~#)D1}#%*&~#_%%'(~#S2%'.}#~#=##*'*-%}&'%'##&&~'E%.#&~#M4}%%##&'%#~#O1##%&#'+~#<B%##%%'%+~#;#@%}#&%#&&%#(~#H1}'%'##&&~#?A}&'~#D#%32}'&&&&~#[}'(#%}'~#;C})&}%%#%~#=&%,3}%'(#%%~#^'#&&)#%'~#Y%-~#d-%'~#^%%&#&&&}#~#b~2t*&'~&(~&@~0%~e~3}%*''0})&}+~!9##-}#%-hD*)1fC#%/&/fB#40~!+#)*4~!+~!K'&:~!/*7~!.#~!H~!L':~%x&~!H#~!*~%1~!I#~!+A~#p'~!F~~#-#~,,(~.Z~!V~%;'B'mq-W~!N~%I%#&&#&}#%},%%}'%}+X#%}#&}(%}'%}<%}#%}%%'}'%}:~![)9@~%>~#UA%-%##&~!C%~!-.9:~!1~!-^2/:a~!y,D*J#-5)/4~%23,~#G~!L1~!0X3`~!2+~!!0-~&E~!W~!o,>Y&]~%cZx_&~#O*9#A#'#+I'%#)~!0B*-5A+-((F&*M#)(-7-5+'-3a5Vi~!Y~!?+[)%3),ERHm~!+:D,VG.+)?fB%%*(%)'(#&80%1'8`K8?`+'Z#&O&'H5#*9)A%%5&3))0%39+.*7#()&&*=4@**L)<'_&*+..;(#*+)./&0#3)%')-8(4ixD(&.}%,('aI:,)%,k2231T)I'#/-W7,/'Q#.'Y24+h')37</31&83##&0#),H(?'&?/1##%#&&#%''-%&&&#(&''&#.-'%#%%(,')*'&#&#'##%(%(#%('#&##%%%%('%#%#%%#%#&%##h>w+v<ayvyvcg.uuhKr}g/v|g>u9i[~>g5uI~=RvdwEg;v/g;uk!!TTSx]@RT!U!#!@VBRUU!'UTe-d0c`e&gSdicedFcrdTaqb.kYcAohdYd@a3e+d}dMdtd.aJ#bqcK`dle/e.e'dwdPdodddjbEb}ogd^ofdpduc6j?l%d{drdqc)d7bacOdQ%T#Y)X.sR[yH>6Vyv3[xwLu>vo'!*.[yBacahoj>6Rew3[xqdZa#!a&#^(X-[yG>6Vyu3[xvg3sEr|g.u/Ri9db0T#^(Xa)!-[y;>6Vylg4wKs{JwNZt3@3r=c4Z([xlg;wKt!cpq's@v7A'*a(a+!-a#[y<3Dt?3Dt'>6Vym3[xmg9rxsNJwLZt4~?r?db1T#`-!(Xa,!0[yS>6Vz%NuQs.g4wKtnJwNZtS@3r>c4Z([y%g;wKtrdga8!a(!#&T*Y-Xa#!a0<or[yc3Dtq>6Vz43[y3JwNZtf@3s!Ju}!%Dti:pm3c_%X#tjB5pkd6q!r]u?voC'*-a.a2!0a&a+[yI3DtI3Ds~3DtH>6Vyw3[xx;:s#~<5pKJwNZtE@3r~d`a)!a2T#a.(!+U.X1[yT3Dt`3Dtv>6Vz&3[y&g9rxwzcxstPu.<rAJwLZtT~?r@dZa%!a.&^*Za(/Reu[ya>6Vz23[y1g3sEr}wkg{NuQRg{ci(U#5@b`~,cg#U(2WnH5wugcRh7dX#T(Y,a'Ta!!a,[yZ<]mj>6Vz,3[y+Pv#5ReZKu+=,%!H}7ABwkaS?Rh:BcW(X#<]mrj:ubv/ARekdg%!(!a.*Ta(Y.X1!#sP>Rl*Dt6[y>>6Vyo3Wf*jOvuumvuRgRJuq*!:9<B@bX~3jVv&v@s@5Re[d/rQt{uAvo&a&a*)a2!,0Wf!3Dt0=Bs'>6Re}3[xy~<5s%JwJZt1~Gs)c;&!#2sJkNuXvzq7rxu,Re8dka4!a8(aEZ+a@Y.X1Xa)[yd=Bs(3DtP>6Vz53[y4cX#X&Re:avRe9~<5s&JwJZtQ~Gs*i^rzvdRg+Jv{%!2sbB@bX}kdga,!Za?&^*T1/!a'Dt+[y6>6Vyf3Wf%g/u;s4hGu6?Rh-JvZ,!c%#&RoX54Rivj7uyvf8RgTKvZB%*!2sGh<vu5Rgq<=C::9bb~#dZ#T&Ta6Y.X*Dt>[y93Wf)coZ(T,6VyifluvRgC@95@B@bX~/hFu34cC#T,k/unq8w8Q5RkUklwQuzunq8w8Q5Rk8d/rJu?v8w9)-&!a0a;a&aIWejg3sEr/h1s<DtDJvyZqY5aws3Jvy!&Wei~Hr1:au5@Bag>23E~5c:Z&bX};kKv?w&unuVu5Rjc;>bs)#~@:Rh.=ay<a]C;b`}Vd6s/t{uAvoaxa()!a,a7%-a#a2Dt,[yF2Wo[>6Vyt3[xuNuPRi&NuPwpi#RoWh?vf8Ri%Jv]!%Ri:KvxD!.'2WeAjZu`q9rxu,Re7woeAg-unLq(qA_/*2Wg_g3u5q^9:4E}/jTrxrzv=Wkkd~0UX#^^Xa-a1a5T&a=U1a'*aEa]!a*aPaA-adok[y54Rn>;:p3~Dp5g9rpsFNvZqjg3uJp4~<5p0Pw;5qlJwNZt*@3p1Pw:5p/Ou!5p2JvG'!6Vye=<qnJvh_[xhg3v,Rh3kOwOw-sDuev/Re^dha[a%!%!a+#Ta7)-5TaCaO!aka!a)sf[yb2>Rl!9ARiq5E}Qg=ucRkBE|oJrJ_@Wk~@Wk{JrJ_@Wk|@WkyJrJ_@Wk}@WkzJvO_[y2g-vMRmiKuYC!)&>Ri;>Ri<@3RkNc](X#@9Rk=g5vuRmhKvDB!+'=]meg3u4Rmgd)#Y'Vz3CARmfd`a+!%T'!+#Ta1Ta6TaM-sTDt9[yA9sYd'%Y#s[[xpj:ueunaXRgEjRq,v-vuqdd2'`#6Rev<32@5>:2<E}5xIo9a*X#Y(;5RePJvD_g>vyRgNj8w)v8<wggs:RgXiZt|vjx,hSq3ah!-(~@:Ro/Ou!5RhWj^v(pyw8unRhUdx-UY#^Ua.a3a70!)%UX1TaDa)'omRiRRhE[y:3Dsz=Br,>6Vyj3[xkg6ruwjcqsrPw;5r*Ku]D'Zt-@3r(~?r.i[vwv]dU1a--U#`a4(g/vsRhPOu!5RhLj:rmu9Wo!~@:wdh@g/vsRiTjXuvvNr}:RhBj^v(pyw8unRn]dz1UYa'a+^Y(!aETZalaRY.Ta?a4[yDJw1!#qLsW>6Vyrfzq-pLflpwRe|Js>%!Dt@3Dt&Jvy_[xs~HrnjMuwpsw'RecKu+D#'!t<~Grl~?rjg5u-x,gwp{ah!-(~@:Rg~Ou!5Rh'jXuvvNr}:Rh#cW#X/c;&!#2sLi[v7u7RgpJv)(!iLrxu,Re6j7v@s@5Se[e7d`aW!Za(a`T.a#!a3!&aDa-!9)Dt_=6s+3[x~~DR|h~DS6avhGun5RkZj3w)v-]mkKunB!&*]kb97R|i<ARk<c:Z(6Vy}Juh'!wziMRoS:F|vkLuauJv5vtvQRh1d='T+Y#VyO~DR|jcF#T'7R|g97R|kJv3'!ay<Rj,Jvh&!:ReXcsa6*a+#a#_aIRf9aLRf?c,Z&Rf5Rf7c.Z&Rf;Rf>cQ#%T'p-Rf8Rf=ct#%'(*!,p,Rf4p+Rf6Rf:Rf<d~'Ua%U*^UYa(!a,-!#a4YaTalaEX0a8a<Weo3Dt/3Dsx=Br93Wen~Dr;~<5p<JwNZt2@3p=Pw:5p;Ou!5r3c7&!#:p>3Ds}KvGB)_6Vyk2sM=<r7x'eovA(!hFu1ARf}cV#X&@r5j6rvwQa^Rf3c=Za'wkghJv__g;unRggA53B9=b^}%j6uduo5Jq;!(hIv%2Re`Ou4ARe_e%a#^^^Xa&!a*a2!&a6YaP!*ad!#a:aE/5Rn?[y@>6Vyp;:pE~DrY~<5pBJwNZt8@3pCh=rt3rWPw:5pAJup_[xoNuPpF9c!#'45pD5ARn)d8#X'X*3@rU72s]h>v<<sSjJpqvewOJq/(!hNw'5ReBk0s2u3w/w'5ReE5@Jq.!a+JQ!&WeU23d(#Y&RjG5]jBk!u7w&u0udARjEe#+^^^Ub#!a2/a`Z(agT1!a-a;|@TaG!aS[yV=Re~fow'RguNuPRe?bz#'>RoUWeL>:Cbb|?JwPZtVg6ruRmzJvD'!6Vz(g/vmRh~Jvy_[y(g9voRgyx*cy(#2>Ri2B9b]~9kIw9u7rluJu3Rg]dI#a%UY'@=p%CAx.gQZ&RhwwygtRm{x5g_Z'+ABqR9Woa=Bp&dV#^*Xa'!&@o{g4v]Rk;Jv{!%Rk[wkkiA5RkiwwfUB=x,fUuqC&*!>RfTg8v0RfV~ARfSd;rJsAuAv9wR'ae+/aO!a@aza/a#[yQ@Wg!2Wemg3sEr0JvB_g>uvReWg2v+Re=KupB_+[y!2AbY~-~Hr2AJwD!(h<~El>h<~El?Kun@+_:9b`}Kg-v/Ri3g;vtwyk_9]k_d=&T#*U.6qh@Ab`|K9:H|CJv[!&3Dtex'fDwC%!Rf[9WlMd[(^X,!a%Z06Vz!@WgBg=v~Rgvg,QRe@awd,#Y+jTv|Q~EfWj]uNr|~FRfXdy#Y&^Ua%!aO.!(a)Ua;=!a@aKap!a-,a!Ta]a[rSa]p?[y82sK=Bq~;:p:~<5p8Pw:5p7d'#Y'Wf(;RnRi[u4w&RgJJvG'!6Vyh=<r#ijuuv/sIKuYD'ZtG@3p9~Gr&d2#`(g<vtRgFj`u5w&rqpxRf2CJuY!+:wfnTOu!5Rg}jNs1ucv&RfwJvA!&3@q|BDcC#T,k/unq8w8Q5RkTklwQuzunq8w8Q5Rk9dga#!a'!a=#a0!:+Tb*b@aO.a4!aba8aFJv^}?!VyR~Dr<g;u%Rn.~<5p[x'e`wNZtR@3p]Pw:5pZhNvjBp.woe_g5u-r4JwF!%DtO3:ooc7&!#:p^3DtpLuGw(!+%)Dtk6Vz#2sd=<r8d'#Y([y#<x3gJt`w@!)%}MRiowzikRij=]ilxAf3,U(#B2Rf#g0v-Rm[ck{`U#]giKv3>)!&6Ri154s,KuGB_%@r68r:dJ|t`#X(9<E|u2@H|rx3gJu?w'!+'1Nu7Reg4=H~+9<wxgY95Rm]xLggZ-`(X}U2:Ri4h<uOawRmsJv__5@bb{jbV~3dka#a'a]!,#a+U=a>b6a3b%!/aKa/)!arwve^VyJ;:pR~DpTg3uJpS~<5pOPw;5qmPw:5pNOu!5pQJvG'!6Vyx=<qoJvA!{~Jup!%@qk7Rn/KvyD!}''[xz;>wkh'?Rh,x8gyt`w5D!&),(SgyccRgztJ@3pPB5p#d'(Y#<]mmifubw&RgoJvE&!82s^JvF&!8Rf,ADb]~;x=h'rNu]vK!,%'*0RnORh)4Rh*AqQg-vaRnNg;wHwkh'ba~4cE#Ta*x3gctyw@'!+%RnFRnD<4Rn@hFvK5RnCxWg[#`&a0Ua()`1Rm75Rg[c]%X#qi8Rg^NvdRj>BwzgZauwji7Rm6A4wgg]d1#&(*,.0a#Rm;Rm<Rm=Rm>Rm?Rm@RmARmBe%#^^^Xaea?aC/b+(,!a+a#!a/!>a&Ta<aKbD!2wphBRnk[yPw}hE|.=Br-3Dtm>6Vy~g6urRf.x,hPrNav!%'RnqRo%Ro#Nu;q[Pw;5r+JwNZtM@3r)d'#Y'Weh;xChL#`&RnmRnoKu}>%(!Rne~Bs-;2wjcussJv+'!aYSO}6@B<5?ba~8LrNvj!.%*ROwungw~ng~:9;Ri^>wtnig;wHRnixDh@|(UZ.x1h@|)!#:2<H|*xHn]#-UX'3Ro)z=iT}6ARns=Bwsn_wpnaRncw]aR(#UXa&Ua*a/=]iPd'#Y&Ro'WnXf{QRm2hNvj]nZd`'T~&1`{|`#9b]{}c:'!#Wl{>@=be}]?cl{{U#:5Abb}Jds#^YaF!a*b4a#a3aPa>&Tb!bH!*a_!Eau?/a&RjY<]gj>6Vz*;:pe~DrZg,QRj1JwNZtX@wihspcJvZ&!VyX9WmOJu|!|N2WmHJvh&!]ht~Bpbcn&T(!#RmQ<s7Nu;padH#X'`+WmJ@>RmKCARhnKup=!)&Wf+:RhqNuPpf9c!#'45pd5AwghpARn(Ls@w!%,)!RmP@Wfe<E|IJva!&WmNg8vsRmLd`*.`#Y'Xa!axRn*]hrA8Rhug5s@rXg8u!RmMd8#X'X*3@rV72smdI*#UY&RmICARho~GsgxVgd)Ta'U-Y&Xa!T#RnEWnA@Wffg1uDRi0hFvK5RnBxGnG&#`%owp)@wsf+bX}Ze-*1!a*^^^Ua|!#a.aq&Ya2!a>.a6!a:aO`aJDtL[y`@Wg#>6Vz12@wzoYRoZNuPRi!NuPRhzg=ucRi,@=b`{Yg=ucRi-ACJvB!&Sh[ebSh]ebi`wUuFRm4Jw2_[y0JvB!.<Ju(!&SoG}6Shd}6<Ju(!&SoH}6She}6Kur@._g5vHRieJvx!{L2G{Kx6gd'T#?Rh82Wi5cZ#X(g1w)Rm5dW-Y(Ta#!a)!#aYa=wnfE=su2>>bU{0j9udv:<svj8uQv-7RgHdE%#^'sq9sp=>Bb_{TJv`!&g/r|snj6v(us5d,#Y(56H}[978H}]Jw5!&g1rushJvB!+j;v{u5?zDhd}6}bj;v{u5?zDhe}6}ce*#`(^^^a[aea!=!a6a*aoXb1a.!aAbL!b>,b'aL!aV@Wf|2Wlg3[y/JwNZt^@3piPw:5pgJunZou3@rsJva&!Vy_g<v~Rm#JvG'!6Vz0=<r{Ju{%!:pj@WfsiXuJu3Rm:JvZ&!WfA~Bph@c4Z&Dtwax5rubx(#:awRk1@d,#Y&RfjRfid1#,Y(@Wfp2Wlrg5s@ryKu[@!,'=]ig9wlk?Rk>g5u-rqJvy'!@9RkQcH(T#=>Ri~@<wkj(Wj(KuZB*!&<7rw@9RkRcH(T#=>Ri}@<wkj)Wj)dg(Ta2Xa9X#`-!a*CARhg@@=I}d9x;c~#X%so=<sj>2@@=aybb}XjWv0Q~EfEj3vLv;<d,#Y(56H}`978H}_dgaPaFa'a/!#a3Y0a_a;a|!1(a7-[yE3[xt;:pJNvZrrg3uJrvJwNZt=@3pIh=rt3rxPw:5pGOu!5rpJvG'!6Vys=<rz@c4Z&Dt(ax5rtJvZ!&~BpH@wsfNg-vaRlNci*U#=<wei<F}a5@Jq.!a*JQ!%@qZ23d(#Y&RjH5]jCk!u7w&u0udARjFd/prq=tyvpaEa(a:.!a1aZ(@@=I}:9wpd%=<sX55w_h}@@=I{t=ay<aU@@=I}T=ay<2@@=I})?C9:9au@9Cb]}DP~=x-fAZ(2Wl1=ay<aU@@=I}>5@d##Y+jTv|vV~EfFj]uNpn~FRfGdgaK!Z2&!a8a-Tb({E!acTbM*!a(DtY[yYd'%Y#sl[y*hHvh>Re5x2c{Z}.j4uCvcawRiMd+#X+_x&d!},<5RkX;2Hzw@x,gavfB-!{CcF&T#Roe;RodwWbBg5urRgaKvHC*_6Vz+<4opieuew&Rmq@d]&Y)X,T#X0Rh}<BqP=4qS9:ReMg/ujReNJw0!/<Jui%!bd{kawwnemRelAxUa?a3#*.&UX(Ya+a/RhvRnQ<o}9Wmtd-#Y&RgSRmw9;Rmxay=Rmyg-vaRmuxEhSrNu,v-voC!%(aR.a(a7+1Ro1>Ro5CE{A9b]{@;5x#eO{:g;urRi+KrNA!%(Ro3>Ro79;Ri_Ku@>{;&!x%gX|{KunA_+g5QRj/g3u5Rj#g>uERj%wio/xRhS&!,!#^1U}wba{8>>@=be}qC@:D5ba{7Ku+A&!}x?ba}t>>@=be}se(aA^^^Uat!b0#{pa+awUazbGa#aLb9bgaWac'a5TbS=Br!d1#`%scp_Jvl!#rT>Re0JvX&!VyN=H{Fcm#U&:pY=ReaJv2&!]h0=]nUJvG'!6Vy|=<r%JrM_=]h2@Wlud'#)U'Wf'b]{i=]h/Jvh!&~BpWg=v]RnMx+ny#'Nu;pVwjnu=]nwxJnx,T#`&Reqwjnt=]nvieu9vrRjLLuYwP(#+!th@wih5pX~Gr'g5v/Rh4KunA'!-CARnP@wwiN:Rm_9x'cvw>!|l=<saKvAA!0&3@q}>w^e1bp#&Re2Re3BDx7gH#T|f5H|eKuZ>!%(:qNAH{]Jv6!+3B2B9=b^{X<5<B92:E{ZLvhwA(a;a%!igQuyRmad+#Y}m@3Rh5d8#X'X*:AqUAHzmaxwbh<aXRnVcF}RT#Nw&cj#U(BWnug/vsRntdka)(a3+.Zb7aYYan1!bVa@Xa}[y^@b[{G=H{+hFu73Rj&Pv#5ReQcK%T#sig1v{Rj'Ku+D#'!t]~Grm~?rkKuMB!01d5#`'Vy.ta3Dtu~Hroc8#'{^45s85AwZbP&!#Rn!wghxWn#KvEA!)&2RlA2RlBx:h|#(T,=]j09Wobz>x]z/@awRoTd+#Y(az]hFhCrm4d,#Y+jTv|Q~EfMj]uNr|~FRfOdCa!Xa9_X#@<plJvf!%b`{(9;Rgwc;.!#2x7cw#T|UDb]|T5Ju={(!=@E{&Jv)&!Ab`{'awJvf!~*>>@=be{#KuY>!+&4Ezyi[ugv&RjIdea+T)#UXa&T-T&a!Rh9auRmW=]kLg5vuRn+g3u4Rn-Ow6ARn,hHus5xNk?#UX(U~)/g8v0RkD~AwkkF?Ri.OuNBwkkA?Ri/d|a2`a*^UYa.!aBTZaTa'Xa;!(!2!-a#b2[yC>6Vyq3[xr2Wi?g1rusVh%s?DtF~<5rbJs;%!DtBfswKtCj[uvuSsEu3RgVx3o:u+wN'*Zt;@3rd~Grh~?rfg8w)Lq)qE&-a%!>bI|`jWv0vV~EfCjTv|vV~Ef@j]uNpn~FRfBcK#T']gWNu7x,k7q4ai(0!hHv8<RhmkMu9vrsBuev/RhlCJvB!,g<v{wchh~@:Rhji[vrv{wchi~@:RhkdS&a5UY#Ta!RgPwwiI5BwciI~@:Rh`x'iJvj'!5]iJPu8Bwch]~@:Rhach)U#h3rp]gLh@t|Ax,hTq3ah!-(~@:Ro0Ou!5RhXj^v(pyw8unRhVd|)`,^UYas!a?/a2Z'a^Ta{Tb7Ta(a#!a,Wf&9sZ3DtAadamov=Bqt3[xig8vsRm~>waiL2b`{QJv*_Ouv2qgj<v]v2BqfdR'X*X#Y-@3qr~Gqv~?p6hHv-]glPup5Lq+q?_%*b_{qF{n9b^{rOu4ARhpKvCD!+&~Bqp:5Dbb}nwoiKl&unuTuBv]v+ueunaXRf0=Jvh!0nKufu8v1w&w7q%w&uHrz:Rgnj5w,uxDJq/(!hNw'5ReCk0s2u3w/w'5ReFd>Za&!*UaA=<wkgsRnSJv^!%Refifw3vyRgOKu_B'!,<]gkiiu:w&Rh<=C@a^<B57@2F{[<B5@aW:=3away9A5aW=<B=C@a^<B57@2F{Ie-#`(^^^bCara.b8aza6!/bZ,!adTbnTbOb+aFaS!aAT9@Wf~2Wli3Dtl2@d,#Y&RfnRfmJwJZtN~GqyJva&!VyMg<v~Rm%iXuJu3Rm9Jv[_=]ih9wlkDRkCd1#`(@Wg>2Wls3cH#T(@<Rj*=>Ri|b~'#23s9h<~El.d'#Y&Dtxi^rzvdRl#d*#U%(o|B2s`hJwSaxRmDKv4B&!1:Rmdd5#`'Vx}to~Hq{x'f1v3(!BA5ba|bJv_&!Wfug1v]ReIdO+U/Y#&G}-8wze=Rh{g1v]ReHg/uQRf/by#)ibQwERl/cH#T(@<Rj+=>Ri{cNu+vlax-!(#a0qa9<Rii2;;bU{H;x<i=&X#Rk`<4wwi=C9H~8xAI(Y#<azRi@45wXI<B9;5bb~7dL(X#Xa(+!aL6Vy{g5QqOau:5au2@ay547EzbxOcU(UX-T#Ta#:Cbb|A?wjh/b_|SOw6ARgtihr}u7Rhy<d1#T)X1@@=I|~=ay<2@@=aybb}Sj3vLv;<d,#Y(56H}A978H}@dGpvs@uAu`vcw9*!aFa+ai%(b!aXa8.a?a[ozWey=sU2@G}Nch&U#Rf_WexKu+D#'!t:~Gr`~?r^j]uNr|~FRg*j^psurwJt|RmcKv)@&!)7Rkv~Br[@wxfO:Rl3co#U'6Rezj_q#vIuavjRltwzeyh@vr5JqD0!>aY?C9:9au@9Cb]}9cl#U*5;5<H||jbuus1ucv&Rfvg1v~d/pppzqFr^a--a~!aMat1(hFv;Wiz@@=Izoj5uuv-7Rix~Cw`fk2WlVcZ#X,k)u3vWs@u2]ktg;wEx'fBq(_2Wg/jTv|vV~EfoJv]!15x'hzqG!(P~EfU~CRl_j6v(us5x4i-#T(2WmZ?C2F|d>Kq<aj1!*jTqIsBv=Wl`~Cw`fi2WlWj`v0u*~>RlR=c>Z,k#u3vWs@u2]kr<c1Z+jTqIsBv=Wla~Cw`fm2WlXdmb3!a{(arZa`bkTa%TbQTa-a9+c'!aM!/[yL=Bqug.w'RifhFvyDRj.g>vgwyk^9]k^Jv3_@WfbAARkhJw2_[x|JvB_wkoIRoKwkoJRoLd'(Y#<]gm=<9<H|yd'%_X#skDtb3awwqkgNulRkgdB#^',9:p'hJwSaxRmEBwVb8@4=H|qLu+w50&!)@3qs~?pU>Awwn;;Rn=c:Z'ARn<=<qwKvC@!/&~BqqJv6!&]eVb^z^xRge'/a%+^`#Sge}6<4Rn3=]n0Pw2>Rn8Jw0!&>Rn:>Rn6cY#a7+!a&=<wkaNw~h3z_c5Z{=wjh#=]nLKv^D!&)Vyz=bW|swYb<WetcG#T(2wxa@qVx@gD#Y&b^|V5JwG&!5bb|pg/w&RgD@x=kHs=uAvn!a%%/'+RmSRh694Ro`g-vaRmRhHv-]mlxCcS#`&ba~.5cD#Ta)P~=d,#Y(56H{>978H{Dd_#{2^Y%_+qbbb{6g3sERhsbU{?dfa.,`a(Xa<!aiX#(55RiG54RiHcI#T'WiU3RiVNvdwtfcRlKNvdd,#Y&RlHRlExQgf.1*^T'X#Sgf}6Wn4=]hfPrk>Rn7Jw0!&>Rn5>Rn9Lunw?&a2!,5<oq@@wqfdRlJj5Q~=d,#Y(~ARfcOuN]fdDKw;ay(}i!547E}j?cI#T(@5bV}iCbV}hdv(^^Tb?a40,b##Tbo!a*bR!a<b|a/!aKai!aU[yK=]o^g:v>ReGJwPZtK<7Rh+h<~El,Pv#5ReR@awwxjCg,ulRjDJv6&!]j!z?aQeeg>w=Sh<eeJw;!&axEzOg,Qosc!#*:wkeJ]eJ>x'h-u(!%Ro.w~h.zPdNZ(X,Ya![x{;9ReY;wkgxRiF:x?ap#Y&RmUg<s2Rkod]+UY0TZ'!a&A9sw<=bczLNvuw{gqzNhJwSaxRmCKuLay!#&s_Rf-55b^{uJvZa!!c%#(55Ri654wmiu5RiuawLu,vp!+}^%b_}Y9;wkgxba}o>A9:=b^}zKuh=a''!3awRk3c*'!#aHRk6c+Z&Rk5Rk4Jv)&!awRjSawd9*`#0?C2@EzMj8u<uJ5RmbjQrquJu3x,k>uq@_+=ayb^|W~ARkEOuN]k@7dhzV^X/X&a-#zRzSb`zXcJzTT#2WkVKvDBzW!%FzY9;5bbzWjQrquJu3Jw3%!b`zU=ayb^zQd:#X(T-a!6Vyywxh}=b]{Jg=u1RiAdGp~qHtzv!w(wA+a+a;<!aJaYai'anasb(=azRmV:Cbb{MLq2vb!%')RjuRjrRjtRjqx3jnqCw3!%')Rk(Rk+Rk&Rk)Lq2vb!%')Rj{RjxRjzRjwLq2vb!%')RjsRjpRjfRjex3jcqCw3!%')Rk'Rk*RjkRjl9<CbbzfOu4ARhxLq2vb!%')RjyRjvRjhRjgx=joq*uKvb!%')+-Rk.Rk%Rj~Rk-Rk#Rj}x=jdq*uKvb!%')+-Rk,Rk!Rj|RjmRjjRjidAq&qKs@uAv8Aa.'*-a@a&0!aM@a5[y73Dsy3Ds|3Dt):wxgI2sHJwJZt.~Gqxwsf0ikrzt}Rl0Jvy_[xj~HqzKv_A|D!&WfP8axRoVcf,U#k(v]v+ueunaXRf1Ju}'!g8u#Ri=jQw!sCunLprq>!,')~<5qeGzq9F{W=c##%s5au:5aU3CBE|;d4#X(D!a&6Vygx(b;#(=]ed?C2F{N<capoq2r[a&!aPa9,'Pw;5s:@@=I|,55w_h|@@=IzcP~=x'fCqB_2Wl2>aU@@=I|1OuNBc1Z+jTqIsBv=Wlc~Cw`fl2WlZ~AcTa%!Z+jTqIsBv=Wlb~Cw`fh2WlYk+uNqJsBv=WlSg,u3dca3#UXaMYa)TaB-=cM|7T#<bI}l5@B932:aV2G{BOuNBJq:|M!5Ezt=<B=C@a^<B57@2F{v>cB{/T#=ay<bI{3Jv6!a.6BKq0ah&+!5E}HP~Ef{978BaU@@=Iza<7d#.Y#978BaU@@=IzH~AJq0!(@@=IzG978BaU@@=IzFe,aU*Y&^^^bvJb,b:bFad!a,c2Ta>aL.bo6!a#CbTa'T#Re{2Wlh2@G{yg6t~Ro_NvdRfticuRQRllJv3&!x&c|zs@Jw3!%RflwpfkRlpKuL;%(!Re<@G|C2GzdhIvuBwgjAg-u0RjAKQB%!(GzZ@G|5NuuRl7d='T+Y#Vy[g<v~Rm!==G|>JvA!)@wma=]m1ifuaw&RmnLs@vT'!|/+[y,g:v>ReTJw1!#qX=x!eC{bLu+wT&)ZtZauq_~Graci&U#F|89:r_Lupvq!.)&2RlG8RfaC=x!eF{_h?rpWlmd&'!#X|&]k::xJey#`'T|+<E|&2@H|%dE#(^,g;u.RiEg6vjRiC9xCkA{O|zY#g=ucRmXKs0@!&*@G|m@awRknJuh!,3d(}gY}eJvj!%Rm):Jw3!%Rm+Rm-Ls0w(&!a(a#@b[|6cZ#X'7RkxWgAOu4ARn'dH'U#Y*Vz-Wm'CARm}d]*#a%^a*T'aK!a<9bV{PC=p*Jw4!&SgxcbB5r]idw(wBRmF7xFkt#&`(Rm/Rm8E|!JuY_9:Rl5=wrgr2:bbxd@xXfB(a*#T+!.X0X1Ta/a'T&RlDRfL>RlyARl9b[z[>RfZ:RlL:RfRwlg/ARl;9;RlxKv,A/!%7s69<74=BA5ba{-8Bde#`a<XaKYa1,a'P~=wxfB2bZ}}?C972@@=I}r8@55B9;5bb}G978B2@@=aybb}3j3vLv;<Jw3&!>Rfk=ayb^}4~Ad1#`*@@=aybb{w2@>==<bbz]dx+UY#^UaF!a9!bB'Ya1.!ajXa#%olRhD[y=3Dt#Ov5BrHKuMB%!(Rf^Wep~HrJwkiQjKr|~FRg)Ku+D#'!t5~GrF~?rDdV)UY,Z/_7RkuG{<~BrBg,rlsO:235B@bX}|d?a1!#`(6Vyn5@d##Y+jTv|vV~EfIj]uNpn~FRfH7Lq2vb1!a9-978BaU@@=Iz9978BbU}#~AJq0!(@@=Iz8978BaU@@=Iz7~AJQ|}!978BbU}!JvkaK!AdUa21-U#`a+(g/vsRn~Ou!5RPj:rmu9WhOjXuvvNr}:RhAj^v(pyw8unRn[kPr}p|u7vwv]RiSBd;pppzq@qHQa?(b.!a.a`@.|xa(hFv;Wiyj5uuv-7Riw~Cw`fg2WlU978BbU|wOuNBJqG!(P~EfD~CRlQcZ#X,k)u3vWs@u2]ksg;wEx'f@q1_2Wg.j]uNpn~FRfqJv]!15x'h{qG!(@@=IzK~CRl^j6v(us5x4i,#T(2WmY?C2F{1>Kq<aj1!*jTqIsBv=Wld~Cw`fj2Wl[j`v0u*~>RlT=c>Z,k#u3vWs@u2]kq<c1Z+jTqIsBv=Wle~Cw`fn2Wl]dn1#c(a(b^a2!b/bAT(bj!aDa7bu,a_a{c0!2T0g:v>ReD2@G{42@G{5~DpM~<5rc=Bx6i>{RT#RnI@zCx]y]z:2Jv[!zr5Awyk]9]k]dD(Y+X#6Vz.g=wKtgwhaCwgmTWj2Lu,w%_+/[y-B;b^xeg3u3Rj-2@bX{*KrJ<!+'@Wg(g?QRlC@Jv`!%b[zIwsfII}8JQ_@w|kW|=Jv(%!AqcOuNBJvEzh!bYzjLs@wP#(0!oy@>RkdJwMZtc3Dtd@BcG#T'9bWxg2@2Fznd*#Y+;2x'c}w<zizixNgwa#Z'U+!/!a'!a+w~g~z6wcn{Rn}wcnzRn|5Rh%=]nJg5vuRmvNvdRlvcprJu}w*az*a#!%.a.'Bot9qT]kj@Wg'ay2Gzv@Jv`!%b[zEwsfHI}1;ck#Ux`<Cbbx_Lu+w!a&0*!wko*wwo,So,}6Juqxf!E}PigQuyRm`d3(`#8>Rn%:A5B;bZ~%KvhCa!a2!x>k7#Uxb@b{#xaRk7Jw0!)>wwhlShl}6>wwhmShm}6CJvB!.x'hhvj{!!5Bwkhhbaz}x'hivjz~!5Bwkhibaz|xEhTrNu,v-vpD!a%&/)a3a.,%Ro2t[CE{)@3re9b]{%wjo09:rgc:Z&Ro6=<riifuaw&RmoKrNA!%(Ro4>Ro89;Ri`dSaL'UYzxZb)7Rka3xRhT&!,!#^1U}vbaz{>>@=be}yC@:D5bazzKu+A&!}{?ba}y>>@=be}wxBh[t`u~vJvr!%a!a()a,a0a4RoC=]o;Ju(!%RoGRhdwjh`=]oAg>w#Ro?g5vuRo=NvdRl|Ku]C.!&;RoEJvB!%RoORoMBx'h[v+_?w~h`}~5?w~hd~!xKh]oiptu-utv.vp!#%&a30a@a'a+(a/aOp(o~p!RoDJu(!%RoHRhewjha=]oBNvdRl}g>w#Ro@g5vuRo>c[#X']o<CauRoRAd-#Y':RkpauRoQKu]C.!&;RoFJvB!%RoNRoPBx'h]v+_?w~ha}t5?w~he}ue!/UbhYacXaW^Tc&a;b:a-c/#b&aja1(!cL+!bKbt!bmcRc9aIc?8[yW3Dtt94Rg`Jv}!&SiRMzBhEebShEMNuPRe>x7gL#TzuwjirRipc<Z&>on;>z=h-MSh.Mwqczx'a7vj&!>Re4@=ResJt__NuPRi*NuPRi)j]uNr|~FRfzKrJ>_+@Wfy@Wf]2WocKrJ<!+'@Wg%g/QRl@@Jv`!&awRl<wsfFIzgLu(w*!.*&ShBMwvhIRhI9;RhNx1hK'!#Sn]Mx1hK~0!#:2<H~7cNu+w7D*'1ZtW>Rn1~?rOc:Z&Rn2=<rQ<7wjh&=BSnLMc]#X(6Vz)w[b=a!U#9wzgMc3#&(RgMRitRis<x,gKt`ax!&+SioM=BSilMc3#&(RgKRinRimKurB,!&SiQMzBhDebShDM6BJQ!(P~Efx978B2@@=I}WLrJw!!,a*&@G}O@9wkibRid@@x'fKwC!&SlDMSfLMjUv~Q~EfKKv3@a+!(hFv-]mpx/hYZ(C5RiWz<o/MwkhY?So/M@x,gbvfB*&!SgEM:SoeeehFu3:Rgbda(,^TZa)X/7Sg[eb:2RgI~BrMC@wgkc:wwkcRerx3h(uUvK!&*,SnOM4Sh*MArRg;wHRh(x=h;rJvPwI!a4',a'0@Wg&=BSh/Mg>w=Rh=g3w*wwgGRgGcW(X#;Sg}M2Gzk@Jv`!&awRl=wsfGIz`dKZ*T'Y-:RhR7RhQg5u-p`j6v(us5d,#Y+~Awkia?RicOuNBwkibba}Ld6p~tyu_vbAa'a+!a/'a3aEa8a!>Sh,ebJv{!&Sh@ebSaReb9;SgwebNuPRi(NvdRl)NuPRi'hHu^<Rm^Jvv_@Wl(g;u1Si/ebKu'B&!*Sh?eb@Wl'z@aPeb95Si.ebcpputyvjB)!,&a+0a%ShAMWeK@G}C@WfJ9;RhMwvhH9w{ia}ix,hJvRA1(!zAn[MRhHx1hJ~*!#hFv(BSn[MBJQ!(@@=I~'978B2@@=I}2db.Ua<'X}+T#a0XaG2G}E;wkg|wuh!Rh!x,hZu,@)!&So0MVy)C5RiXACJvB!&5RiY5RiZg8w)cG}*T#2@bU}=KsA>(!a.3wkhZba~(x,h^u(A!&(SoCMRhb5Bz=h[eb?w~hb~6x,h_u(A!&(SoDMRhc5Bz=h]eb?w~hc~6e)aA1T#T,^^^c-bMb&blcPaP(a/!0!bA=b5c@a(!bfbrc#2afwmhARnjwchORnp2Wlf3DtsNvdRl-2@wpa<]m0bx(#:awRk2@Jw3!%RfhwpfgRlnKQB%!(G{V@G|'NuuRl6d='T+Y#VyUg<v~Rl~==G|<Jv+'!aYShC}6@B<5?ba~8@Jw3'!g2QRljhLrpWlOd+#Y'g.w'rIg>w*wgj@g-u0Rj@Lu+wT&)ZtUauq]~GrGci&U#F|39:rELrNvj!.%*RhCwunfw~nf~:9;Ri]>wtnhg;wHRnhx3hDs@v~!/+'@Wfr@9RkSNu&Rlo=@<5GzoKs0@_+@Wl+@awRkmJuh!-3d(}pY#qWJvj!%Rm(:Jw3!%Rm,Rm*de&!1U-U#`)Re;@G|.@9Ri82@wjfvRlq=@<5GzpLvOvr!).&2RlF8Rf`C=x!eE{.Jw3_g2QRlkhLrpWlPde(!#U{s,UXa*Ta'[y'g:v>ReS;x0PZ&RnlRnn~HrKJw1}f!=x!eB|2w]aP(#Xa&a*Ta.Ua2a7=]iOd'#Y&Ro&WnWg;u.RiDg6vjRiBNvdRlzhNvj]nYJuW_2Wm3x)kFze{9d])!a.!,Y01!#&aC!a3RndC=ox~BrC@2b^{pg,rlse7x'ksuq!%Rm.E{xidw(wBRmGx9o+)X#wwo-So-}69:Rl4@xSf@a#XZ'X)X,Ta(/ARl8b[xc>RfY:RlI:RfQwlg.ARl:9;Rlwdn'#^XafaQa1X1TaHTa)@b[{zcZ#X'7RkwWg@Ou4ARn&x)kG#{,g7u/RkGdH'U#Y*Vz'Wm&CARm|bx#(A]gUbUzJj9Q~=d,#Y(56H}l978H{U7d,0#U*2>ABb_xZ978BbU{e~AJQ{g!978BbU{hxMh?ad{oUYZ.x1h?{l!#:2<H{mx3n[t{vl!,&a%3Ro(z=iS}6ARnr=Bwsn^wvn`Rnbd`*T}B0!#^X'BG{c9b]{a>>@=be}F?JvS!&BG{d7BG}(Bde#`a1X,Ya@!a'P~=wxf@2bZ}I56B2@@=aybb}08@55B9;5bb}<j3vLv;<Jw3&!>Rfg=ayb^}&OuNBKuLA!)a!P~=x#fD{f2@>==<bbzl?C972@@=Ix^d6rSu,v7w*C(0a)a6#B+a%!sQ[y?3Dt%3[xn~<5rLOu!5p@Ku+D#'!t7~GrP~?rNKvlaya7'!h+v-5qMg=t|cd,U#5AAaa5Abb{S@52B5@a[@52B5Gx[iXueu;d<#`a(!/549C;ag>23ExY5@Dah89b^~689Jv)!~2b[~1Lv'w(%*!a#bX|aPrmawRe]keu7uhv-q6rxu,q`xTo]/a5aU!bNaDXbi!b-!ao!b<bwA!#5@B932:aV2G|:d-)Y#hJrL>RhG<7@C5<H|_=Cau:5aj5@B932:bJ|ng>vIbs)#?C2F|9jPv0w.vISh-MKvUaz(.!9ABbb|[5;5<H|Eg>unwfh;9:4E|YjQsBt|vjx'hYq3!(?C2F|J:2<BaY?C2F|GOu!5x,g|p{ah!-(?C2F|c9:4E|OjXuvvNr}:Rh&i[w*t|cd+U#jJvsu)vsSn~Mkfrmu9p}u7vwv]So!McW#Xa!ax5@A5aY:5;5<H|>kJv~vYrquJu3x4ib#T)2@SmZM?C2F|Bj:rmu9@xPhI(a*a#U#`a3-5Abb|L~@:RhK9:4E|0@52B5G|#C::aY?C2F|-:2<BaY?C2F|.5Jvk!a)javYrquJu3x4ia#T)2@SmYM?C2F|HAxPhH(!a#U#`a*-5Abb|4~@:RhJ9:4E|R@52B5G|F:2<BaY?C2F|Sc^#Xa2j=Qq5CJvB!-g<v{z;hhM?C2F|Zi[vrv{z;hiM?C2F|XKsA>!a)-g<v{z;h[eb?C2F|]i[vrv{z;h]eb?C2F|^iZu.vix,hZq3ah!.(?C2F|QOu!5ShXM:2<BaY?C2F|P", 13494, 2713, 49, 25, 61);

// openclaw/node_modules/.pnpm/entities@8.1.0/node_modules/entities/dist/internal/bin-trie-flags.js
var W;
(function(e) {
  e[e.VALUE_LENGTH = 49152] = "VALUE_LENGTH", e[e.FLAG13 = 8192] = "FLAG13", e[e.BRANCH_LENGTH = 8064] = "BRANCH_LENGTH", e[e.JUMP_TABLE = 127] = "JUMP_TABLE", e[e.VALUE_MASK = 8191] = "VALUE_MASK";
})(W || (W = {}));

// openclaw/node_modules/.pnpm/entities@8.1.0/node_modules/entities/dist/decode.js
var Y;
(function(e) {
  e[e.AMP = 38] = "AMP", e[e.NUM = 35] = "NUM", e[e.SEMI = 59] = "SEMI", e[e.EQUALS = 61] = "EQUALS", e[e.ZERO = 48] = "ZERO", e[e.NINE = 57] = "NINE", e[e.LOWER_A = 97] = "LOWER_A", e[e.LOWER_X = 120] = "LOWER_X";
})(Y || (Y = {}));
var Lt = 32, ki = 21, Ol = 2097151, Dn = 2047, Ai = 0;
function Nl(e) {
  let t = e >>> ki;
  return t === Dn ? Ai : t;
}
function Ci(e) {
  return e - Y.ZERO >>> 0 <= 9;
}
function Ul(e) {
  return (e | Lt) - Y.LOWER_A >>> 0 <= 5;
}
function _i(e) {
  return (e | Lt) - Y.LOWER_A >>> 0 <= 25;
}
function Ll(e) {
  return e === Y.EQUALS || _i(e) || Ci(e);
}
var Ei;
(function(e) {
  e[e.EntityStart = 0] = "EntityStart", e[e.NumericStart = 1] = "NumericStart", e[e.NumericDecimal = 2] = "NumericDecimal", e[e.NumericHex = 3] = "NumericHex", e[e.NamedEntity = 4] = "NamedEntity";
})(Ei || (Ei = {}));
var Mn;
(function(e) {
  e[e.Legacy = 0] = "Legacy", e[e.Strict = 1] = "Strict", e[e.Attribute = 2] = "Attribute";
})(Mn || (Mn = {}));
function Fl(e, t, n, o) {
  let r = (t & W.BRANCH_LENGTH) >> 7, i = t & W.JUMP_TABLE;
  if (i) {
    if (r === 0)
      return o === i ? n : -1;
    let u = o - i;
    if (u >>> 0 >= r)
      return -1;
    let p = e[n + u];
    return p === 0 ? -1 : n + r + p - 1 & 65535;
  }
  if (r === 0)
    return -1;
  let s = r + 1 >> 1, c = n + s + r;
  for (let u = 0; u < r; u++) {
    let g = e[n + (u >> 1)] >> ((u & 1) << 3) & 255;
    if (g === o) {
      let f = n + s + u;
      return c + e[f] & 65535;
    }
    if (g > o)
      return -1;
  }
  return -1;
}
function Ti(e, t, n) {
  return n === 1 ? String.fromCharCode(e[t] & W.VALUE_MASK) : n === 2 ? String.fromCharCode(e[t + 1]) : String.fromCharCode(e[t + 1], e[t + 2]);
}
function Bl(e, t, n) {
  let o = t + 1, r = 0, i = o;
  if (o < n && (e.charCodeAt(o) | Lt) === Y.LOWER_X)
    for (o += 1, i = o; o < n; ) {
      let c = e.charCodeAt(o);
      if (Ci(c))
        r = r * 16 + (c - Y.ZERO);
      else if (Ul(c))
        r = r * 16 + ((c | Lt) - Y.LOWER_A + 10);
      else
        break;
      o += 1;
    }
  else
    for (; o < n; ) {
      let c = e.charCodeAt(o) - Y.ZERO;
      if (c >>> 0 > 9)
        break;
      r = r * 10 + c, o += 1;
    }
  if (o === i)
    return 0;
  o < n && e.charCodeAt(o) === Y.SEMI && (o += 1), r > 1114111 && (r = 1114112);
  let s = o - t;
  return s >= Dn && (Ai = s, s = Dn), s << ki | r;
}
function Gl(e, t, n) {
  let o = xi, r = e.indexOf("&");
  if (r < 0)
    return e;
  let i = e.length, s = 0, c = "", u = o[0], p = u & W.JUMP_TABLE, g = (u & W.BRANCH_LENGTH) >> 7;
  do {
    let f = r + 1, m = e.charCodeAt(f), l, d;
    if (m === Y.NUM) {
      let y = Bl(e, f, i);
      l = Nl(y), t && l > 0 && e.charCodeAt(f + l - 1) !== Y.SEMI && (l = 0), d = l === 0 ? "" : Ri(y & Ol);
    } else if (_i(m)) {
      l = 0, d = "";
      let y = m - p, h;
      if (y >>> 0 < g) {
        let x = o[1 + y];
        h = x === 0 ? -1 : g + x & 65535;
      } else
        h = -1;
      let b = 0, w = 0, R = h < 0 ? 0 : o[h], S = f + 1;
      e: for (; S < i; ) {
        for (
          ;
          // Value-less, non-run node with a nonzero jump offset.
          (R & (W.VALUE_LENGTH | W.FLAG13)) === 0 && (R & W.JUMP_TABLE) !== 0;
        ) {
          let _ = R & W.JUMP_TABLE, C = (R & W.BRANCH_LENGTH) >> 7;
          if (C === 0) {
            if (e.charCodeAt(S) !== _)
              break e;
            h += 1;
          } else {
            let O = e.charCodeAt(S) - _;
            if (O >>> 0 >= C)
              break e;
            let I = o[h + 1 + O];
            if (I === 0)
              break e;
            h = h + C + I & 65535;
          }
          if (R = o[h], S += 1, S >= i)
            break e;
        }
        if ((R & (W.VALUE_LENGTH | W.FLAG13)) === W.FLAG13) {
          let _ = (R & W.BRANCH_LENGTH) >> 7;
          if (e.charCodeAt(S) !== (R & W.JUMP_TABLE))
            break;
          S += 1;
          let C = _ - 1, O = h + 1, I = 0;
          for (; I + 1 < C; I += 2) {
            let v = o[O];
            if (e.charCodeAt(S) !== (v & 255) || (S += 1, e.charCodeAt(S) !== (v >> 8 & 255)))
              break e;
            S += 1, O += 1;
          }
          if (I < C) {
            if (e.charCodeAt(S) !== (o[O] & 255))
              break;
            S += 1;
          }
          h += 1 + (_ >> 1), R = o[h];
          continue;
        }
        let x = R >>> 14, E = e.charCodeAt(S);
        if (x !== 0) {
          if (E === Y.SEMI) {
            l = S - f + 1, d = x === 1 ? String.fromCharCode(R & W.VALUE_MASK) : Ti(o, h, x);
            break;
          }
          if (!t && (R & W.FLAG13) === 0 && (l = S - f, b = h, w = x), x === 1)
            break;
        }
        let P = Fl(o, R, h + (x || 1), E);
        if (P < 0)
          break;
        h = P, R = o[h], S += 1;
      }
      if (d === "") {
        let x = R >>> 14;
        x !== 0 && !t && (R & W.FLAG13) === 0 && (l = S - f, b = h, w = x), l > 0 && (d = Ti(o, b, w));
      }
    } else
      l = 0, d = "";
    l === 0 || n && m !== Y.NUM && e.charCodeAt(f + l - 1) !== Y.SEMI && f + l < i && Ll(e.charCodeAt(f + l)) ? r = f : (s < r && (c += e.slice(s, r)), c += d, r = s = f + l), e.charCodeAt(r) !== Y.AMP && (r = e.indexOf("&", r));
  } while (r >= 0);
  return c + e.slice(s);
}
function Ft(e) {
  return Gl(e, !0, !1);
}

// openclaw/node_modules/.pnpm/entities@8.1.0/node_modules/entities/dist/index.js
var vi;
(function(e) {
  e[e.XML = 0] = "XML", e[e.HTML = 1] = "HTML";
})(vi || (vi = {}));
var Ii;
(function(e) {
  e[e.UTF8 = 0] = "UTF8", e[e.ASCII = 1] = "ASCII", e[e.Extensive = 2] = "Extensive", e[e.Attribute = 3] = "Attribute", e[e.Text = 4] = "Text";
})(Ii || (Ii = {}));

// openclaw/node_modules/.pnpm/linkify-it@6.1.0/node_modules/linkify-it/build/index.mjs
var zl = class {
  src_Any = Cn.source;
  src_Cc = _n.source;
  src_Z = In.source;
  src_P = et.source;
  src_ZPCc = [
    this.src_Z,
    this.src_P,
    this.src_Cc
  ].join("|");
  src_ZCc = [this.src_Z, this.src_Cc].join("|");
  cache = {};
  opts = {
    maxLength: 1e4,
    urlAuth: !1,
    schema_names: []
  };
  constructor(e = {}) {
    this.opts = {
      ...this.opts,
      ...e
    };
  }
  set(e = {}) {
    return this.opts = {
      ...this.opts,
      ...e
    }, this.cache = {}, this;
  }
  escapeRE(e) {
    return e.replace(/[.?*+^$[\]\\(){}|-]/g, "\\$&");
  }
  nestedPairRE(e, t, n = 4) {
    let o = this.escapeRE(e), r = this.escapeRE(t), i = `(?:(?!${this.src_ZCc}|${o}|${r}).)`, s = `${o}${i}{0,1000}${r}`;
    for (let c = 2; c <= n; c++) s = `${o}(?:${i}|${s}){0,1000}${r}`;
    return s;
  }
  get_text_separators() {
    return this.cache.text_separators ??= /[><\uff5c]/;
  }
  get_pseudo_letter() {
    return this.cache.src_pseudo_letter ??= new RegExp(`(?:(?!${this.get_text_separators().source}|${this.src_ZPCc})${this.src_Any})`);
  }
  get_ipv4_addr() {
    return this.cache.src_ip4 ??= /* @__PURE__ */ new RegExp("(?:(?:25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9][0-9]|[0-9])[.]){3}(?:25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9][0-9]|[0-9])");
  }
  get_ipv6_addr() {
    let e = "[0-9A-Fa-f]{1,4}", t = `(?:(?:${e}:${e})|${this.get_ipv4_addr().source})`;
    return this.cache.src_ip6_addr ??= new RegExp(`(?:(?:${e}:){6}${t}|::(?:${e}:){5}${t}|(?:${e})?::(?:${e}:){4}${t}|(?:(?:${e}:){0,1}${e})?::(?:${e}:){3}${t}|(?:(?:${e}:){0,2}${e})?::(?:${e}:){2}${t}|(?:(?:${e}:){0,3}${e})?::${e}:${t}|(?:(?:${e}:){0,4}${e})?::${t}|(?:(?:${e}:){0,5}${e})?::${e}|(?:(?:${e}:){0,6}${e})?::)`);
  }
  get_ipv6_url_host() {
    return this.cache.src_ip6_host ??= new RegExp(`\\[${this.get_ipv6_addr().source}\\]`);
  }
  get_ipv6_mail_host() {
    return this.cache.src_ipv6_mail_host ??= new RegExp(`\\[IPv6:${this.get_ipv6_addr().source}\\]`);
  }
  get_auth() {
    return this.cache.src_auth ??= new RegExp(`(?:(?:(?!${this.src_ZCc}|[@/\\[\\]()]).){1,50}@)?`);
  }
  get_port() {
    return this.cache.src_port ??= /* @__PURE__ */ new RegExp("(?::(?:6(?:[0-4]\\d{3}|5(?:[0-4]\\d{2}|5(?:[0-2]\\d|3[0-5])))|[1-5]?\\d{1,4}))?");
  }
  get_host_terminator() {
    return this.cache.src_host_terminator ??= new RegExp(`(?=$|${this.get_text_separators().source}|${this.src_ZPCc})(?!${this.opts["---"] ? "-(?!--)|" : "-|"}_|:\\d|\\.-|\\.(?!$|${this.src_ZPCc}))`);
  }
  get_path_terminator() {
    return this.cache.src_path_terminator ??= new RegExp(`${this.src_ZPCc}|${this.get_text_separators().source}`);
  }
  get_path() {
    return this.cache.src_path ??= new RegExp(`(?:[/?#](?:${this.nestedPairRE("[", "]")}|${this.nestedPairRE("(", ")")}|${this.nestedPairRE("{", "}")}|\\"(?:(?!${this.src_ZCc}|["]).){1,100}\\"|\\'(?:(?!${this.src_ZCc}|[']).){1,100}\\'|\\'(?=${this.get_pseudo_letter().source}|[-])|\\.{2,20}[:]?[a-zA-Z0-9%/&]|\\.(?!${this.src_ZCc}|[.]|$)|` + (this.opts["---"] ? "\\-(?!--(?:[^-]|$))(?:-{0,19})|" : "\\-{1,20}|") + `,(?!${this.src_ZCc}|$)|;(?!${this.src_ZCc}|$)|\\!{1,20}(?!${this.src_ZCc}|[!]|$)|\\?(?!${this.src_ZCc}|[?]|$)|` + this.get_path_extra().source + `[\\\\/:%@#&=_~*]|(?!${this.get_path_terminator().source}).){1,${this.opts.maxLength}}|\\/)?`);
  }
  get_mail_name() {
    return this.cache.src_mail_name ??= /* @__PURE__ */ new RegExp("[-!#$%&'*+/=?^_`{|}~a-zA-Z0-9](?:[-!#$%&'*+/=?^_`{|}~a-zA-Z0-9]|[.](?=[-!#$%&'*+/=?^_`{|}~a-zA-Z0-9])){0,63}");
  }
  get_xn() {
    return this.cache.src_xn ??= /* @__PURE__ */ new RegExp("xn--[a-z0-9\\-]{1,59}");
  }
  get_tld() {
    if (this.cache.tld) return this.cache.tld;
    let e = [...new Set(this.opts.tlds || [])].sort().reverse().join("|");
    return this.cache.tld = new RegExp(`${e || "$#none#$"}|${this.get_xn().source}`), this.cache.tld;
  }
  get_domain_root() {
    return this.cache.src_domain_root ??= new RegExp("(?:" + this.get_xn().source + `|${this.get_pseudo_letter().source}{1,63})`);
  }
  get_domain() {
    return this.cache.src_domain ??= new RegExp("(?:" + this.get_xn().source + `|(?:${this.get_pseudo_letter().source})|(?:${this.get_pseudo_letter().source}(?:-|${this.get_pseudo_letter().source}){0,61}${this.get_pseudo_letter().source}))`);
  }
  get_url_host_port() {
    return this.cache.url_host_port ??= new RegExp("(?:" + this.get_ipv6_url_host().source + `|(?:(?:(?:${this.get_domain().source})\\.){0,10}${this.get_domain().source}))` + this.get_port().source + this.get_host_terminator().source);
  }
  get_fuzzy_url_host_port() {
    return this.cache.fuzzy_url_host_port ??= new RegExp("(?:" + (this.opts.fuzzyIP ? this.get_ipv4_addr().source + "|" : "") + `(?:(?:(?:${this.get_domain().source})\\.){1,10}(?:${this.get_tld().source})))` + this.get_host_terminator().source);
  }
  get_mail_host() {
    return this.cache.src_mail_host ??= new RegExp("(?:" + this.get_ipv6_mail_host().source + `|(?:(?:(?:${this.get_domain().source})\\.){0,4}${this.get_domain().source}))` + this.get_host_terminator().source);
  }
  get_fuzzy_mail_host() {
    return this.cache.src_fuzzy_mail_host ??= new RegExp("(?:" + this.get_ipv6_mail_host().source + `|(?:(?:(?:${this.get_domain().source})[.]){1,4}${this.get_domain_root().source}))` + this.get_host_terminator().source);
  }
  get_path_extra() {
    return this.cache.src_path_extra ??= /* @__PURE__ */ new RegExp("");
  }
  get_fuzzy_mail_host_search() {
    return this.cache.mail_fuzzy_host_search ??= new RegExp(`@${this.get_fuzzy_mail_host().source}`, "ig");
  }
  get_fuzzy_link_search() {
    return this.cache.link_fuzzy_search ??= new RegExp(`(^|(?![.:/\\-_@])(?:[$+<=>^\`|\uFF5C]|${this.src_ZPCc}))(?:(?![$+<=>^\`|\uFF5C])${this.get_fuzzy_url_host_port().source}${this.get_path().source})`, "ig");
  }
  get_http_validator() {
    return this.cache.http_validator ??= new RegExp("\\/\\/" + (this.opts.urlAuth ? this.get_auth().source : "") + this.get_url_host_port().source + this.get_path().source, "iy");
  }
  get_relative_proto_validator() {
    return this.cache.relative_proto_validator ??= new RegExp((this.opts.urlAuth ? this.get_auth().source : "") + `(?:localhost|${this.get_ipv6_url_host().source}|(?:(?:${this.get_domain().source})[.]){1,10}${this.get_domain_root().source})` + this.get_port().source + this.get_host_terminator().source + this.get_path().source, "iy");
  }
  get_mail_name_validator() {
    return this.cache.mail_name_validator ??= new RegExp(`(?:^|${this.get_text_separators().source}|"|\\(|${this.src_ZCc})(${this.get_mail_name().source})$`);
  }
  get_mailto_validator() {
    return this.cache.mailto_validator ??= new RegExp(`${this.get_mail_name().source}@${this.get_mail_host().source}`, "iy");
  }
  get_schema_names() {
    return this.cache.schema_names ??= new RegExp((this.opts.schema_names || []).map((e) => this.escapeRE(e)).join("|"));
  }
  get_schema_search() {
    return this.cache.schema_search ??= new RegExp(`(^|(?!_)(?:[><\uFF5C]|${this.src_ZPCc}))(${this.get_schema_names().source})`, "ig");
  }
  get_schema_at_start() {
    return this.cache.schema_at_start ??= new RegExp(`^${this.get_schema_search().source}`, "i");
  }
}, On = {
  validate: (e, t, n) => {
    let o = n.re.get_http_validator();
    o.lastIndex = t;
    let r = o.exec(e);
    return r ? r[0].length : 0;
  },
  normalize: (e, t) => t.normalize(e)
}, $l = {
  "http:": On,
  "https:": On,
  "ftp:": On,
  "//": {
    validate: function(e, t, n) {
      let o = n.re.get_relative_proto_validator();
      o.lastIndex = t;
      let r = o.exec(e);
      return r ? t >= 3 && e[t - 3] === ":" || t >= 3 && e[t - 3] === "/" ? 0 : r[0].length : 0;
    },
    normalize: (e, t) => t.normalize(e)
  },
  "mailto:": {
    validate: function(e, t, n) {
      let o = n.re.get_mailto_validator();
      o.lastIndex = t;
      let r = o.exec(e);
      return r ? r[0].length : 0;
    },
    normalize: (e, t) => t.normalize(e)
  }
}, ql = "a:cdefgilmnoqrstuwxz|b:abdefghijmnorstvwyz|c:acdfghiklmnoruvwxyz|d:ejkmoz|e:cegrstu|f:ijkmor|g:abdefghilmnpqrstuwy|h:kmnrtu|i:delmnoqrst|j:emop|k:eghimnprwyz|l:abcikrstuvy|m:acdeghklmnopqrstuvwxyz|n:acefgilopruz|o:m|p:aefghklmnrstwy|q:a|r:eosuw|s:abcdeghijklmnortuvxyz|t:cdfghjklmnortvwz|u:agksyz|v:aceginu|w:fs|y:et|z:amw", Wl = "biz|com|edu|gov|net|org|pro|web|xxx|aero|asia|coop|info|museum|name|shop|\u0440\u0444";
function jl() {
  let e = Wl.split("|");
  return ql.split("|").forEach((t) => {
    let n = t.indexOf(":"), o = t.slice(0, n);
    for (let r of t.slice(n + 1)) e.push(o + r);
  }), e;
}
var Kl = {
  fuzzyLink: !1,
  fuzzyEmail: !0,
  fuzzyIP: !1,
  "---": !1,
  tlds: jl(),
  urlAuth: !1,
  maxLength: 1e4
}, Pi = class {
  /** Prefix (protocol) for matched string. Empty for fuzzy links. */
  schema;
  /** First position of matched string. */
  index;
  /** Next position after matched string. */
  lastIndex;
  /** Matched string. */
  raw;
  /** Normalized text of matched string. */
  text;
  /** Normalized URL of matched string. */
  url;
  constructor(e, t, n, o) {
    let r = e.slice(n, o);
    this.schema = t.toLowerCase(), this.index = n, this.lastIndex = o, this.raw = r, this.text = r, this.url = r;
  }
}, Di = class {
  __opts__;
  __schemas__;
  re;
  /**
  * Creates new linkifier instance.
  *
  * By default understands:
  *
  * - `http(s)://...` , `ftp://...`, `mailto:...` & `//...` links
  * - "fuzzy" emails (foo@bar.com).
  *
  * See {@link LinkifyConstructorOptions} for available options.
  *
  * @param options Recognition options.
  *
  * @example
  * ```javascript
  * import { LinkifyIt } from 'linkify-it'
  *
  * const linkify = new LinkifyIt({ fuzzyLink: true })
  *
  * linkify
  *   .tlds(require('tlds'))       // Reload with full TLD list
  *   .tlds('onion', true)         // Add unofficial `.onion` domain
  *   .add('ftp:', null)           // Disable `ftp:` protocol
  *   .set({ fuzzyIP: true })      // Enable IPs in fuzzy links
  *
  * console.log(linkify.test('Site github.com!')) // true
  * console.log(linkify.match('Site github.com!'))
  * ```
  */
  constructor(e = {}) {
    let { rebuilder: t, ...n } = e;
    this.__opts__ = {
      ...Kl,
      ...n
    }, this.__schemas__ = { ...$l }, this.re = t || new zl(), this.re.set({
      ...this.__opts__,
      schema_names: Object.keys(this.__schemas__)
    });
  }
  /**
  * Add new rule definition.
  *
  * `schema` is a link prefix (usually, protocol name with `:` at the end,
  * `skype:` for example). `linkify-it` makes sure that prefix is not
  * preceded with alphanumeric char and symbols. Only whitespaces and
  * punctuation allowed.
  *
  * `definition` is a rule to check tail after link prefix. To disable an
  * existing rule, pass `null`.
  *
  * @param schema Rule name (fixed pattern prefix).
  * @param definition Schema definition, or `null` to disable the rule.
  *
  * See [twitter mentions example](https://github.com/markdown-it/linkify-it/blob/master/examples/twitter.mjs).
  */
  add(e, t = null) {
    if (!t) delete this.__schemas__[e];
    else {
      let n = {
        normalize: (o, r) => r.normalize(o),
        ...t
      };
      this.__schemas__[e] = n;
    }
    return this.re.set({
      ...this.__opts__,
      schema_names: Object.keys(this.__schemas__)
    }), this;
  }
  /**
  * Set recognition options for links without schema.
  *
  * @param options Recognition options.
  */
  set(e = {}) {
    return this.__opts__ = {
      ...this.__opts__,
      ...e
    }, this.re.set({
      ...this.__opts__,
      schema_names: Object.keys(this.__schemas__)
    }), this;
  }
  /**
  * Searches linkifiable pattern and returns `true` on success or `false` on fail.
  *
  * @param text Text to scan.
  */
  test(e) {
    if (!e.length) return !1;
    let t, n;
    for (n = this.re.get_schema_search(), n.lastIndex = 0; (t = n.exec(e)) !== null; ) if (this.testSchemaAt(e, t[2], n.lastIndex)) return !0;
    if (this.__opts__.fuzzyLink && this.__schemas__["http:"] && (n = this.re.get_fuzzy_link_search(), n.lastIndex = 0, n.exec(e) !== null))
      return !0;
    if (this.__opts__.fuzzyEmail && this.__schemas__["mailto:"] && e.indexOf("@") >= 0) {
      let o = this.re.get_fuzzy_mail_host_search(), r = this.re.get_mail_name_validator();
      for (o.lastIndex = 0; (t = o.exec(e)) !== null; ) {
        let i = e.slice(Math.max(0, t.index - 65), t.index);
        if (r.test(i)) return !0;
      }
    }
    return !1;
  }
  /**
  * Similar to {@link LinkifyIt.test} but checks only specific protocol tail exactly
  * at given position. Returns length of found pattern (0 on fail).
  *
  * @param text Text to scan.
  * @param schema Rule (schema) name.
  * @param pos Text offset to check from.
  */
  testSchemaAt(e, t, n) {
    return this.__schemas__[t.toLowerCase()] ? this.__schemas__[t.toLowerCase()].validate(e.slice(0, n + this.__opts__.maxLength), n, this) : 0;
  }
  /**
  * Returns array of found link descriptions or `null` on fail. We strongly
  * recommend to use {@link LinkifyIt.test} first, for best speed.
  *
  * @param text Text to scan.
  */
  match(e) {
    let t = [], n = this.re.get_schema_search(), o, r, i, s, c, u, p = !1, g = !1, f = !1, m = 0;
    if (!e.length) return null;
    for (n.lastIndex = 0, this.__opts__.fuzzyLink && this.__schemas__["http:"] && (o = this.re.get_fuzzy_link_search(), o.lastIndex = 0), this.__opts__.fuzzyEmail && this.__schemas__["mailto:"] && (r = this.re.get_fuzzy_mail_host_search(), r.lastIndex = 0, i = this.re.get_mail_name_validator()); ; ) {
      let l = Math.max(m - 1, 0);
      if (r && i && !f && (!c || c.index < m))
        for (r.lastIndex < l && (r.lastIndex = l); ; ) {
          let w = r.exec(e);
          if (!w) {
            f = !0, c = void 0;
            break;
          }
          let R = i.exec(e.slice(Math.max(0, w.index - 65), w.index));
          if (R) {
            if (c = {
              schema: "mailto:",
              index: w.index - R[1].length,
              lastIndex: w.index + w[0].length
            }, c.index >= m) break;
            r.lastIndex < l && (r.lastIndex = l);
          }
        }
      if (o && !g && (!s || s.index < m))
        for (o.lastIndex < l && (o.lastIndex = l); ; ) {
          let w = o.exec(e);
          if (!w) {
            g = !0, s = void 0;
            break;
          }
          if (s = {
            schema: "",
            index: w.index + w[1].length,
            lastIndex: w.index + w[0].length
          }, s.index >= m) break;
          o.lastIndex < l && (o.lastIndex = l);
        }
      let d = c;
      (!d || s && (s.index < d.index || s.index === d.index && s.lastIndex > d.lastIndex)) && (d = s);
      let y;
      if (!p) for (; ; ) {
        if (!u) {
          n.lastIndex < l && (n.lastIndex = l);
          let S = n.exec(e);
          if (!S) {
            p = !0;
            break;
          }
          u = {
            schema: S[2],
            index: S.index + S[1].length,
            lastIndex: S.index + S[0].length
          };
        }
        if (u.index < m) {
          u = void 0;
          continue;
        }
        if (d && u.index > d.index) break;
        let w = u;
        u = void 0;
        let R = this.testSchemaAt(e, w.schema, w.lastIndex);
        if (R) {
          y = {
            schema: w.schema,
            index: w.index,
            lastIndex: w.lastIndex + R
          };
          break;
        }
      }
      let h = y;
      if ((!h || c && (c.index < h.index || c.index === h.index && c.lastIndex > h.lastIndex)) && (h = c), (!h || s && (s.index < h.index || s.index === h.index && s.lastIndex > h.lastIndex)) && (h = s), !h) break;
      h === c ? c = void 0 : h === s && (s = void 0);
      let b = new Pi(e, h.schema, h.index, h.lastIndex);
      b.schema ? this.__schemas__[b.schema].normalize(b, this) : this.normalize(b), t.push(b), m = h.lastIndex;
    }
    return t.length ? t : null;
  }
  /**
  * Returns fully-formed (not fuzzy) link if it starts at the beginning
  * of the string, and null otherwise.
  *
  * @param text Text to scan.
  */
  matchAtStart(e) {
    if (!e.length) return null;
    let t = this.re.get_schema_at_start().exec(e);
    if (!t) return null;
    let n = this.testSchemaAt(e, t[2], t[0].length);
    if (!n) return null;
    let o = new Pi(e, t[2], t.index + t[1].length, t.index + t[0].length + n);
    return this.__schemas__[o.schema].normalize(o, this), o;
  }
  /**
  * Load (or merge) new TLDs list. Those are used for fuzzy links (without
  * prefix) to avoid false positives. By default this algorithm is used:
  *
  * - hostname with any 2-letter root zones are ok.
  * - biz|com|edu|gov|net|org|pro|web|xxx|aero|asia|coop|info|museum|name|shop|рф
  *   are ok.
  * - encoded (`xn--...`) root zones are ok.
  *
  * If list is replaced, then exact match for 2-chars root zones will be checked.
  *
  * @param list List of TLDs.
  * @param keepOld Merge with current list if `true` (`false` by default).
  */
  tlds(e, t = !1) {
    return e = Array.isArray(e) ? e : [e], t ? this.__opts__.tlds = this.__opts__.tlds.concat(e) : this.__opts__.tlds = e, this.re.set({
      ...this.__opts__,
      schema_names: Object.keys(this.__schemas__)
    }), this;
  }
  /**
  * Default normalizer (if schema does not define its own).
  *
  * @param match Match to normalize.
  */
  normalize(e) {
    e.schema || (e.url = `http://${e.url}`), e.schema === "mailto:" && !/^mailto:/i.test(e.url) && (e.url = `mailto:${e.url}`);
  }
};

// openclaw/node_modules/.pnpm/markdown-it@15.0.2/node_modules/markdown-it/dist/markdown-it.mjs
var Hn = Xn(Gi(), 1);
var Hi = Object.defineProperty, Qi = (e, t) => {
  let n = {};
  for (var o in e) Hi(n, o, {
    get: e[o],
    enumerable: !0
  });
  return t || Hi(n, Symbol.toStringTag, { value: "Module" }), n;
}, ou = /* @__PURE__ */ Qi({
  arrayReplaceAt: () => iu,
  asciiTrim: () => zt,
  callable: () => es,
  escapeHtml: () => me,
  escapeRE: () => gu,
  fromCodePoint: () => tt,
  isMdAsciiPunct: () => ot,
  isPunctChar: () => ns,
  isPunctCharCode: () => rt,
  isSpace: () => L,
  isValidEntityCode: () => zn,
  isWhiteSpace: () => nt,
  lib: () => mu,
  normalizeReference: () => Ht,
  unescapeAll: () => ze,
  unescapeMd: () => lu
});
function es(e) {
  let t = function(...n) {
    return Reflect.construct(e, n, new.target && new.target !== t ? new.target : e);
  };
  return Object.defineProperty(t, "name", { value: e.name }), Object.setPrototypeOf(t, e), t.prototype = e.prototype, t;
}
function iu(e, t, n) {
  return [].concat(e.slice(0, t), n, e.slice(t + 1));
}
function zn(e) {
  return !(e >= 55296 && e <= 57343 || e >= 64976 && e <= 65007 || (e & 65535) === 65535 || (e & 65535) === 65534 || e >= 0 && e <= 8 || e === 11 || e >= 14 && e <= 31 || e >= 127 && e <= 159 || e > 1114111);
}
function tt(e) {
  if (e > 65535) {
    e -= 65536;
    let t = 55296 + (e >> 10), n = 56320 + (e & 1023);
    return String.fromCharCode(t, n);
  }
  return String.fromCharCode(e);
}
var ts = /\\([!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~])/g, su = new RegExp(`${ts.source}|${/&([a-z#][a-z0-9]{1,31});/gi.source}`, "gi"), au = /^#((?:x[a-f0-9]{1,8}|[0-9]{1,8}))$/i;
function cu(e, t) {
  if (t.charCodeAt(0) === 35 && au.test(t)) {
    let o = t[1].toLowerCase() === "x" ? parseInt(t.slice(2), 16) : parseInt(t.slice(1), 10);
    return zn(o) ? tt(o) : e;
  }
  let n = Ft(e);
  return n !== e ? n : e;
}
function lu(e) {
  return e.indexOf("\\") < 0 ? e : e.replace(ts, "$1");
}
function ze(e) {
  return e.indexOf("\\") < 0 && e.indexOf("&") < 0 ? e : e.replace(su, function(t, n, o) {
    return n || cu(t, o);
  });
}
var uu = /[&<>"]/, du = /[&<>"]/g, pu = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;"
};
function fu(e) {
  return pu[e];
}
function me(e) {
  return uu.test(e) ? e.replace(du, fu) : e;
}
var hu = /[.?*+^$[\]\\(){}|-]/g;
function gu(e) {
  return e.replace(hu, "\\$&");
}
function L(e) {
  switch (e) {
    case 9:
    case 32:
      return !0;
  }
  return !1;
}
function nt(e) {
  if (e >= 8192 && e <= 8202) return !0;
  switch (e) {
    case 9:
    case 10:
    case 11:
    case 12:
    case 13:
    case 32:
    case 160:
    case 5760:
    case 8239:
    case 8287:
    case 12288:
      return !0;
  }
  return !1;
}
function ns(e) {
  return et.test(e) || vn.test(e);
}
function rt(e) {
  return ns(tt(e));
}
function ot(e) {
  switch (e) {
    case 33:
    case 34:
    case 35:
    case 36:
    case 37:
    case 38:
    case 39:
    case 40:
    case 41:
    case 42:
    case 43:
    case 44:
    case 45:
    case 46:
    case 47:
    case 58:
    case 59:
    case 60:
    case 61:
    case 62:
    case 63:
    case 64:
    case 91:
    case 92:
    case 93:
    case 94:
    case 95:
    case 96:
    case 123:
    case 124:
    case 125:
    case 126:
      return !0;
    default:
      return !1;
  }
}
function Ht(e) {
  return e = e.trim().replace(/\s+/g, " "), e.toLowerCase().toUpperCase();
}
function zi(e) {
  return e === 32 || e === 9 || e === 10 || e === 13;
}
function zt(e) {
  let t = 0;
  for (; t < e.length && zi(e.charCodeAt(t)); t++) ;
  let n = e.length - 1;
  for (; n >= t && zi(e.charCodeAt(n)); n--) ;
  return e.slice(t, n + 1);
}
var mu = {
  mdurl: An,
  ucmicro: Pn
};
function yu(e, t, n) {
  let o, r, i, s, c = e.posMax, u = e.pos;
  for (e.pos = t + 1, o = 1; e.pos < c; ) {
    if (i = e.src.charCodeAt(e.pos), i === 93 && (o--, o === 0)) {
      r = !0;
      break;
    }
    if (s = e.pos, e.md.inline.skipToken(e), i === 91) {
      if (s === e.pos - 1) o++;
      else if (n)
        return e.pos = u, -1;
    }
  }
  let p = -1;
  return r && (p = e.pos), e.pos = u, p;
}
function bu(e, t, n) {
  let o, r = t, i = {
    ok: !1,
    pos: 0,
    str: ""
  };
  if (e.charCodeAt(r) === 60) {
    for (r++; r < n; ) {
      if (o = e.charCodeAt(r), o === 10 || o === 60) return i;
      if (o === 62)
        return i.pos = r + 1, i.str = ze(e.slice(t + 1, r)), i.ok = !0, i;
      if (o === 92 && r + 1 < n) {
        r += 2;
        continue;
      }
      r++;
    }
    return i;
  }
  let s = 0;
  for (; r < n && (o = e.charCodeAt(r), !(o === 32 || o < 32 || o === 127)); ) {
    if (o === 92 && r + 1 < n) {
      if (e.charCodeAt(r + 1) === 32) {
        r++;
        continue;
      }
      r += 2;
      continue;
    }
    if (o === 40 && (s++, s > 32))
      return i;
    if (o === 41) {
      if (s === 0) break;
      s--;
    }
    r++;
  }
  return t === r || s !== 0 || (i.str = ze(e.slice(t, r)), i.pos = r, i.ok = !0), i;
}
function wu(e, t, n, o) {
  let r, i = t, s = {
    ok: !1,
    can_continue: !1,
    pos: 0,
    str: "",
    marker: 0
  };
  if (o)
    s.str = o.str, s.marker = o.marker;
  else {
    if (i >= n) return s;
    let c = e.charCodeAt(i);
    if (c !== 34 && c !== 39 && c !== 40) return s;
    t++, i++, c === 40 && (c = 41), s.marker = c;
  }
  for (; i < n; ) {
    if (r = e.charCodeAt(i), r === s.marker)
      return s.pos = i + 1, s.str += ze(e.slice(t, i)), s.ok = !0, s;
    if (r === 40 && s.marker === 41) return s;
    r === 92 && i + 1 < n && i++, i++;
  }
  return s.can_continue = !0, s.str += ze(e.slice(t, i)), s;
}
var Ru = /* @__PURE__ */ Qi({
  parseLinkDestination: () => bu,
  parseLinkLabel: () => yu,
  parseLinkTitle: () => wu
});
function it(e) {
  "@babel/helpers - typeof";
  return it = typeof Symbol == "function" && typeof Symbol.iterator == "symbol" ? function(t) {
    return typeof t;
  } : function(t) {
    return t && typeof Symbol == "function" && t.constructor === Symbol && t !== Symbol.prototype ? "symbol" : typeof t;
  }, it(e);
}
function Su(e, t) {
  if (it(e) != "object" || !e) return e;
  var n = e[Symbol.toPrimitive];
  if (n !== void 0) {
    var o = n.call(e, t || "default");
    if (it(o) != "object") return o;
    throw new TypeError("@@toPrimitive must return a primitive value.");
  }
  return (t === "string" ? String : Number)(e);
}
function xu(e) {
  var t = Su(e, "string");
  return it(t) == "symbol" ? t : t + "";
}
function k(e, t, n) {
  return (t = xu(t)) in e ? Object.defineProperty(e, t, {
    value: n,
    enumerable: !0,
    configurable: !0,
    writable: !0
  }) : e[t] = n, e;
}
var De = class {
  constructor(e, t, n) {
    k(
      this,
      /**
      * Source map info. Format: `[ line_begin, line_end ]`
      */
      "map",
      null
    ), k(
      this,
      /**
      * nesting level, the same as `state.level`
      */
      "level",
      0
    ), k(
      this,
      /**
      * An array of child nodes (inline and img tokens)
      */
      "children",
      null
    ), k(
      this,
      /**
      * In a case of self-closing tag (code, html, fence, etc.),
      * it has contents of this tag.
      */
      "content",
      ""
    ), k(
      this,
      /**
      * '*' or '_' for emphasis, fence string for fence, etc.
      */
      "markup",
      ""
    ), k(
      this,
      /**
      * Additional information:
      *
      * - Info string for "fence" tokens
      * - The value "auto" for autolink "link_open" and "link_close" tokens
      * - The string value of the item marker for ordered-list "list_item_open" tokens
      */
      "info",
      ""
    ), k(
      this,
      /**
      * True for block-level tokens, false for inline tokens.
      * Used in renderer to calculate line breaks
      */
      "block",
      !1
    ), k(
      this,
      /**
      * If it's true, ignore this element when rendering. Used for tight lists
      * to hide paragraphs.
      */
      "hidden",
      !1
    ), this.type = e, this.tag = t, this.attrs = null, this.nesting = n, this.meta = null;
  }
  /**
  * Search attribute index by name.
  */
  attrIndex(e) {
    if (!this.attrs) return -1;
    let t = this.attrs;
    for (let n = 0, o = t.length; n < o; n++) if (t[n][0] === e) return n;
    return -1;
  }
  /**
  * Add `[ name, value ]` attribute to list. Init attrs if necessary
  */
  attrPush(e) {
    this.attrs ? this.attrs.push(e) : this.attrs = [e];
  }
  /**
  * Set `name` attribute to `value`. Override old value if exists.
  */
  attrSet(e, t) {
    let n = this.attrIndex(e), o = [e, t];
    n < 0 ? this.attrPush(o) : this.attrs[n] = o;
  }
  /**
  * Get the value of attribute `name`, or null if it does not exist.
  */
  attrGet(e) {
    let t = this.attrIndex(e), n = null;
    return t >= 0 && (n = this.attrs[t][1]), n;
  }
  /**
  * Join value to existing attribute via space. Or create new attribute if not
  * exists. Useful to operate with token classes.
  */
  attrJoin(e, t) {
    let n = this.attrIndex(e);
    n < 0 ? this.attrPush([e, t]) : this.attrs[n][1] = `${this.attrs[n][1]} ${t}`;
  }
}, st = class {
  constructor() {
    k(
      this,
      /** @internal */
      "__rules__",
      []
    ), k(
      this,
      /** @internal */
      "__cache__",
      null
    );
  }
  /** @internal */
  __find__(e) {
    for (let t = 0; t < this.__rules__.length; t++) if (this.__rules__[t].name === e) return t;
    return -1;
  }
  /** @internal */
  __compile__() {
    let e = /* @__PURE__ */ new Set();
    this.__rules__.forEach((t) => {
      t.enabled && t.alt.forEach((n) => {
        n && e.add(n);
      });
    }), this.__cache__ = /* @__PURE__ */ Object.create(null), this.__cache__[""] = [], this.__rules__.forEach((t) => {
      t.enabled && this.__cache__[""].push(t.fn);
    }), e.forEach((t) => {
      this.__cache__[t] = [], this.__rules__.forEach((n) => {
        n.enabled && n.alt.indexOf(t) >= 0 && this.__cache__[t].push(n.fn);
      });
    });
  }
  /**
  * Replace rule by name with new function & options. Throws error if name not
  * found.
  *
  * @example Replace existing typographer replacement rule with new one
  * ```javascript
  * import MarkdownIt from 'markdown-it'
  * const md = new MarkdownIt()
  *
  * md.core.ruler.at('replacements', function replace(state) {
  *   //...
  * });
  * ```
  */
  at(e, t, n = {}) {
    let o = this.__find__(e);
    if (o === -1) throw new Error(`Parser rule not found: ${e}`);
    this.__rules__[o].fn = t, this.__rules__[o].alt = n.alt || [], this.__cache__ = null;
  }
  /**
  * Add new rule to chain before one with given name. See also
  * {@link Ruler.after}, {@link Ruler.push}.
  *
  * @example
  * ```javascript
  * import MarkdownIt from 'markdown-it'
  * const md = new MarkdownIt()
  *
  * md.block.ruler.before('paragraph', 'my_rule', function replace(state) {
  *   //...
  * });
  * ```
  */
  before(e, t, n, o = {}) {
    let r = this.__find__(e);
    if (r === -1) throw new Error(`Parser rule not found: ${e}`);
    this.__rules__.splice(r, 0, {
      name: t,
      enabled: !0,
      fn: n,
      alt: o.alt || []
    }), this.__cache__ = null;
  }
  /**
  * Add new rule to chain after one with given name. See also
  * {@link Ruler.before}, {@link Ruler.push}.
  *
  * @example
  * ```javascript
  * import MarkdownIt from 'markdown-it'
  * const md = new MarkdownIt()
  *
  * md.inline.ruler.after('text', 'my_rule', function replace(state) {
  *   //...
  * });
  * ```
  */
  after(e, t, n, o = {}) {
    let r = this.__find__(e);
    if (r === -1) throw new Error(`Parser rule not found: ${e}`);
    this.__rules__.splice(r + 1, 0, {
      name: t,
      enabled: !0,
      fn: n,
      alt: o.alt || []
    }), this.__cache__ = null;
  }
  /**
  * Push new rule to the end of chain. See also
  * {@link Ruler.before}, {@link Ruler.after}.
  *
  * @example
  * ```javascript
  * import MarkdownIt from 'markdown-it'
  * const md = new MarkdownIt()
  *
  * md.core.ruler.push('my_rule', function replace(state) {
  *   //...
  * });
  * ```
  */
  push(e, t, n = {}) {
    this.__rules__.push({
      name: e,
      enabled: !0,
      fn: t,
      alt: n.alt || []
    }), this.__cache__ = null;
  }
  /**
  * Enable rules with given names. If any rule name not found - throw Error.
  * Errors can be disabled by second param.
  *
  * See also {@link Ruler.disable}, {@link Ruler.enableOnly}.
  *
  * Returns list of found rule names (if no exception happened).
  */
  enable(e, t = !1) {
    Array.isArray(e) || (e = [e]);
    let n = [];
    return e.forEach((o) => {
      let r = this.__find__(o);
      if (r < 0) {
        if (t) return;
        throw new Error(`Rules manager: invalid rule name ${o}`);
      }
      this.__rules__[r].enabled = !0, n.push(o);
    }), this.__cache__ = null, n;
  }
  /**
  * Enable rules with given names, and disable everything else. If any rule name
  * not found - throw Error. Errors can be disabled by second param.
  *
  * See also {@link Ruler.disable}, {@link Ruler.enable}.
  */
  enableOnly(e, t = !1) {
    Array.isArray(e) || (e = [e]), this.__rules__.forEach((n) => {
      n.enabled = !1;
    }), this.enable(e, t);
  }
  /**
  * Disable rules with given names. If any rule name not found - throw Error.
  * Errors can be disabled by second param.
  *
  * See also {@link Ruler.enable}, {@link Ruler.enableOnly}.
  *
  * Returns list of found rule names (if no exception happened).
  */
  disable(e, t = !1) {
    Array.isArray(e) || (e = [e]);
    let n = [];
    return e.forEach((o) => {
      let r = this.__find__(o);
      if (r < 0) {
        if (t) return;
        throw new Error(`Rules manager: invalid rule name ${o}`);
      }
      this.__rules__[r].enabled = !1, n.push(o);
    }), this.__cache__ = null, n;
  }
  /**
  * Return array of active functions (rules) for given chain name. It analyzes
  * rules configuration, compiles caches if not exists and returns result.
  *
  * Default chain name is `''` (empty string). It can't be skipped. That's
  * done intentionally, to keep signature monomorphic for high speed.
  */
  getRules(e) {
    return this.__cache__ || this.__compile__(), this.__cache__[e] || [];
  }
}, oe = {};
oe.code_inline = function(e, t, n, o, r) {
  let i = e[t];
  return `<code${r.renderAttrs(i)}>${me(i.content)}</code>`;
};
oe.code_block = function(e, t, n, o, r) {
  let i = e[t];
  return `<pre${r.renderAttrs(i)}><code>${me(e[t].content)}</code></pre>
`;
};
oe.fence = function(e, t, n, o, r) {
  let i = e[t], s = i.info ? ze(i.info).trim() : "", c = "", u = "";
  if (s) {
    let g = s.split(/(\s+)/g);
    c = g[0], u = g.slice(2).join("");
  }
  let p;
  if (n.highlight ? p = n.highlight(i.content, c, u) || me(i.content) : p = me(i.content), p.indexOf("<pre") === 0) return p + `
`;
  if (s) {
    let g = i.attrIndex("class"), f = i.attrs ? i.attrs.slice() : [];
    g < 0 ? f.push(["class", `${n.langPrefix}${c}`]) : (f[g] = [f[g][0], f[g][1]], f[g][1] += ` ${n.langPrefix}${c}`);
    let m = { attrs: f };
    return `<pre><code${r.renderAttrs(m)}>${p}</code></pre>
`;
  }
  return `<pre><code${r.renderAttrs(i)}>${p}</code></pre>
`;
};
oe.image = function(e, t, n, o, r) {
  let i = e[t];
  return i.attrs[i.attrIndex("alt")][1] = r.renderInlineAsText(i.children, n, o), r.renderToken(e, t, n);
};
oe.hardbreak = function(e, t, n) {
  return n.xhtmlOut ? `<br />
` : `<br>
`;
};
oe.softbreak = function(e, t, n) {
  return n.breaks ? n.xhtmlOut ? `<br />
` : `<br>
` : `
`;
};
oe.text = function(e, t) {
  return me(e[t].content);
};
oe.html_block = function(e, t) {
  return e[t].content;
};
oe.html_inline = function(e, t) {
  return e[t].content;
};
var rs = class {
  constructor() {
    k(
      this,
      /**
      * Contains render rules for tokens. Can be updated and extended.
      *
      * See [source code](https://github.com/markdown-it/markdown-it/blob/master/src/renderer.ts)
      * for more details and examples.
      *
      * @example Custom render rules
      * ```javascript
      * import MarkdownIt from 'markdown-it'
      * const md = new MarkdownIt()
      *
      * md.renderer.rules.strong_open  = function () { return '<b>'; };
      * md.renderer.rules.strong_close = function () { return '</b>'; };
      *
      * const result = md.renderInline(...);
      * ```
      *
      * @example Each rule is called as independent static function with fixed signature
      * ```javascript
      * function my_token_render(tokens, idx, options, env, renderer) {
      *   // ...
      *   return renderedHTML;
      * }
      * ```
      */
      "rules",
      Object.assign({}, oe)
    );
  }
  /**
  * Render token attributes to string.
  */
  renderAttrs(e) {
    let t, n, o;
    if (!e.attrs) return "";
    for (o = "", t = 0, n = e.attrs.length; t < n; t++) o += ` ${me(e.attrs[t][0])}="${me(String(e.attrs[t][1]))}"`;
    return o;
  }
  /**
  * Default token renderer. Can be overriden by custom function
  * in {@link Renderer.rules}.
  */
  renderToken(e, t, n) {
    let o = e[t], r = "";
    if (o.hidden) return "";
    let i = t - 1;
    for (; i >= 0 && e[i].hidden && e[i].nesting === 0; ) i--;
    o.block && o.nesting !== -1 && i >= 0 && e[i].hidden && e[i].nesting === -1 && (r += `
`), r += (o.nesting === -1 ? "</" : "<") + o.tag, r += this.renderAttrs(o), o.nesting === 0 && n.xhtmlOut && (r += " /");
    let s = !1;
    if (o.block && (s = !0, o.nesting === 1)) {
      let c = t + 1;
      for (; c < e.length && e[c].hidden && e[c].nesting === 0; ) c++;
      if (c < e.length) {
        let u = e[c];
        (u.type === "inline" || u.hidden || u.nesting === -1 && u.tag === o.tag) && (s = !1);
      }
    }
    return r += s ? `>
` : ">", r;
  }
  /**
  * The same as {@link Renderer.render}, but for single token of `inline` type.
  */
  renderInline(e, t, n) {
    let o = "", r = this.rules;
    for (let i = 0, s = e.length; i < s; i++) {
      let c = e[i].type;
      typeof r[c] < "u" ? o += r[c](e, i, t, n, this) : o += this.renderToken(e, i, t);
    }
    return o;
  }
  /**
  * Special kludge for image `alt` attributes to conform CommonMark spec.
  * Don't try to use it! Spec requires to show `alt` content with stripped markup,
  * instead of simple escaping.
  */
  renderInlineAsText(e, t, n) {
    let o = "";
    for (let r = 0, i = e.length; r < i; r++) switch (e[r].type) {
      case "text":
      case "code_inline":
        o += e[r].content;
        break;
      case "image":
        o += this.renderInlineAsText(e[r].children, t, n);
        break;
      case "html_inline":
      case "html_block":
        o += e[r].content;
        break;
      case "softbreak":
      case "hardbreak":
        o += `
`;
    }
    return o;
  }
  /**
  * Takes token stream and generates HTML. Probably, you will never need to call
  * this method directly.
  */
  render(e, t, n) {
    let o = "", r = this.rules;
    for (let i = 0, s = e.length; i < s; i++) {
      let c = e[i].type;
      c === "inline" ? o += this.renderInline(e[i].children, t, n) : typeof r[c] < "u" ? o += r[c](e, i, t, n, this) : o += this.renderToken(e, i, t);
    }
    return o;
  }
}, os = class {
  constructor(e, t, n) {
    k(this, "tokens", []), k(this, "inlineMode", !1), k(this, "Token", De), this.src = e, this.env = n, this.md = t;
  }
}, Eu = /\r\n?/g, Tu = /\0/g;
function ku(e) {
  let t;
  t = e.src.replace(Eu, `
`), t = t.replace(Tu, "\uFFFD"), e.src = t;
}
function Au(e) {
  let t;
  e.inlineMode ? (t = new e.Token("inline", "", 0), t.content = e.src, t.map = [0, 1], t.children = [], e.tokens.push(t)) : e.md.block.parse(e.src, e.md, e.env, e.tokens);
}
function Cu(e) {
  let t = e.tokens, n = 0;
  for (let o = 0; o < t.length; o++)
    t[o].type !== "reference_definition" && (o !== n && (t[n] = t[o]), n++);
  t.length !== n && (t.length = n);
}
function _u(e) {
  let t = e.tokens;
  for (let n = 0, o = t.length; n < o; n++) {
    let r = t[n];
    r.type === "inline" && e.md.inline.parse(r.content, e.md, e.env, r.children);
  }
}
function vu(e) {
  return /^<a[>\s]/i.test(e);
}
function Iu(e) {
  return /^<\/a\s*>/i.test(e);
}
function Pu(e) {
  let t = e.tokens;
  if (e.md.options.linkify)
    for (let n = 0, o = t.length; n < o; n++) {
      if (t[n].type !== "inline" || !e.md.linkify.test(t[n].content)) continue;
      let r = t[n].children, i = [], s = 0;
      for (let c = r.length - 1; c >= 0; c--) {
        let u = r[c];
        if (u.type === "link_close") {
          for (c--; r[c].level !== u.level && r[c].type !== "link_open"; ) c--;
          continue;
        }
        if (u.type === "html_inline" && (vu(u.content) && s > 0 && s--, Iu(u.content) && s++), !(s > 0) && u.type === "text" && e.md.linkify.test(u.content)) {
          let p = u.content, g = e.md.linkify.match(p), f = [], m = u.level, l = 0;
          g.length > 0 && g[0].index === 0 && c > 0 && r[c - 1].type === "text_special" && (g = g.slice(1));
          for (let d = 0; d < g.length; d++) {
            let y = g[d].url, h = e.md.normalizeLink(y);
            if (!e.md.validateLink(h)) continue;
            let b = g[d].text;
            g[d].schema ? g[d].schema === "mailto:" && !/^mailto:/i.test(b) ? b = e.md.normalizeLinkText(`mailto:${b}`).replace(/^mailto:/, "") : b = e.md.normalizeLinkText(b) : b = e.md.normalizeLinkText(`http://${b}`).replace(/^http:\/\//, "");
            let w = g[d].index;
            if (w > l) {
              let E = new e.Token("text", "", 0);
              E.content = p.slice(l, w), E.level = m, f.push(E);
            }
            let R = new e.Token("link_open", "a", 1);
            R.attrs = [["href", h]], R.level = m++, R.markup = "linkify", R.info = "auto", f.push(R);
            let S = new e.Token("text", "", 0);
            S.content = b, S.level = m, f.push(S);
            let x = new e.Token("link_close", "a", -1);
            x.level = --m, x.markup = "linkify", x.info = "auto", f.push(x), l = g[d].lastIndex;
          }
          if (l < p.length) {
            let d = new e.Token("text", "", 0);
            d.content = p.slice(l), d.level = m, f.push(d);
          }
          i.push({
            index: c,
            nodes: f
          });
        }
      }
      if (i.length > 0) {
        let c = r.length;
        for (let f of i) c += f.nodes.length - 1;
        let u = new Array(c), p = 0, g = 0;
        i.reverse();
        for (let f = 0; f < r.length; f++) {
          let m = i[p];
          if (m?.index === f) {
            for (let l of m.nodes) u[g++] = l;
            p++;
          } else u[g++] = r[f];
        }
        t[n].children = u;
      }
    }
}
var is = /\+-|\.\.|\?\?\?\?|!!!!|,,|--/, Du = /\((c|tm|r)\)/i, Mu = /\((c|tm|r)\)/gi, Ou = {
  c: "\xA9",
  r: "\xAE",
  tm: "\u2122"
};
function Nu(e, t) {
  return Ou[t.toLowerCase()];
}
function Uu(e) {
  let t = 0;
  for (let n = e.length - 1; n >= 0; n--) {
    let o = e[n];
    o.type === "text" && !t && (o.content = o.content.replace(Mu, Nu)), o.type === "link_open" && o.info === "auto" && t--, o.type === "link_close" && o.info === "auto" && t++;
  }
}
function Lu(e) {
  let t = 0;
  for (let n = e.length - 1; n >= 0; n--) {
    let o = e[n];
    o.type === "text" && !t && is.test(o.content) && (o.content = o.content.replace(/\+-/g, "\xB1").replace(/\.{2,}/g, "\u2026").replace(/([?!])…/g, "$1..").replace(/([?!]){4,}/g, "$1$1$1").replace(/,{2,}/g, ",").replace(/(^|[^-])---(?=[^-]|$)/gm, "$1\u2014").replace(/(^|\s)--(?=\s|$)/gm, "$1\u2013").replace(/(^|[^-\s])--(?=[^-\s]|$)/gm, "$1\u2013")), o.type === "link_open" && o.info === "auto" && t--, o.type === "link_close" && o.info === "auto" && t++;
  }
}
function Fu(e) {
  let t;
  if (e.md.options.typographer)
    for (t = e.tokens.length - 1; t >= 0; t--)
      e.tokens[t].type === "inline" && (Du.test(e.tokens[t].content) && Uu(e.tokens[t].children), is.test(e.tokens[t].content) && Lu(e.tokens[t].children));
}
var Bu = /['"]/, $i = /['"]/g, qi = "\u2019", Gu = 1e3;
function Wi(e, t, n) {
  for (; e.length > n; ) {
    let o = e.pop();
    o.isSingleQuote ? t.single = o.prevSameQuoteIdx : t.double = o.prevSameQuoteIdx;
  }
}
function Bt(e, t, n, o) {
  e[t] || (e[t] = []), e[t].push({
    pos: n,
    ch: o
  });
}
function Hu(e, t) {
  let n = "", o = 0;
  t.sort((r, i) => r.pos - i.pos);
  for (let r = 0; r < t.length; r++) {
    let i = t[r];
    n += e.slice(o, i.pos) + i.ch, o = i.pos + 1;
  }
  return n + e.slice(o);
}
function zu(e, t) {
  let n, o = [], r = {
    single: -1,
    double: -1
  }, i = {};
  for (let s = 0; s < e.length; s++) {
    let c = e[s], u = e[s].level;
    for (n = o.length - 1; n >= 0 && !(o[n].level <= u); n--) ;
    if (Wi(o, r, n + 1), c.type !== "text") continue;
    let p = c.content, g = 0, f = p.length;
    e: for (; g < f; ) {
      $i.lastIndex = g;
      let m = $i.exec(p);
      if (!m) break;
      let l = !0, d = !0;
      g = m.index + 1;
      let y = m[0] === "'", h = 32;
      if (m.index - 1 >= 0) h = p.charCodeAt(m.index - 1);
      else for (n = s - 1; n >= 0 && !(e[n].type === "softbreak" || e[n].type === "hardbreak"); n--)
        if (e[n].content) {
          h = e[n].content.charCodeAt(e[n].content.length - 1);
          break;
        }
      let b = 32;
      if (g < f) b = p.charCodeAt(g);
      else for (n = s + 1; n < e.length && !(e[n].type === "softbreak" || e[n].type === "hardbreak"); n++)
        if (e[n].content) {
          b = e[n].content.charCodeAt(0);
          break;
        }
      let w = ot(h) || rt(h), R = ot(b) || rt(b), S = nt(h), x = nt(b);
      if (x ? l = !1 : R && (S || w || (l = !1)), S ? d = !1 : w && (x || R || (d = !1)), b === 34 && m[0] === '"' && h >= 48 && h <= 57 && (d = l = !1), l && d && (l = w, d = R), !l && !d) {
        y && Bt(i, s, m.index, qi);
        continue;
      }
      if (d && (n = y ? r.single : r.double, n >= 0 && o[n].level === u)) {
        let E = o[n], P, _;
        y ? (P = t.md.options.quotes[2], _ = t.md.options.quotes[3]) : (P = t.md.options.quotes[0], _ = t.md.options.quotes[1]), Bt(i, s, m.index, _), Bt(i, E.tokenIdx, E.contentPos, P), Wi(o, r, n);
        continue e;
      }
      if (l) {
        if (o.length >= Gu) return;
        o.push({
          tokenIdx: s,
          contentPos: m.index,
          isSingleQuote: y,
          level: u,
          prevSameQuoteIdx: y ? r.single : r.double
        }), y ? r.single = o.length - 1 : r.double = o.length - 1;
      } else d && y && Bt(i, s, m.index, qi);
    }
  }
  Object.keys(i).forEach(function(s) {
    let c = Number(s);
    e[c].content = Hu(e[c].content, i[s]);
  });
}
function $u(e) {
  if (e.md.options.typographer)
    for (let t = e.tokens.length - 1; t >= 0; t--)
      e.tokens[t].type !== "inline" || !Bu.test(e.tokens[t].content) || zu(e.tokens[t].children, e);
}
function qu(e) {
  let t, n, o = e.length;
  for (t = 0; t < o; t++) e[t].type === "text_special" && (e[t].type = "text");
  for (t = n = 0; t < o; t++) e[t].type === "text" && t + 1 < o && e[t + 1].type === "text" ? e[t + 1].content = e[t].content + e[t + 1].content : (t !== n && (e[n] = e[t]), n++);
  t !== n && (e.length = n);
}
function Wu(e) {
  let t, n, o = e.tokens, r = o.length;
  for (let i = 0; i < r; i++) {
    if (o[i].type !== "inline") continue;
    let s = o[i].children, c = s.length;
    for (t = 0; t < c; t++)
      s[t].type === "text_special" && (s[t].type = "text"), s[t].children && qu(s[t].children);
    for (t = n = 0; t < c; t++) s[t].type === "text" && t + 1 < c && s[t + 1].type === "text" ? s[t + 1].content = s[t].content + s[t + 1].content : (t !== n && (s[n] = s[t]), n++);
    t !== n && (s.length = n);
  }
}
var Ln = [
  ["normalize", ku],
  ["block", Au],
  ["strip_references", Cu],
  ["inline", _u],
  ["linkify", Pu],
  ["replacements", Fu],
  ["smartquotes", $u],
  ["text_join", Wu]
], ss = class {
  constructor() {
    k(
      this,
      /**
      * {@link Ruler} instance. Keep configuration of core rules.
      */
      "ruler",
      new st()
    ), k(this, "State", os);
    for (let e = 0; e < Ln.length; e++) this.ruler.push(Ln[e][0], Ln[e][1]);
  }
  /**
  * Executes core chain rules.
  */
  process(e) {
    let t = this.ruler.getRules("");
    for (let n = 0, o = t.length; n < o; n++) t[n](e);
  }
}, as = class {
  constructor(e, t, n, o) {
    k(this, "bMarks", []), k(this, "eMarks", []), k(this, "tShift", []), k(this, "sCount", []), k(this, "bsCount", []), k(this, "blkIndent", 0), k(this, "line", 0), k(this, "lineMax", 0), k(this, "tight", !1), k(this, "listIndent", -1), k(this, "parentType", "root"), k(this, "level", 0), k(this, "Token", De), this.src = e, this.md = t, this.env = n, this.tokens = o;
    let r = this.src;
    for (let i = 0, s = 0, c = 0, u = 0, p = r.length, g = !1; s < p; s++) {
      let f = r.charCodeAt(s);
      if (!g) if (L(f)) {
        c++, f === 9 ? u += 4 - u % 4 : u++;
        continue;
      } else g = !0;
      (f === 10 || s === p - 1) && (f !== 10 && s++, this.bMarks.push(i), this.eMarks.push(s), this.tShift.push(c), this.sCount.push(u), this.bsCount.push(0), g = !1, c = 0, u = 0, i = s + 1);
    }
    this.bMarks.push(r.length), this.eMarks.push(r.length), this.tShift.push(0), this.sCount.push(0), this.bsCount.push(0), this.lineMax = this.bMarks.length - 1;
  }
  push(e, t, n) {
    let o = new De(e, t, n);
    return o.block = !0, n < 0 && this.level--, o.level = this.level, n > 0 && this.level++, this.tokens.push(o), o;
  }
  isEmpty(e) {
    return this.bMarks[e] + this.tShift[e] >= this.eMarks[e];
  }
  skipEmptyLines(e) {
    for (let t = this.lineMax; e < t && !(this.bMarks[e] + this.tShift[e] < this.eMarks[e]); e++) ;
    return e;
  }
  skipSpaces(e) {
    for (let t = this.src.length; e < t && L(this.src.charCodeAt(e)); e++) ;
    return e;
  }
  skipSpacesBack(e, t) {
    if (e <= t) return e;
    for (; e > t; ) if (!L(this.src.charCodeAt(--e))) return e + 1;
    return e;
  }
  skipChars(e, t) {
    for (let n = this.src.length; e < n && this.src.charCodeAt(e) === t; e++) ;
    return e;
  }
  skipCharsBack(e, t, n) {
    if (e <= n) return e;
    for (; e > n; ) if (t !== this.src.charCodeAt(--e)) return e + 1;
    return e;
  }
  getLines(e, t, n, o) {
    if (e >= t) return "";
    let r = new Array(t - e);
    for (let i = 0, s = e; s < t; s++, i++) {
      let c = 0, u = this.bMarks[s], p = u, g;
      for (s + 1 < t || o ? g = this.eMarks[s] + 1 : g = this.eMarks[s]; p < g && c < n; ) {
        let f = this.src.charCodeAt(p);
        if (L(f)) f === 9 ? c += 4 - (c + this.bsCount[s]) % 4 : c++;
        else if (p - u < this.tShift[s]) c++;
        else break;
        p++;
      }
      c > n ? r[i] = new Array(c - n + 1).join(" ") + this.src.slice(p, g) : r[i] = this.src.slice(p, g);
    }
    return r.join("");
  }
}, ju = 65536;
function Fn(e, t) {
  let n = e.bMarks[t] + e.tShift[t], o = e.eMarks[t];
  return e.src.slice(n, o);
}
function ji(e) {
  let t = [], n = e.length, o = 0, r = e.charCodeAt(o), i = !1, s = 0, c = "";
  for (; o < n; )
    r === 124 && (i ? (c += e.substring(s, o - 1), s = o) : (t.push(c + e.substring(s, o)), c = "", s = o + 1)), i = r === 92, o++, r = e.charCodeAt(o);
  return t.push(c + e.substring(s)), t;
}
function Ku(e, t, n, o) {
  if (t + 2 > n) return !1;
  let r = t + 1;
  if (e.sCount[r] < e.blkIndent || e.sCount[r] - e.blkIndent >= 4) return !1;
  let i = e.bMarks[r] + e.tShift[r];
  if (i >= e.eMarks[r]) return !1;
  let s = e.src.charCodeAt(i++);
  if (s !== 124 && s !== 45 && s !== 58 || i >= e.eMarks[r]) return !1;
  let c = e.src.charCodeAt(i++);
  if (c !== 124 && c !== 45 && c !== 58 && !L(c) || s === 45 && L(c)) return !1;
  for (; i < e.eMarks[r]; ) {
    let S = e.src.charCodeAt(i);
    if (S !== 124 && S !== 45 && S !== 58 && !L(S)) return !1;
    i++;
  }
  let u = Fn(e, t + 1), p = u.split("|"), g = [];
  for (let S = 0; S < p.length; S++) {
    let x = p[S].trim();
    if (!x) {
      if (S === 0 || S === p.length - 1) continue;
      return !1;
    }
    if (!/^:?-+:?$/.test(x)) return !1;
    x.charCodeAt(x.length - 1) === 58 ? g.push(x.charCodeAt(0) === 58 ? "center" : "right") : x.charCodeAt(0) === 58 ? g.push("left") : g.push("");
  }
  if (u = Fn(e, t).trim(), u.indexOf("|") === -1 || e.sCount[t] - e.blkIndent >= 4) return !1;
  p = ji(u), p.length && p[0] === "" && p.shift(), p.length && p[p.length - 1] === "" && p.pop();
  let f = p.length;
  if (f === 0 || f !== g.length) return !1;
  if (o) return !0;
  let m = e.parentType;
  e.parentType = "table";
  let l = e.md.block.ruler.getRules("blockquote"), d = e.push("table_open", "table", 1), y = [t, 0];
  d.map = y;
  let h = e.push("thead_open", "thead", 1);
  h.map = [t, t + 1];
  let b = e.push("tr_open", "tr", 1);
  b.map = [t, t + 1];
  for (let S = 0; S < p.length; S++) {
    let x = e.push("th_open", "th", 1);
    g[S] && (x.attrs = [["style", `text-align:${g[S]}`]]);
    let E = e.push("inline", "", 0);
    E.content = p[S].trim(), E.children = [], e.push("th_close", "th", -1);
  }
  e.push("tr_close", "tr", -1), e.push("thead_close", "thead", -1);
  let w, R = 0;
  for (r = t + 2; r < n && !(e.sCount[r] < e.blkIndent); r++) {
    let S = !1;
    for (let E = 0, P = l.length; E < P; E++) if (l[E](e, r, n, !0)) {
      S = !0;
      break;
    }
    if (S || (u = Fn(e, r).trim(), !u) || e.sCount[r] - e.blkIndent >= 4 || (p = ji(u), p.length && p[0] === "" && p.shift(), p.length && p[p.length - 1] === "" && p.pop(), R += f - p.length, R > ju)) break;
    if (r === t + 2) {
      let E = e.push("tbody_open", "tbody", 1);
      E.map = w = [t + 2, 0];
    }
    let x = e.push("tr_open", "tr", 1);
    x.map = [r, r + 1];
    for (let E = 0; E < f; E++) {
      let P = e.push("td_open", "td", 1);
      g[E] && (P.attrs = [["style", `text-align:${g[E]}`]]);
      let _ = e.push("inline", "", 0);
      _.content = p[E] ? p[E].trim() : "", _.children = [], e.push("td_close", "td", -1);
    }
    e.push("tr_close", "tr", -1);
  }
  return w && (e.push("tbody_close", "tbody", -1), w[1] = r), e.push("table_close", "table", -1), y[1] = r, e.parentType = m, e.line = r, !0;
}
function Vu(e, t, n) {
  if (e.sCount[t] - e.blkIndent < 4) return !1;
  let o = t + 1, r = o;
  for (; o < n; ) {
    if (e.isEmpty(o)) {
      o++;
      continue;
    }
    if (e.sCount[o] - e.blkIndent >= 4) {
      o++, r = o;
      continue;
    }
    break;
  }
  e.line = r;
  let i = e.push("code_block", "code", 0);
  return i.content = e.getLines(t, r, 4 + e.blkIndent, !1) + `
`, i.map = [t, e.line], !0;
}
function Yu(e, t, n, o) {
  let r = e.bMarks[t] + e.tShift[t], i = e.eMarks[t];
  if (e.sCount[t] - e.blkIndent >= 4 || r + 3 > i) return !1;
  let s = e.src.charCodeAt(r);
  if (s !== 126 && s !== 96) return !1;
  let c = r;
  r = e.skipChars(r, s);
  let u = r - c;
  if (u < 3) return !1;
  let p = e.src.slice(c, r), g = e.src.slice(r, i);
  if (s === 96 && g.indexOf(String.fromCharCode(s)) >= 0)
    return !1;
  if (o) return !0;
  let f = t, m = !1;
  for (; f++, !(f >= n || (r = c = e.bMarks[f] + e.tShift[f], i = e.eMarks[f], r < i && e.sCount[f] < e.blkIndent)); )
    if (e.src.charCodeAt(r) === s && !(e.sCount[f] - e.blkIndent >= 4) && (r = e.skipChars(r, s), !(r - c < u) && (r = e.skipSpaces(r), !(r < i)))) {
      m = !0;
      break;
    }
  u = e.sCount[t], e.line = f + (m ? 1 : 0);
  let l = e.push("fence", "code", 0);
  return l.info = g, l.content = e.getLines(t + 1, f, u, !0), l.markup = p, l.map = [t, e.line], !0;
}
function Zu(e, t, n, o) {
  let r = e.bMarks[t] + e.tShift[t], i = e.eMarks[t], s = e.lineMax;
  if (e.sCount[t] - e.blkIndent >= 4 || e.src.charCodeAt(r) !== 62) return !1;
  if (o) return !0;
  let c = [], u = [], p = [], g = [], f = e.md.block.ruler.getRules("blockquote"), m = e.parentType;
  e.parentType = "blockquote";
  let l = !1, d;
  for (d = t; d < n; d++) {
    let R = e.sCount[d] < e.blkIndent;
    if (r = e.bMarks[d] + e.tShift[d], i = e.eMarks[d], r >= i) break;
    if (e.src.charCodeAt(r++) === 62 && !R) {
      let x = e.sCount[d] + 1, E, P;
      e.src.charCodeAt(r) === 32 ? (r++, x++, P = !1, E = !0) : e.src.charCodeAt(r) === 9 ? (E = !0, (e.bsCount[d] + x) % 4 === 3 ? (r++, x++, P = !1) : P = !0) : E = !1;
      let _ = x;
      for (c.push(e.bMarks[d]), e.bMarks[d] = r; r < i; ) {
        let C = e.src.charCodeAt(r);
        if (L(C)) C === 9 ? _ += 4 - (_ + e.bsCount[d] + (P ? 1 : 0)) % 4 : _++;
        else break;
        r++;
      }
      l = r >= i, u.push(e.bsCount[d]), e.bsCount[d] = e.sCount[d] + 1 + (E ? 1 : 0), p.push(e.sCount[d]), e.sCount[d] = _ - x, g.push(e.tShift[d]), e.tShift[d] = r - e.bMarks[d];
      continue;
    }
    if (l) break;
    let S = !1;
    for (let x = 0, E = f.length; x < E; x++) if (f[x](e, d, n, !0)) {
      S = !0;
      break;
    }
    if (S) {
      e.lineMax = d, e.blkIndent !== 0 && (c.push(e.bMarks[d]), u.push(e.bsCount[d]), g.push(e.tShift[d]), p.push(e.sCount[d]), e.sCount[d] -= e.blkIndent);
      break;
    }
    c.push(e.bMarks[d]), u.push(e.bsCount[d]), g.push(e.tShift[d]), p.push(e.sCount[d]), e.sCount[d] = -1;
  }
  let y = e.blkIndent;
  e.blkIndent = 0;
  let h = e.push("blockquote_open", "blockquote", 1);
  h.markup = ">";
  let b = [t, 0];
  h.map = b, e.md.block.tokenize(e, t, d);
  let w = e.push("blockquote_close", "blockquote", -1);
  w.markup = ">", e.lineMax = s, e.parentType = m, b[1] = e.line;
  for (let R = 0; R < g.length; R++)
    e.bMarks[R + t] = c[R], e.tShift[R + t] = g[R], e.sCount[R + t] = p[R], e.bsCount[R + t] = u[R];
  return e.blkIndent = y, !0;
}
function Ju(e, t, n, o) {
  let r = e.eMarks[t];
  if (e.sCount[t] - e.blkIndent >= 4) return !1;
  let i = e.bMarks[t] + e.tShift[t], s = e.src.charCodeAt(i++);
  if (s !== 42 && s !== 45 && s !== 95) return !1;
  let c = 1;
  for (; i < r; ) {
    let p = e.src.charCodeAt(i++);
    if (p !== s && !L(p)) return !1;
    p === s && c++;
  }
  if (c < 3) return !1;
  if (o) return !0;
  e.line = t + 1;
  let u = e.push("hr", "hr", 0);
  return u.map = [t, e.line], u.markup = Array(c + 1).join(String.fromCharCode(s)), !0;
}
function Ki(e, t) {
  let n = e.eMarks[t], o = e.bMarks[t] + e.tShift[t], r = e.src.charCodeAt(o++);
  return r !== 42 && r !== 45 && r !== 43 || o < n && !L(e.src.charCodeAt(o)) ? -1 : o;
}
function Vi(e, t) {
  let n = e.bMarks[t] + e.tShift[t], o = e.eMarks[t], r = n;
  if (r + 1 >= o) return -1;
  let i = e.src.charCodeAt(r++);
  if (i < 48 || i > 57) return -1;
  for (; ; ) {
    if (r >= o) return -1;
    if (i = e.src.charCodeAt(r++), i >= 48 && i <= 57) {
      if (r - n >= 10) return -1;
      continue;
    }
    if (i === 41 || i === 46) break;
    return -1;
  }
  return r < o && (i = e.src.charCodeAt(r), !L(i)) ? -1 : r;
}
function Xu(e, t) {
  let n = e.level + 2;
  for (let o = t + 2, r = e.tokens.length - 2; o < r; o++) e.tokens[o].level === n && e.tokens[o].type === "paragraph_open" && (e.tokens[o + 2].hidden = !0, e.tokens[o].hidden = !0, o += 2);
}
function Qu(e, t, n, o) {
  let r, i, s, c, u = t, p = !0;
  if (e.sCount[u] - e.blkIndent >= 4 || e.listIndent >= 0 && e.sCount[u] - e.listIndent >= 4 && e.sCount[u] < e.blkIndent) return !1;
  let g = !1;
  o && e.parentType === "paragraph" && e.sCount[u] >= e.blkIndent && (g = !0);
  let f, m, l;
  if ((l = Vi(e, u)) >= 0) {
    if (f = !0, s = e.bMarks[u] + e.tShift[u], m = Number(e.src.slice(s, l - 1)), g && m !== 1) return !1;
  } else if ((l = Ki(e, u)) >= 0) f = !1;
  else return !1;
  if (g && e.skipSpaces(l) >= e.eMarks[u])
    return !1;
  if (o) return !0;
  let d = e.src.charCodeAt(l - 1), y = e.tokens.length;
  f ? (c = e.push("ordered_list_open", "ol", 1), m !== 1 && (c.attrs = [["start", m]])) : c = e.push("bullet_list_open", "ul", 1);
  let h = [u, 0];
  c.map = h, c.markup = String.fromCharCode(d);
  let b = !1, w = e.md.block.ruler.getRules("list"), R = e.parentType;
  for (e.parentType = "list"; u < n; ) {
    i = l, r = e.eMarks[u];
    let S = e.sCount[u] + l - (e.bMarks[u] + e.tShift[u]), x = S;
    for (; i < r; ) {
      let j = e.src.charCodeAt(i);
      if (j === 9) x += 4 - (x + e.bsCount[u]) % 4;
      else if (j === 32) x++;
      else break;
      i++;
    }
    let E = i, P;
    E >= r ? P = 1 : P = x - S, P > 4 && (P = 1);
    let _ = S + P;
    c = e.push("list_item_open", "li", 1), c.markup = String.fromCharCode(d);
    let C = [u, 0];
    c.map = C, f && (c.info = e.src.slice(s, l - 1));
    let O = e.tight, I = e.tShift[u], v = e.sCount[u], z = e.listIndent;
    if (e.listIndent = e.blkIndent, e.blkIndent = _, e.tight = !0, e.tShift[u] = E - e.bMarks[u], e.sCount[u] = x, E >= r && e.isEmpty(u + 1) ? e.line = Math.min(e.line + 2, n) : e.md.block.tokenize(e, u, n), (!e.tight || b) && (p = !1), b = e.line - u > 1 && e.isEmpty(e.line - 1), e.blkIndent = e.listIndent, e.listIndent = z, e.tShift[u] = I, e.sCount[u] = v, e.tight = O, c = e.push("list_item_close", "li", -1), c.markup = String.fromCharCode(d), u = e.line, C[1] = u, u >= n || e.sCount[u] < e.blkIndent || e.sCount[u] - e.blkIndent >= 4) break;
    let V = !1;
    for (let j = 0, qt = w.length; j < qt; j++) if (w[j](e, u, n, !0)) {
      V = !0;
      break;
    }
    if (V) break;
    if (f) {
      if (l = Vi(e, u), l < 0) break;
      s = e.bMarks[u] + e.tShift[u];
    } else if (l = Ki(e, u), l < 0) break;
    if (d !== e.src.charCodeAt(l - 1)) break;
  }
  return f ? c = e.push("ordered_list_close", "ol", -1) : c = e.push("bullet_list_close", "ul", -1), c.markup = String.fromCharCode(d), h[1] = u, e.line = u, e.parentType = R, p && Xu(e, y), !0;
}
function ed(e, t, n, o) {
  let r = e.bMarks[t] + e.tShift[t], i = e.eMarks[t], s = t + 1;
  if (e.sCount[t] - e.blkIndent >= 4 || e.src.charCodeAt(r) !== 91) return !1;
  function c(S) {
    let x = e.lineMax;
    if (S >= x || e.isEmpty(S)) return null;
    let E = !1;
    if (e.sCount[S] - e.blkIndent > 3 && (E = !0), e.sCount[S] < 0 && (E = !0), !E) {
      let C = e.md.block.ruler.getRules("reference"), O = e.parentType;
      e.parentType = "reference";
      let I = !1;
      for (let v = 0, z = C.length; v < z; v++) if (C[v](e, S, x, !0)) {
        I = !0;
        break;
      }
      if (e.parentType = O, I) return null;
    }
    let P = e.bMarks[S] + e.tShift[S], _ = e.eMarks[S];
    return e.src.slice(P, _ + 1);
  }
  let u = e.src.slice(r, i + 1);
  i = u.length;
  let p = -1;
  for (r = 1; r < i; r++) {
    let S = u.charCodeAt(r);
    if (S === 91) return !1;
    if (S === 93) {
      p = r;
      break;
    } else if (S === 10) {
      let x = c(s);
      x !== null && (u += x, i = u.length, s++);
    } else if (S === 92 && (r++, r < i && u.charCodeAt(r) === 10)) {
      let x = c(s);
      x !== null && (u += x, i = u.length, s++);
    }
  }
  if (p < 0 || u.charCodeAt(p + 1) !== 58) return !1;
  for (r = p + 2; r < i; r++) {
    let S = u.charCodeAt(r);
    if (S === 10) {
      let x = c(s);
      x !== null && (u += x, i = u.length, s++);
    } else if (!L(S))
      break;
  }
  let g = e.md.helpers.parseLinkDestination(u, r, i);
  if (!g.ok) return !1;
  let f = e.md.normalizeLink(g.str);
  if (!e.md.validateLink(f)) return !1;
  r = g.pos;
  let m = r, l = s, d = r;
  for (; r < i; r++) {
    let S = u.charCodeAt(r);
    if (S === 10) {
      let x = c(s);
      x !== null && (u += x, i = u.length, s++);
    } else if (!L(S))
      break;
  }
  let y = e.md.helpers.parseLinkTitle(u, r, i);
  for (; y.can_continue; ) {
    let S = c(s);
    if (S === null) break;
    u += S, r = i, i = u.length, s++, y = e.md.helpers.parseLinkTitle(u, r, i, y);
  }
  let h;
  for (r < i && d !== r && y.ok ? (h = y.str, r = y.pos) : (h = "", r = m, s = l); r < i && L(u.charCodeAt(r)); )
    r++;
  if (r < i && u.charCodeAt(r) !== 10 && h)
    for (h = "", r = m, s = l; r < i && L(u.charCodeAt(r)); )
      r++;
  if (r < i && u.charCodeAt(r) !== 10) return !1;
  let b = Ht(u.slice(1, p));
  if (!b) return !1;
  if (o) return !0;
  typeof e.env.references > "u" && (e.env.references = {}), typeof e.env.references[b] > "u" && (e.env.references[b] = {
    title: h,
    href: f
  });
  let w = e.push("reference_definition", "", 0);
  w.map = [t, s], w.hidden = !0;
  let R = /* @__PURE__ */ Object.create(null);
  return R.label = b, w.meta = R, e.line = s, !0;
}
var td = [
  "address",
  "article",
  "aside",
  "base",
  "basefont",
  "blockquote",
  "body",
  "caption",
  "center",
  "col",
  "colgroup",
  "dd",
  "details",
  "dialog",
  "dir",
  "div",
  "dl",
  "dt",
  "fieldset",
  "figcaption",
  "figure",
  "footer",
  "form",
  "frame",
  "frameset",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "head",
  "header",
  "hr",
  "html",
  "iframe",
  "legend",
  "li",
  "link",
  "main",
  "menu",
  "menuitem",
  "nav",
  "noframes",
  "ol",
  "optgroup",
  "option",
  "p",
  "param",
  "search",
  "section",
  "summary",
  "table",
  "tbody",
  "td",
  "tfoot",
  "th",
  "thead",
  "title",
  "tr",
  "track",
  "ul"
], cs = `<[A-Za-z][A-Za-z0-9\\-]*(?:\\s+[a-zA-Z_:][a-zA-Z0-9:._-]*(?:\\s*=\\s*(?:[^"'=<>\`\\x00-\\x20]+|'[^']*'|"[^"]*"))?)*\\s*\\/?>`, ls = "<\\/[A-Za-z][A-Za-z0-9\\-]*\\s*>", nd = new RegExp(`^(?:${cs}|${ls}|<!---?>|<!--(?:[^-]|-[^-]|--[^>])*-->|<[?][\\s\\S]*?[?]>|<![A-Za-z][^>]*>|<!\\[CDATA\\[[\\s\\S]*?\\]\\]>)`), rd = new RegExp(`^(?:${cs}|${ls})`), Pe = [
  [
    /^<(script|pre|style|textarea)(?=(\s|>|$))/i,
    /<\/(script|pre|style|textarea)>/i,
    !0
  ],
  [
    /^<!--/,
    /-->/,
    !0
  ],
  [
    /^<\?/,
    /\?>/,
    !0
  ],
  [
    /^<![A-Za-z]/,
    />/,
    !0
  ],
  [
    /^<!\[CDATA\[/,
    /\]\]>/,
    !0
  ],
  [
    new RegExp(`^</?(${td.join("|")})(?=(\\s|/?>|$))`, "i"),
    /^$/,
    !0
  ],
  [
    new RegExp(`${rd.source}\\s*$`),
    /^$/,
    !1
  ]
];
function od(e, t, n, o) {
  let r = e.bMarks[t] + e.tShift[t], i = e.eMarks[t];
  if (e.sCount[t] - e.blkIndent >= 4 || !e.md.options.html || e.src.charCodeAt(r) !== 60) return !1;
  let s = e.src.slice(r, i), c = 0;
  for (; c < Pe.length && !Pe[c][0].test(s); c++) ;
  if (c === Pe.length) return !1;
  if (o) return Pe[c][2];
  let u = t + 1, p = Pe[c][1].test("");
  if (!Pe[c][1].test(s)) {
    for (; u < n && !(e.sCount[u] < e.blkIndent && (p || !e.isEmpty(u))); u++)
      if (r = e.bMarks[u] + e.tShift[u], i = e.eMarks[u], s = e.src.slice(r, i), Pe[c][1].test(s)) {
        s.length !== 0 && u++;
        break;
      }
  }
  e.line = u;
  let g = e.push("html_block", "", 0);
  return g.map = [t, u], g.content = e.getLines(t, u, e.blkIndent, !0), !0;
}
function id(e, t, n, o) {
  let r = e.bMarks[t] + e.tShift[t], i = e.eMarks[t];
  if (e.sCount[t] - e.blkIndent >= 4) return !1;
  let s = e.src.charCodeAt(r);
  if (s !== 35 || r >= i) return !1;
  let c = 1;
  for (s = e.src.charCodeAt(++r); s === 35 && r < i && c <= 6; )
    c++, s = e.src.charCodeAt(++r);
  if (c > 6 || r < i && !L(s)) return !1;
  if (o) return !0;
  i = e.skipSpacesBack(i, r);
  let u = e.skipCharsBack(i, 35, r);
  u > r && L(e.src.charCodeAt(u - 1)) && (i = u), e.line = t + 1;
  let p = e.push("heading_open", `h${c}`, 1);
  p.markup = "########".slice(0, c), p.map = [t, e.line];
  let g = e.push("inline", "", 0);
  g.content = zt(e.src.slice(r, i)), g.map = [t, e.line], g.children = [];
  let f = e.push("heading_close", `h${c}`, -1);
  return f.markup = "########".slice(0, c), !0;
}
function sd(e, t, n) {
  let o = e.md.block.ruler.getRules("paragraph");
  if (e.sCount[t] - e.blkIndent >= 4) return !1;
  let r = e.parentType;
  e.parentType = "paragraph";
  let i = 0, s, c = t + 1;
  for (; c < n && !e.isEmpty(c); c++) {
    if (e.sCount[c] - e.blkIndent > 3) continue;
    if (e.sCount[c] >= e.blkIndent) {
      let l = e.bMarks[c] + e.tShift[c], d = e.eMarks[c];
      if (l < d && (s = e.src.charCodeAt(l), (s === 45 || s === 61) && (l = e.skipChars(l, s), l = e.skipSpaces(l), l >= d))) {
        i = s === 61 ? 1 : 2;
        break;
      }
    }
    if (e.sCount[c] < 0) continue;
    let m = !1;
    for (let l = 0, d = o.length; l < d; l++) if (o[l](e, c, n, !0)) {
      m = !0;
      break;
    }
    if (m) break;
  }
  if (!i)
    return e.parentType = r, !1;
  let u = zt(e.getLines(t, c, e.blkIndent, !1));
  e.line = c + 1;
  let p = e.push("heading_open", `h${i}`, 1);
  p.markup = String.fromCharCode(s), p.map = [t, e.line];
  let g = e.push("inline", "", 0);
  g.content = u, g.map = [t, e.line - 1], g.children = [];
  let f = e.push("heading_close", `h${i}`, -1);
  return f.markup = String.fromCharCode(s), e.parentType = r, !0;
}
function ad(e, t, n) {
  let o = e.md.block.ruler.getRules("paragraph"), r = e.parentType, i = t + 1;
  for (e.parentType = "paragraph"; i < n && !e.isEmpty(i); i++) {
    if (e.sCount[i] - e.blkIndent > 3 || e.sCount[i] < 0) continue;
    let p = !1;
    for (let g = 0, f = o.length; g < f; g++) if (o[g](e, i, n, !0)) {
      p = !0;
      break;
    }
    if (p) break;
  }
  let s = zt(e.getLines(t, i, e.blkIndent, !1));
  e.line = i;
  let c = e.push("paragraph_open", "p", 1);
  c.map = [t, e.line];
  let u = e.push("inline", "", 0);
  return u.content = s, u.map = [t, e.line], u.children = [], e.push("paragraph_close", "p", -1), e.parentType = r, !0;
}
var Gt = [
  [
    "table",
    Ku,
    ["paragraph", "reference"]
  ],
  ["code", Vu],
  [
    "fence",
    Yu,
    [
      "paragraph",
      "reference",
      "blockquote",
      "list"
    ]
  ],
  [
    "blockquote",
    Zu,
    [
      "paragraph",
      "reference",
      "blockquote",
      "list"
    ]
  ],
  [
    "hr",
    Ju,
    [
      "paragraph",
      "reference",
      "blockquote",
      "list"
    ]
  ],
  [
    "list",
    Qu,
    [
      "paragraph",
      "reference",
      "blockquote"
    ]
  ],
  ["reference", ed],
  [
    "html_block",
    od,
    [
      "paragraph",
      "reference",
      "blockquote"
    ]
  ],
  [
    "heading",
    id,
    [
      "paragraph",
      "reference",
      "blockquote"
    ]
  ],
  ["lheading", sd],
  ["paragraph", ad]
], us = class {
  constructor() {
    k(
      this,
      /**
      * {@link Ruler} instance. Keep configuration of block rules.
      */
      "ruler",
      new st()
    ), k(this, "State", as);
    for (let e = 0; e < Gt.length; e++) this.ruler.push(Gt[e][0], Gt[e][1], { alt: (Gt[e][2] || []).slice() });
  }
  tokenize(e, t, n) {
    let o = this.ruler.getRules(""), r = o.length, i = e.md.options.maxNesting, s = t, c = !1;
    for (; s < n && (e.line = s = e.skipEmptyLines(s), !(s >= n || e.sCount[s] < e.blkIndent)); ) {
      if (e.level >= i) {
        e.line = n;
        break;
      }
      let u = e.line, p = !1;
      for (let g = 0; g < r; g++)
        if (p = o[g](e, s, n, !1), p) {
          if (u >= e.line) throw new Error("block rule didn't increment state.line");
          break;
        }
      if (!p) throw new Error("none of the block rules matched");
      e.tight = !c, e.isEmpty(e.line - 1) && (c = !0), s = e.line, s < n && e.isEmpty(s) && (c = !0, s++, e.line = s);
    }
  }
  /**
  * Process input string and push block tokens into `outTokens`
  */
  parse(e, t, n, o) {
    if (!e) return;
    let r = new this.State(e, t, n, o);
    this.tokenize(r, r.line, r.lineMax);
  }
}, ds = class {
  constructor(e, t, n, o) {
    k(this, "pos", 0), k(this, "level", 0), k(this, "pending", ""), k(this, "pendingLevel", 0), k(this, "cache", {}), k(this, "backticks", {}), k(this, "backticksScanned", !1), k(this, "linkLevel", 0), k(this, "delimiters", []), k(this, "_prev_delimiters", []), k(this, "Token", De), this.src = e, this.env = n, this.md = t, this.tokens = o, this.tokens_meta = Array(o.length), this.posMax = this.src.length;
  }
  pushPending() {
    let e = new De("text", "", 0);
    return e.content = this.pending, e.level = this.pendingLevel, this.tokens.push(e), this.pending = "", e;
  }
  push(e, t, n) {
    this.pending && this.pushPending();
    let o = new De(e, t, n), r;
    return n < 0 && (this.level--, this.delimiters = this._prev_delimiters.pop()), o.level = this.level, n > 0 && (this.level++, this._prev_delimiters.push(this.delimiters), this.delimiters = [], r = { delimiters: this.delimiters }), this.pendingLevel = this.level, this.tokens.push(o), this.tokens_meta.push(r), o;
  }
  scanDelims(e, t) {
    let n = this.posMax, o = this.src.charCodeAt(e), r;
    if (e === 0) r = 32;
    else if (e === 1)
      r = this.src.charCodeAt(0), (r & 63488) === 55296 && (r = 65533);
    else if (r = this.src.charCodeAt(e - 1), (r & 64512) === 56320) {
      let d = this.src.charCodeAt(e - 2);
      r = (d & 64512) === 55296 ? 65536 + (d - 55296 << 10) + (r - 56320) : 65533;
    } else (r & 64512) === 55296 && (r = 65533);
    let i = e;
    for (; i < n && this.src.charCodeAt(i) === o; ) i++;
    let s = i - e, c = i < n ? this.src.charCodeAt(i) : 32;
    if ((c & 64512) === 55296) {
      let d = this.src.charCodeAt(i + 1);
      c = (d & 64512) === 56320 ? 65536 + (c - 55296 << 10) + (d - 56320) : 65533;
    } else (c & 64512) === 56320 && (c = 65533);
    let u = ot(r) || rt(r), p = ot(c) || rt(c), g = nt(r), f = nt(c), m = !f && (!p || g || u), l = !g && (!u || f || p);
    return {
      can_open: m && (t || !l || u),
      can_close: l && (t || !m || p),
      length: s
    };
  }
};
function cd(e) {
  switch (e) {
    case 10:
    case 33:
    case 35:
    case 36:
    case 37:
    case 38:
    case 42:
    case 43:
    case 45:
    case 58:
    case 60:
    case 61:
    case 62:
    case 64:
    case 91:
    case 92:
    case 93:
    case 94:
    case 95:
    case 96:
    case 123:
    case 125:
    case 126:
      return !0;
    default:
      return !1;
  }
}
function ld(e, t) {
  let n = e.pos;
  for (; n < e.posMax && !cd(e.src.charCodeAt(n)); ) n++;
  return n === e.pos ? !1 : (t || (e.pending += e.src.slice(e.pos, n)), e.pos = n, !0);
}
function ud(e) {
  return e >= 65 && e <= 90 || e >= 97 && e <= 122;
}
function dd(e) {
  return e >= 65 && e <= 90 || e >= 97 && e <= 122 || e >= 48 && e <= 57 || e === 43 || e === 45 || e === 46;
}
function pd(e, t) {
  if (!e.md.options.linkify || e.linkLevel > 0) return !1;
  let n = e.pos, o = e.posMax;
  if (n + 3 > o || e.src.charCodeAt(n) !== 58 || e.src.charCodeAt(n + 1) !== 47 || e.src.charCodeAt(n + 2) !== 47) return !1;
  let r = n - Math.min(10, e.pending.length, n), i = n;
  for (; i > r && dd(e.src.charCodeAt(i - 1)); ) i--;
  if (i === n || !ud(e.src.charCodeAt(i))) return !1;
  let s = n - i, c = e.md.linkify.matchAtStart(e.src.slice(i));
  if (!c) return !1;
  let u = c.url;
  if (u.length <= s) return !1;
  let p = u.length;
  for (; p > 0 && u.charCodeAt(p - 1) === 42; ) p--;
  p !== u.length && (u = u.slice(0, p));
  let g = e.md.normalizeLink(u);
  if (!e.md.validateLink(g)) return !1;
  if (!t) {
    e.pending = e.pending.slice(0, -s);
    let f = e.push("link_open", "a", 1);
    f.attrs = [["href", g]], f.markup = "linkify", f.info = "auto";
    let m = e.push("text", "", 0);
    m.content = e.md.normalizeLinkText(u);
    let l = e.push("link_close", "a", -1);
    l.markup = "linkify", l.info = "auto";
  }
  return e.pos += u.length - s, !0;
}
function fd(e, t) {
  let n = e.pos;
  if (e.src.charCodeAt(n) !== 10) return !1;
  let o = e.pending.length - 1, r = e.posMax;
  if (!t) if (o >= 0 && e.pending.charCodeAt(o) === 32) if (o >= 1 && e.pending.charCodeAt(o - 1) === 32) {
    let i = o - 1;
    for (; i >= 1 && e.pending.charCodeAt(i - 1) === 32; ) i--;
    e.pending = e.pending.slice(0, i), e.push("hardbreak", "br", 0);
  } else
    e.pending = e.pending.slice(0, -1), e.push("softbreak", "br", 0);
  else e.push("softbreak", "br", 0);
  for (n++; n < r && L(e.src.charCodeAt(n)); ) n++;
  return e.pos = n, !0;
}
var $n = [];
for (let e = 0; e < 256; e++) $n.push(0);
"\\!\"#$%&'()*+,./:;<=>?@[]^_`{|}~-".split("").forEach(function(e) {
  $n[e.charCodeAt(0)] = 1;
});
function hd(e, t) {
  let n = e.pos, o = e.posMax;
  if (e.src.charCodeAt(n) !== 92 || (n++, n >= o)) return !1;
  let r = e.src.charCodeAt(n);
  if (r === 10) {
    for (t || e.push("hardbreak", "br", 0), n++; n < o && (r = e.src.charCodeAt(n), !!L(r)); )
      n++;
    return e.pos = n, !0;
  }
  if (r === 32) {
    if (!t) {
      let c = e.push("text_special", "", 0);
      c.content = "\\", c.markup = "\\", c.info = "escape";
    }
    return e.pos = n, !0;
  }
  let i = e.src[n];
  if (r >= 55296 && r <= 56319 && n + 1 < o) {
    let c = e.src.charCodeAt(n + 1);
    c >= 56320 && c <= 57343 && (i += e.src[n + 1], n++);
  }
  let s = "\\" + i;
  if (!t) {
    let c = e.push("text_special", "", 0);
    r < 256 && $n[r] !== 0 ? c.content = i : c.content = s, c.markup = s, c.info = "escape";
  }
  return e.pos = n + 1, !0;
}
function gd(e) {
  let t = {}, n = 0;
  for (; (n = e.indexOf("`", n)) !== -1; ) {
    let o = n;
    for (; e.charCodeAt(++n) === 96; ) ;
    t[n - o] = o;
  }
  return t;
}
function md(e, t) {
  var n;
  let o = e.pos;
  if (e.src.charCodeAt(o) !== 96) return !1;
  let r = e.posMax, i = o + 1;
  for (; i < r && e.src.charCodeAt(i) === 96; ) i++;
  let s = e.src.slice(o, i), c = s.length;
  if (e.backticksScanned || (e.backticks = gd(e.src), e.backticksScanned = !0), ((n = e.backticks[c]) !== null && n !== void 0 ? n : -1) >= i) {
    let u = i, p;
    for (; (p = e.src.indexOf("`", u)) !== -1 && p < r; ) {
      for (u = p + 1; e.src.charCodeAt(u) === 96; ) u++;
      if (u > r) break;
      if (u - p === c) {
        if (!t) {
          let g = e.push("code_inline", "code", 0);
          g.markup = s;
          let f = e.src.slice(i, p).replace(/\n/g, " ");
          f.startsWith(" ") && f.endsWith(" ") && /[^ ]/.test(f) && (f = f.slice(1, -1)), g.content = f;
        }
        return e.pos = u, !0;
      }
    }
  }
  return t || (e.pending += s), e.pos = i, !0;
}
function yd(e, t) {
  let n = e.pos, o = e.src.charCodeAt(n);
  if (t || o !== 126) return !1;
  let r = e.scanDelims(e.pos, !0), i = r.length, s = String.fromCharCode(o);
  if (i < 2) return !1;
  let c;
  i % 2 && (c = e.push("text", "", 0), c.content = s, i--);
  for (let u = 0; u < i; u += 2)
    c = e.push("text", "", 0), c.content = s + s, e.delimiters.push({
      marker: o,
      length: 0,
      token: e.tokens.length - 1,
      end: -1,
      open: r.can_open,
      close: r.can_close
    });
  return e.pos += r.length, !0;
}
function Yi(e, t) {
  let n, o = [], r = t.length;
  for (let i = 0; i < r; i++) {
    let s = t[i];
    if (s.marker !== 126 || s.end === -1) continue;
    let c = t[s.end];
    n = e.tokens[s.token], n.type = "s_open", n.tag = "s", n.nesting = 1, n.markup = "~~", n.content = "", n = e.tokens[c.token], n.type = "s_close", n.tag = "s", n.nesting = -1, n.markup = "~~", n.content = "", e.tokens[c.token - 1].type === "text" && e.tokens[c.token - 1].content === "~" && o.push(c.token - 1);
  }
  for (; o.length; ) {
    let i = o.pop(), s = i + 1;
    for (; s < e.tokens.length && e.tokens[s].type === "s_close"; ) s++;
    s--, i !== s && (n = e.tokens[s], e.tokens[s] = e.tokens[i], e.tokens[i] = n);
  }
}
function bd(e) {
  let t = e.tokens_meta, n = e.tokens_meta.length;
  Yi(e, e.delimiters);
  for (let r = 0; r < n; r++) {
    var o;
    let i = (o = t[r]) === null || o === void 0 ? void 0 : o.delimiters;
    i && Yi(e, i);
  }
}
var ps = {
  tokenize: yd,
  postProcess: bd
};
function wd(e, t) {
  let n = e.pos, o = e.src.charCodeAt(n);
  if (t || o !== 95 && o !== 42) return !1;
  let r = e.scanDelims(e.pos, o === 42);
  for (let i = 0; i < r.length; i++) {
    let s = e.push("text", "", 0);
    s.content = String.fromCharCode(o), e.delimiters.push({
      marker: o,
      length: r.length,
      token: e.tokens.length - 1,
      end: -1,
      open: r.can_open,
      close: r.can_close
    });
  }
  return e.pos += r.length, !0;
}
function Zi(e, t) {
  let n = t.length;
  for (let o = n - 1; o >= 0; o--) {
    let r = t[o];
    if (r.marker !== 95 && r.marker !== 42 || r.end === -1) continue;
    let i = t[r.end], s = o > 0 && t[o - 1].end === r.end + 1 && t[o - 1].marker === r.marker && t[o - 1].token === r.token - 1 && t[r.end + 1].token === i.token + 1, c = String.fromCharCode(r.marker), u = e.tokens[r.token];
    u.type = s ? "strong_open" : "em_open", u.tag = s ? "strong" : "em", u.nesting = 1, u.markup = s ? c + c : c, u.content = "";
    let p = e.tokens[i.token];
    p.type = s ? "strong_close" : "em_close", p.tag = s ? "strong" : "em", p.nesting = -1, p.markup = s ? c + c : c, p.content = "", s && (e.tokens[t[o - 1].token].content = "", e.tokens[t[r.end + 1].token].content = "", o--);
  }
}
function Rd(e) {
  let t = e.tokens_meta, n = e.tokens_meta.length;
  Zi(e, e.delimiters);
  for (let r = 0; r < n; r++) {
    var o;
    let i = (o = t[r]) === null || o === void 0 ? void 0 : o.delimiters;
    i && Zi(e, i);
  }
}
var fs = {
  tokenize: wd,
  postProcess: Rd
};
function Sd(e, t) {
  let n, o, r, i, s = "", c = "", u = e.pos, p = !0;
  if (e.src.charCodeAt(e.pos) !== 91) return !1;
  let g = e.pos, f = e.posMax, m = e.pos + 1, l = e.md.helpers.parseLinkLabel(e, e.pos, !0);
  if (l < 0) return !1;
  let d = l + 1;
  if (d < f && e.src.charCodeAt(d) === 40) {
    for (p = !1, d++; d < f && (n = e.src.charCodeAt(d), !(!L(n) && n !== 10)); d++)
      ;
    if (d >= f) return !1;
    if (u = d, r = e.md.helpers.parseLinkDestination(e.src, d, e.posMax), r.ok) {
      for (s = e.md.normalizeLink(r.str), e.md.validateLink(s) ? d = r.pos : s = "", u = d; d < f && (n = e.src.charCodeAt(d), !(!L(n) && n !== 10)); d++)
        ;
      if (r = e.md.helpers.parseLinkTitle(e.src, d, e.posMax), d < f && u !== d && r.ok)
        for (c = r.str, d = r.pos; d < f && (n = e.src.charCodeAt(d), !(!L(n) && n !== 10)); d++)
          ;
    }
    (d >= f || e.src.charCodeAt(d) !== 41) && (p = !0), d++;
  }
  if (p) {
    if (typeof e.env.references > "u") return !1;
    if (d < f && e.src.charCodeAt(d) === 91 ? (u = d + 1, d = e.md.helpers.parseLinkLabel(e, d), d >= 0 ? o = e.src.slice(u, d++) : d = l + 1) : d = l + 1, o || (o = e.src.slice(m, l)), o = Ht(o), i = e.env.references[o], !i)
      return e.pos = g, !1;
    s = i.href, c = i.title;
  }
  if (!t) {
    e.pos = m, e.posMax = l;
    let y = e.push("link_open", "a", 1), h = [["href", s]];
    if (y.attrs = h, c && h.push(["title", c]), o) {
      let b = /* @__PURE__ */ Object.create(null);
      b.label = o, y.meta = b;
    }
    e.linkLevel++, e.md.inline.tokenize(e), e.linkLevel--, e.push("link_close", "a", -1);
  }
  return e.pos = d, e.posMax = f, !0;
}
function xd(e, t) {
  let n, o, r, i, s, c, u, p, g = "", f = e.pos, m = e.posMax;
  if (e.src.charCodeAt(e.pos) !== 33 || e.src.charCodeAt(e.pos + 1) !== 91) return !1;
  let l = e.pos + 2, d = e.md.helpers.parseLinkLabel(e, e.pos + 1, !1);
  if (d < 0) return !1;
  if (i = d + 1, i < m && e.src.charCodeAt(i) === 40) {
    for (i++; i < m && (n = e.src.charCodeAt(i), !(!L(n) && n !== 10)); i++)
      ;
    if (i >= m) return !1;
    for (p = i, c = e.md.helpers.parseLinkDestination(e.src, i, e.posMax), c.ok && (g = e.md.normalizeLink(c.str), e.md.validateLink(g) ? i = c.pos : g = ""), p = i; i < m && (n = e.src.charCodeAt(i), !(!L(n) && n !== 10)); i++)
      ;
    if (c = e.md.helpers.parseLinkTitle(e.src, i, e.posMax), i < m && p !== i && c.ok)
      for (u = c.str, i = c.pos; i < m && (n = e.src.charCodeAt(i), !(!L(n) && n !== 10)); i++)
        ;
    else u = "";
    if (i >= m || e.src.charCodeAt(i) !== 41)
      return e.pos = f, !1;
    i++;
  } else {
    if (typeof e.env.references > "u") return !1;
    if (i < m && e.src.charCodeAt(i) === 91 ? (p = i + 1, i = e.md.helpers.parseLinkLabel(e, i), i >= 0 ? r = e.src.slice(p, i++) : i = d + 1) : i = d + 1, r || (r = e.src.slice(l, d)), r = Ht(r), s = e.env.references[r], !s)
      return e.pos = f, !1;
    g = s.href, u = s.title;
  }
  if (!t) {
    o = e.src.slice(l, d);
    let y = [];
    e.md.inline.parse(o, e.md, e.env, y);
    let h = e.push("image", "img", 0), b = [["src", g], ["alt", ""]];
    if (h.attrs = b, h.children = y, h.content = o, u && b.push(["title", u]), r) {
      let w = /* @__PURE__ */ Object.create(null);
      w.label = r, h.meta = w;
    }
  }
  return e.pos = i, e.posMax = m, !0;
}
var Ed = /^([a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*)$/, Td = /^([a-zA-Z][a-zA-Z0-9+.-]{1,31}):([^<>\x00-\x20]*)$/;
function kd(e, t) {
  let n = e.pos;
  if (e.src.charCodeAt(n) !== 60) return !1;
  let o = e.pos, r = e.posMax;
  for (; ; ) {
    if (++n >= r) return !1;
    let s = e.src.charCodeAt(n);
    if (s === 60) return !1;
    if (s === 62) break;
  }
  let i = e.src.slice(o + 1, n);
  if (Td.test(i)) {
    let s = e.md.normalizeLink(i);
    if (!e.md.validateLink(s)) return !1;
    if (!t) {
      let c = e.push("link_open", "a", 1);
      c.attrs = [["href", s]], c.markup = "autolink", c.info = "auto";
      let u = e.push("text", "", 0);
      u.content = e.md.normalizeLinkText(i);
      let p = e.push("link_close", "a", -1);
      p.markup = "autolink", p.info = "auto";
    }
    return e.pos += i.length + 2, !0;
  }
  if (Ed.test(i)) {
    let s = e.md.normalizeLink(`mailto:${i}`);
    if (!e.md.validateLink(s)) return !1;
    if (!t) {
      let c = e.push("link_open", "a", 1);
      c.attrs = [["href", s]], c.markup = "autolink", c.info = "auto";
      let u = e.push("text", "", 0);
      u.content = e.md.normalizeLinkText(i);
      let p = e.push("link_close", "a", -1);
      p.markup = "autolink", p.info = "auto";
    }
    return e.pos += i.length + 2, !0;
  }
  return !1;
}
function Ad(e) {
  return /^<a[>\s]/i.test(e);
}
function Cd(e) {
  return /^<\/a\s*>/i.test(e);
}
function _d(e) {
  let t = e | 32;
  return t >= 97 && t <= 122;
}
function vd(e, t) {
  if (!e.md.options.html) return !1;
  let n = e.posMax, o = e.pos;
  if (e.src.charCodeAt(o) !== 60 || o + 2 >= n) return !1;
  let r = e.src.charCodeAt(o + 1);
  if (r !== 33 && r !== 63 && r !== 47 && !_d(r)) return !1;
  let i = e.src.slice(o).match(nd);
  if (!i) return !1;
  if (!t) {
    let s = e.push("html_inline", "", 0);
    s.content = i[0], Ad(s.content) && e.linkLevel++, Cd(s.content) && e.linkLevel--;
  }
  return e.pos += i[0].length, !0;
}
var Id = /^&#((?:x[a-f0-9]{1,6}|[0-9]{1,7}));/i, Pd = /^&([a-z][a-z0-9]{1,31});/i;
function Dd(e, t) {
  let n = e.pos, o = e.posMax;
  if (e.src.charCodeAt(n) !== 38 || n + 1 >= o) return !1;
  if (e.src.charCodeAt(n + 1) === 35) {
    let r = e.src.slice(n).match(Id);
    if (r) {
      if (!t) {
        let i = r[1][0].toLowerCase() === "x" ? parseInt(r[1].slice(1), 16) : parseInt(r[1], 10), s = e.push("text_special", "", 0);
        s.content = zn(i) ? tt(i) : tt(65533), s.markup = r[0], s.info = "entity";
      }
      return e.pos += r[0].length, !0;
    }
  } else {
    let r = e.src.slice(n).match(Pd);
    if (r) {
      let i = Ft(r[0]);
      if (i !== r[0]) {
        if (!t) {
          let s = e.push("text_special", "", 0);
          s.content = i, s.markup = r[0], s.info = "entity";
        }
        return e.pos += r[0].length, !0;
      }
    }
  }
  return !1;
}
function Ji(e) {
  let t = {}, n = e.length;
  if (!n) return;
  let o = 0, r = -2, i = [];
  for (let s = 0; s < n; s++) {
    let c = e[s];
    if (i.push(0), (e[o].marker !== c.marker || r !== c.token - 1) && (o = s), r = c.token, c.length = c.length || 0, !c.close) continue;
    t.hasOwnProperty(c.marker) || (t[c.marker] = [
      -1,
      -1,
      -1,
      -1,
      -1,
      -1
    ]);
    let u = t[c.marker][(c.open ? 3 : 0) + c.length % 3], p = o - i[o] - 1, g = p;
    for (; p > u; p -= i[p] + 1) {
      let f = e[p];
      if (f.marker === c.marker && f.open && f.end < 0) {
        let m = !1;
        if ((f.close || c.open) && (f.length + c.length) % 3 === 0 && (f.length % 3 !== 0 || c.length % 3 !== 0) && (m = !0), !m) {
          let l = p > 0 && !e[p - 1].open ? i[p - 1] + 1 : 0;
          i[s] = s - p + l, i[p] = l, c.open = !1, f.end = s, f.close = !1, g = -1, r = -2;
          break;
        }
      }
    }
    g !== -1 && (t[c.marker][(c.open ? 3 : 0) + (c.length || 0) % 3] = g);
  }
}
function Md(e) {
  let t = e.tokens_meta, n = e.tokens_meta.length;
  Ji(e.delimiters);
  for (let r = 0; r < n; r++) {
    var o;
    let i = (o = t[r]) === null || o === void 0 ? void 0 : o.delimiters;
    i && Ji(i);
  }
}
function Od(e) {
  let t, n, o = 0, r = e.tokens, i = e.tokens.length;
  for (t = n = 0; t < i; t++)
    r[t].nesting < 0 && o--, r[t].level = o, r[t].nesting > 0 && o++, r[t].type === "text" && t + 1 < i && r[t + 1].type === "text" ? r[t + 1].content = r[t].content + r[t + 1].content : (t !== n && (r[n] = r[t]), n++);
  t !== n && (r.length = n);
}
var Bn = [
  ["text", ld],
  ["linkify", pd],
  ["newline", fd],
  ["escape", hd],
  ["backticks", md],
  ["strikethrough", ps.tokenize],
  ["emphasis", fs.tokenize],
  ["link", Sd],
  ["image", xd],
  ["autolink", kd],
  ["html_inline", vd],
  ["entity", Dd]
], Gn = [
  ["balance_pairs", Md],
  ["strikethrough", ps.postProcess],
  ["emphasis", fs.postProcess],
  ["fragments_join", Od]
], hs = class {
  constructor() {
    k(
      this,
      /**
      * {@link Ruler} instance. Keep configuration of inline rules.
      */
      "ruler",
      new st()
    ), k(
      this,
      /**
      * {@link Ruler} instance. Second ruler used for post-processing
      * (e.g. in emphasis-like rules).
      */
      "ruler2",
      new st()
    ), k(this, "State", ds);
    for (let e = 0; e < Bn.length; e++) this.ruler.push(Bn[e][0], Bn[e][1]);
    for (let e = 0; e < Gn.length; e++) this.ruler2.push(Gn[e][0], Gn[e][1]);
  }
  skipToken(e) {
    let t = e.pos, n = this.ruler.getRules(""), o = n.length, r = e.md.options.maxNesting, i = e.cache;
    if (typeof i[t] < "u") {
      e.pos = i[t];
      return;
    }
    let s = !1;
    if (e.level < r) {
      for (let c = 0; c < o; c++)
        if (e.level++, s = n[c](e, !0), e.level--, s) {
          if (t >= e.pos) throw new Error("inline rule didn't increment state.pos");
          break;
        }
    } else e.pos = e.posMax;
    s || e.pos++, i[t] = e.pos;
  }
  tokenize(e) {
    let t = this.ruler.getRules(""), n = t.length, o = e.posMax, r = e.md.options.maxNesting;
    for (; e.pos < o; ) {
      let i = e.pos, s = !1;
      if (e.level < r) {
        for (let c = 0; c < n; c++)
          if (s = t[c](e, !1), s) {
            if (i >= e.pos) throw new Error("inline rule didn't increment state.pos");
            break;
          }
      }
      if (s) {
        if (e.pos >= o) break;
        continue;
      }
      e.pending += e.src[e.pos++];
    }
    e.pending && e.pushPending();
  }
  /**
  * Process input string and push inline tokens into `outTokens`
  */
  parse(e, t, n, o) {
    let r = new this.State(e, t, n, o);
    this.tokenize(r);
    let i = this.ruler2.getRules(""), s = i.length;
    for (let c = 0; c < s; c++) i[c](r);
  }
}, Nd = {
  default: {
    options: {
      html: !1,
      xhtmlOut: !1,
      breaks: !1,
      langPrefix: "language-",
      linkify: !1,
      typographer: !1,
      quotes: "\u201C\u201D\u2018\u2019",
      highlight: null,
      maxNesting: 100
    },
    components: {
      core: {},
      block: {},
      inline: {}
    }
  },
  zero: {
    options: {
      html: !1,
      xhtmlOut: !1,
      breaks: !1,
      langPrefix: "language-",
      linkify: !1,
      typographer: !1,
      quotes: "\u201C\u201D\u2018\u2019",
      highlight: null,
      maxNesting: 20
    },
    components: {
      core: { rules: [
        "normalize",
        "block",
        "strip_references",
        "inline",
        "text_join"
      ] },
      block: { rules: ["paragraph"] },
      inline: {
        rules: ["text"],
        rules2: ["balance_pairs", "fragments_join"]
      }
    }
  },
  commonmark: {
    options: {
      html: !0,
      xhtmlOut: !0,
      breaks: !1,
      langPrefix: "language-",
      linkify: !1,
      typographer: !1,
      quotes: "\u201C\u201D\u2018\u2019",
      highlight: null,
      maxNesting: 20
    },
    components: {
      core: { rules: [
        "normalize",
        "block",
        "strip_references",
        "inline",
        "text_join"
      ] },
      block: { rules: [
        "blockquote",
        "code",
        "fence",
        "heading",
        "hr",
        "html_block",
        "lheading",
        "list",
        "reference",
        "paragraph"
      ] },
      inline: {
        rules: [
          "autolink",
          "backticks",
          "emphasis",
          "entity",
          "escape",
          "html_inline",
          "image",
          "link",
          "newline",
          "text"
        ],
        rules2: [
          "balance_pairs",
          "emphasis",
          "fragments_join"
        ]
      }
    }
  }
}, Ud = /^(vbscript|javascript|file|data):/, Ld = /^data:image\/(gif|png|jpeg|webp);/, Xi = [
  "http:",
  "https:",
  "mailto:"
], ie = class {
  /**
  * Link validation function. CommonMark allows too much in links. By default
  * we disable `javascript:`, `vbscript:`, `file:` schemas, and almost all `data:...` schemas
  * except some embedded image types.
  *
  * You can change this behaviour:
  *
  * @example
  * ```javascript
  * import MarkdownIt from 'markdown-it'
  * const md = new MarkdownIt()
  *
  * // enable everything
  * md.validateLink = function () { return true; }
  * ```
  */
  validateLink(e) {
    let t = e.trim().toLowerCase();
    return Ud.test(t) ? Ld.test(t) : !0;
  }
  /**
  * Function used to encode link url to a machine-readable format,
  * which includes url-encoding, punycode, etc.
  */
  normalizeLink(e) {
    let t = Qe(e, !0);
    if (t.hostname && (!t.protocol || Xi.indexOf(t.protocol) >= 0))
      try {
        t.hostname = Hn.default.toASCII(t.hostname);
      } catch {
      }
    return t.auth && (t.auth = he(t.auth)), t.hostname && (t.hostname = he(t.hostname)), t.pathname && (t.pathname = he(t.pathname)), t.search && (t.search = he(t.search)), t.hash && (t.hash = he(t.hash)), He(t);
  }
  /**
  * Function used to decode link url to a human-readable format`
  */
  normalizeLinkText(e) {
    let t = Qe(e, !0);
    if (t.hostname && (!t.protocol || Xi.indexOf(t.protocol) >= 0))
      try {
        t.hostname = Hn.default.toUnicode(t.hostname);
      } catch {
      }
    return Xe(He(t), Xe.defaultChars + "%");
  }
  constructor(...e) {
    k(
      this,
      /**
      * Instance of {@link ParserInline}. You may need it to add new rules when
      * writing plugins. For simple rules control use {@link MarkdownIt.disable}
      * and {@link MarkdownIt.enable}.
      */
      "inline",
      new hs()
    ), k(
      this,
      /**
      * Instance of {@link ParserBlock}. You may need it to add new rules when
      * writing plugins. For simple rules control use {@link MarkdownIt.disable}
      * and {@link MarkdownIt.enable}.
      */
      "block",
      new us()
    ), k(
      this,
      /**
      * Instance of {@link ParserCore} chain executor. You may need it to add new
      * rules when writing plugins. For simple rules control use
      * {@link MarkdownIt.disable} and {@link MarkdownIt.enable}.
      */
      "core",
      new ss()
    ), k(
      this,
      /**
      * Instance of {@link Renderer}. Use it to modify output look. Or to add rendering
      * rules for new token types, generated by plugins.
      *
      * See {@link Renderer} docs and
      * [source code](https://github.com/markdown-it/markdown-it/blob/master/src/renderer.ts).
      *
      * @example
      * ```javascript
      * import MarkdownIt from 'markdown-it'
      * const md = new MarkdownIt()
      *
      * function myToken(tokens, idx, options, env, self) {
      *   //...
      *   return result;
      * };
      *
      * md.renderer.rules['my_token'] = myToken
      * ```
      */
      "renderer",
      new rs()
    ), k(
      this,
      /**
      * [linkify-it](https://github.com/markdown-it/linkify-it) instance.
      * Used by [linkify](https://github.com/markdown-it/markdown-it/blob/master/src/rules_core/linkify.ts)
      * rule.
      */
      "linkify",
      new Di()
    ), k(
      this,
      /**
      * Assorted utility functions, useful to write plugins. See details
      * [here](https://github.com/markdown-it/markdown-it/blob/master/src/common/utils.ts).
      */
      "utils",
      ou
    ), k(
      this,
      /**
      * Link components parser functions, useful to write plugins. See details
      * [here](https://github.com/markdown-it/markdown-it/blob/master/src/helpers).
      */
      "helpers",
      Object.assign({}, Ru)
    );
    let [t, n] = e;
    typeof t == "string" ? (this.configure(t), n && this.set(n)) : (this.configure("default"), this.set(t || {}));
  }
  /**
  * Set parser options (in the same format as in constructor). Probably, you
  * will never need it, but you can change options after constructor call.
  *
  * __Note:__ To achieve the best possible performance, don't modify a
  * `markdown-it` instance options on the fly. If you need multiple configurations
  * it's best to create multiple instances and initialize each with separate
  * config.
  *
  * @example
  * ```javascript
  * import MarkdownIt from 'markdown-it'
  *
  * const md = new MarkdownIt()
  *   .set({ html: true, breaks: true })
  *   .set({ typographer: true })
  * ```
  */
  set(e) {
    return Object.assign(this.options, e), this;
  }
  /**
  * Batch load of all options and compenent settings. This is internal method,
  * and you probably will not need it. But if you will - see available presets
  * and data structure [here](https://github.com/markdown-it/markdown-it/tree/master/src/presets)
  *
  * We strongly recommend to use presets instead of direct config loads. That
  * will give better compatibility with next versions.
  */
  configure(e) {
    let t;
    if (typeof e == "string") {
      let r = e;
      if (t = Nd[r], !t) throw new Error(`Wrong 'markdown-it' preset "${r}", check name`);
    } else t = e;
    if (!t) throw new Error("Wrong `markdown-it` preset, can't be empty");
    t.options && (this.options = { ...t.options });
    let n = t.components;
    if (n) {
      var o;
      [
        "core",
        "block",
        "inline"
      ].forEach((i) => {
        var s;
        let c = (s = n[i]) === null || s === void 0 ? void 0 : s.rules;
        c && this[i].ruler.enableOnly(c);
      });
      let r = (o = n.inline) === null || o === void 0 ? void 0 : o.rules2;
      r && this.inline.ruler2.enableOnly(r);
    }
    return this;
  }
  /**
  * Enable list or rules. It will automatically find appropriate components,
  * containing rules with given names. If rule not found, and `ignoreInvalid`
  * not set - throws exception.
  *
  * @example
  * ```javascript
  * import MarkdownIt from 'markdown-it'
  *
  * const md = new MarkdownIt()
  *   .enable(['sub', 'sup'])
  *   .disable('smartquotes')
  * ```
  */
  enable(e, t = !1) {
    let n = [];
    Array.isArray(e) || (e = [e]), [
      "core",
      "block",
      "inline"
    ].forEach((r) => {
      n = n.concat(this[r].ruler.enable(e, !0));
    }), n = n.concat(this.inline.ruler2.enable(e, !0));
    let o = e.filter((r) => n.indexOf(r) < 0);
    if (o.length && !t) throw new Error(`MarkdownIt. Failed to enable unknown rule(s): ${o}`);
    return this;
  }
  /**
  * The same as {@link MarkdownIt.enable}, but turn specified rules off.
  */
  disable(e, t = !1) {
    let n = [];
    Array.isArray(e) || (e = [e]), [
      "core",
      "block",
      "inline"
    ].forEach((r) => {
      n = n.concat(this[r].ruler.disable(e, !0));
    }), n = n.concat(this.inline.ruler2.disable(e, !0));
    let o = e.filter((r) => n.indexOf(r) < 0);
    if (o.length && !t) throw new Error(`MarkdownIt. Failed to disable unknown rule(s): ${o}`);
    return this;
  }
  /**
  * Load specified plugin with given params into current parser instance.
  * It's just a sugar to call `plugin(md, params)` with curring.
  *
  * @example
  * ```javascript
  * import MarkdownIt from 'markdown-it'
  * import iterator from 'markdown-it-for-inline'
  *
  * const md = new MarkdownIt()
  *   .use(iterator, 'foo_replace', 'text', function (tokens, idx) {
  *     tokens[idx].content = tokens[idx].content.replace(/foo/g, 'bar')
  *   })
  * ```
  */
  use(e, ...t) {
    return e.apply(e, [this, ...t]), this;
  }
  /**
  * Parse input string and return list of block tokens (special token type
  * "inline" will contain list of inline tokens). You should not call this
  * method directly, until you write custom renderer (for example, to produce
  * AST).
  *
  * `env` is used to pass data between "distributed" rules and return additional
  * metadata like reference info, needed for the renderer. It also can be used to
  * inject data in specific cases. Usually, you will be ok to pass `{}`,
  * and then pass updated object to renderer.
  */
  parse(e, t) {
    if (typeof e != "string") throw new Error("Input data should be a String");
    let n = new this.core.State(e, this, t);
    return this.core.process(n), n.tokens;
  }
  /**
  * Render markdown string into html. It does all magic for you :).
  *
  * `env` can be used to inject additional metadata (`{}` by default).
  * But you will not need it with high probability. See also comment
  * in {@link MarkdownIt.parse}.
  */
  render(e, t = {}) {
    return this.renderer.render(this.parse(e, t), this.options, t);
  }
  /**
  * The same as {@link MarkdownIt.parse} but skip all block rules. It returns
  * the block tokens list with the single `inline` element, containing parsed
  * inline tokens in `children` property. Also updates `env` object.
  */
  parseInline(e, t) {
    let n = new this.core.State(e, this, t);
    return n.inlineMode = !0, this.core.process(n), n.tokens;
  }
  /**
  * Similar to {@link MarkdownIt.render} but for single paragraph content.
  * Result will NOT be wrapped into `<p>` tags.
  */
  renderInline(e, t = {}) {
    return this.renderer.render(this.parseInline(e, t), this.options, t);
  }
};
k(ie, "Token", De);
k(ie, "Ruler", st);
k(ie, "Renderer", rs);
k(ie, "ParserCore", ss);
k(ie, "StateCore", os);
k(ie, "ParserBlock", us);
k(ie, "StateBlock", as);
k(ie, "ParserInline", hs);
k(ie, "StateInline", ds);
var Fd = es(ie);

// openclaw/packages/net-policy/src/ip.ts
B();
var ys = Xn(ms(), 1);
var f0 = [ys.default.IPv4.parse("198.18.0.0"), 15];

// openclaw/src/media/parse-output.ts
X();

// openclaw/src/utils/directive-tags.ts
X();
en();
B();

// openclaw/src/shared/text/text-projection.ts
X();

// openclaw/packages/markdown-core/src/fences.ts
var Bd = /(?:^|\n)( {0,3})(`{3,}|~{3,})([^\r\n\u2028\u2029]*)\r?(?=\n|$)/g, g0 = new RegExp(Bd, "gy");

// openclaw/packages/tool-call-repair/src/grammar.ts
var C0 = new TextEncoder();

// openclaw/src/shared/clawhub-recommendations.ts
N();
var bs = [
  "type",
  "id",
  "name",
  "description",
  "iconUrl",
  "installed",
  "official",
  "kind"
], yR = /* @__PURE__ */ new Set([...bs, "pluginId"]), bR = /* @__PURE__ */ new Set([...bs, "registry", "skillRef"]);

// openclaw/ui/src/lib/chat/imported-message-display.ts
N();

// openclaw/ui/src/lib/chat/message-normalizer-attachments.ts
ae();
N();

// openclaw/ui/src/lib/chat/message-normalizer-images.ts
ae();
N();
B();

// openclaw/ui/src/lib/chat/sender-label.ts
B();

// openclaw/ui/src/lib/chat/message-normalizer.ts
function qn(e) {
  return vt($(e)?.role);
}

// openclaw/ui/src/lib/chat/tool-call-diff.ts
N();
function ws(e) {
  let t = be(e), n = t?.added, o = t?.removed;
  return typeof n == "number" && Number.isInteger(n) && n >= 0 && typeof o == "number" && Number.isInteger(o) && o >= 0 ? { added: n, removed: o } : void 0;
}

// openclaw/ui/src/lib/chat/tool-call-grouping.ts
N();

// openclaw/src/agents/agent-activity-presentation.ts
N();
B();

// openclaw/src/session-cards/progress-card-input.ts
N();

// openclaw/src/agents/agent-activity-presentation.ts
function Me(e, t) {
  return t.map((n) => [n, e]);
}
var CS = new Map([
  // A launched subagent is a worker, not one more operation of the launcher.
  ...Me("subagents", ["sessions_spawn"]),
  ...Me("commands", ["exec", "bash", "shell", "run_command", "run_terminal_cmd"]),
  ...Me("reads", ["read", "read_file", "readfile", "notebookread", "notebook_read"]),
  ...Me("edits", [
    "edit",
    "apply_patch",
    "applypatch",
    "patch",
    "edit_file",
    "multiedit",
    "multi_edit",
    "notebookedit",
    "notebook_edit"
  ]),
  ...Me("writes", ["write", "write_file", "create_file"]),
  ...Me("searches", [
    "grep",
    "glob",
    "find",
    "ls",
    "list",
    "codebase_search",
    "web_search"
  ]),
  ...Me("fetches", ["web_fetch", "webfetch", "fetch"])
]);

// openclaw/ui/src/lib/protocol-validators.generated/activity.js
function ye(e) {
  let t = 0, n = 0, o = 0;
  for (; n < e.length; ) {
    let r = e.charCodeAt(n++) >> 10;
    t += +((o << 8 | r) !== 13879), o = r;
  }
  return t;
}
var {
  isAgentActivityItem: Rs,
  isSessionObserverDigest: vS,
  isSessionNarrationEvent: IS,
  isSessionReactionEvent: PS
} = (() => {
  let e = [
    new RegExp(
      "(^itemId$|^phase$|^kind$|^title$|^status$|^name$|^meta$|^commandBearing$|^toolCallId$|^unpairedCall$|^startedAt$|^endedAt$|^error$|^summary$|^progressText$|^suppressChannelProgress$|^hideFromChannelProgress$|^approvalId$|^approvalSlug$)",
      "u"
    ),
    new RegExp(
      "(^sessionKey$|^agentId$|^sessionId$|^lifecycleRevision$|^runId$|^revision$|^updatedAt$|^headline$|^assessment$|^health$|^planProgress$)",
      "u"
    ),
    new RegExp("(^completed$|^total$)", "u"),
    new RegExp("(^sessionKey$|^agentId$|^runId$|^text$)", "u"),
    new RegExp(
      "(^sessionKey$|^agentId$|^sessionId$|^messageId$|^emoji$|^action$|^actor$|^reactions$)",
      "u"
    ),
    new RegExp("(^type$|^id$|^label$|^avatarUrl$|^identity$)", "u"),
    new RegExp("(^type$|^id$)", "u"),
    new RegExp("(^type$|^id$)", "u"),
    new RegExp("(^type$|^pluginId$|^domain$|^idKind$|^id$)", "u"),
    new RegExp("(^type$|^pluginId$|^accountId$|^senderKind$|^id$)", "u"),
    new RegExp("(^type$|^actorType$|^source$|^id$)", "u"),
    new RegExp("(^emoji$|^count$|^identities$)", "u"),
    new RegExp("(^id$|^label$)", "u")
  ], t = (a) => n(a), n = (a) => typeof a == "object" && a !== null && !Array.isArray(a) && "itemId" in a && "phase" in a && "kind" in a && "title" in a && Object.getOwnPropertyNames(a).every(
    (D, Z) => e[0].test(D) || o(a[D])
  ) && r(a.itemId) && i(a.phase) && p(a.kind) && p(a.title) && (a.status === void 0 || !("status" in a) || g(a.status)) && (a.name === void 0 || !("name" in a) || p(a.name)) && (a.meta === void 0 || !("meta" in a) || p(a.meta)) && (a.commandBearing === void 0 || !("commandBearing" in a) || h(a.commandBearing)) && (a.toolCallId === void 0 || !("toolCallId" in a) || p(a.toolCallId)) && (a.unpairedCall === void 0 || !("unpairedCall" in a) || h(a.unpairedCall)) && (a.startedAt === void 0 || !("startedAt" in a) || b(a.startedAt)) && (a.endedAt === void 0 || !("endedAt" in a) || b(a.endedAt)) && (a.error === void 0 || !("error" in a) || p(a.error)) && (a.summary === void 0 || !("summary" in a) || p(a.summary)) && (a.progressText === void 0 || !("progressText" in a) || p(a.progressText)) && (a.suppressChannelProgress === void 0 || !("suppressChannelProgress" in a) || h(a.suppressChannelProgress)) && (a.hideFromChannelProgress === void 0 || !("hideFromChannelProgress" in a) || h(a.hideFromChannelProgress)) && (a.approvalId === void 0 || !("approvalId" in a) || p(a.approvalId)) && (a.approvalSlug === void 0 || !("approvalSlug" in a) || p(a.approvalSlug)), o = (a) => !1, r = (a) => typeof a == "string" && (a.length >= 2 || a.length >= 1 && ye(a) >= 1), i = (a) => s(a) || c(a) || u(a), s = (a) => typeof a == "string" && a === "start", c = (a) => typeof a == "string" && a === "update", u = (a) => typeof a == "string" && a === "end", p = (a) => typeof a == "string", g = (a) => f(a) || m(a) || l(a) || d(a) || y(a), f = (a) => typeof a == "string" && a === "running", m = (a) => typeof a == "string" && a === "completed", l = (a) => typeof a == "string" && a === "failed", d = (a) => typeof a == "string" && a === "blocked", y = (a) => typeof a == "string" && a === "skipped", h = (a) => typeof a == "boolean", b = (a) => Number.isFinite(a), w = (a) => R(a), R = (a) => typeof a == "object" && a !== null && !Array.isArray(a) && "sessionKey" in a && "revision" in a && "updatedAt" in a && "headline" in a && "health" in a && Object.getOwnPropertyNames(a).every(
    (D, Z) => e[1].test(D) || o(a[D])
  ) && r(a.sessionKey) && (a.agentId === void 0 || !("agentId" in a) || r(a.agentId)) && (a.sessionId === void 0 || !("sessionId" in a) || r(a.sessionId)) && (a.lifecycleRevision === void 0 || !("lifecycleRevision" in a) || r(a.lifecycleRevision)) && (a.runId === void 0 || !("runId" in a) || r(a.runId)) && S(a.revision) && x(a.updatedAt) && E(a.headline) && (a.assessment === void 0 || !("assessment" in a) || P(a.assessment)) && _(a.health) && (a.planProgress === void 0 || !("planProgress" in a) || j(a.planProgress)), S = (a) => Number.isInteger(a) && (!(Number.isFinite(a) || typeof a == "bigint") || a >= 1), x = (a) => Number.isInteger(a) && (!(Number.isFinite(a) || typeof a == "bigint") || a >= 0), E = (a) => typeof a == "string" && (a.length >= 2 || a.length >= 1 && ye(a) >= 1) && (a.length <= 120 || a.length <= 240 && ye(a) <= 120), P = (a) => typeof a == "string" && (a.length >= 2 || a.length >= 1 && ye(a) >= 1) && (a.length <= 320 || a.length <= 640 && ye(a) <= 320), _ = (a) => C(a) || O(a) || I(a) || v(a) || z(a) || V(a) || l(a), C = (a) => typeof a == "string" && a === "on-track", O = (a) => typeof a == "string" && a === "grinding", I = (a) => typeof a == "string" && a === "stuck", v = (a) => typeof a == "string" && a === "waiting-on-user", z = (a) => typeof a == "string" && a === "wrapping-up", V = (a) => typeof a == "string" && a === "done", j = (a) => typeof a == "object" && a !== null && !Array.isArray(a) && "completed" in a && "total" in a && Object.getOwnPropertyNames(a).every(
    (D, Z) => e[2].test(D) || o(a[D])
  ) && x(a.completed) && x(a.total), qt = (a) => Ds(a), Ds = (a) => typeof a == "object" && a !== null && !Array.isArray(a) && "sessionKey" in a && "runId" in a && "text" in a && Object.getOwnPropertyNames(a).every(
    (D, Z) => e[3].test(D) || o(a[D])
  ) && r(a.sessionKey) && (a.agentId === void 0 || !("agentId" in a) || r(a.agentId)) && r(a.runId) && Ms(a.text), Ms = (a) => typeof a == "string" && (a.length <= 16384 || a.length <= 32768 && ye(a) <= 16384), Os = (a) => Ns(a), Ns = (a) => typeof a == "object" && a !== null && !Array.isArray(a) && "sessionKey" in a && "agentId" in a && "sessionId" in a && "messageId" in a && "emoji" in a && "action" in a && "actor" in a && "reactions" in a && Object.getOwnPropertyNames(a).every(
    (D, Z) => e[4].test(D) || o(a[D])
  ) && r(a.sessionKey) && r(a.agentId) && r(a.sessionId) && r(a.messageId) && jn(a.emoji) && Us(a.action) && Bs(a.actor) && na(a.reactions), jn = (a) => typeof a == "string" && (a.length >= 2 || a.length >= 1 && ye(a) >= 1) && (a.length <= 32 || a.length <= 64 && ye(a) <= 32), Us = (a) => Ls(a) || Fs(a), Ls = (a) => typeof a == "string" && a === "added", Fs = (a) => typeof a == "string" && a === "removed", Bs = (a) => typeof a == "object" && a !== null && !Array.isArray(a) && "type" in a && "id" in a && Object.getOwnPropertyNames(a).every(
    (D, Z) => e[5].test(D) || o(a[D])
  ) && Gs(a.type) && r(a.id) && (a.label === void 0 || !("label" in a) || r(a.label)) && (a.avatarUrl === void 0 || !("avatarUrl" in a) || r(a.avatarUrl)) && (a.identity === void 0 || !("identity" in a) || zs(a.identity)), Gs = (a) => Kn(a) || Vn(a) || Hs(a), Kn = (a) => typeof a == "string" && a === "human", Vn = (a) => typeof a == "string" && a === "agent", Hs = (a) => typeof a == "string" && a === "system", zs = (a) => $s(a) || Ws(a) || js(a) || Vs(a) || Qs(a), $s = (a) => typeof a == "object" && a !== null && !Array.isArray(a) && "type" in a && "id" in a && Object.getOwnPropertyNames(a).every(
    (D, Z) => e[6].test(D) || o(a[D])
  ) && qs(a.type) && r(a.id), qs = (a) => typeof a == "string" && a === "profile", Ws = (a) => typeof a == "object" && a !== null && !Array.isArray(a) && "type" in a && "id" in a && Object.getOwnPropertyNames(a).every(
    (D, Z) => e[7].test(D) || o(a[D])
  ) && Vn(a.type) && r(a.id), js = (a) => typeof a == "object" && a !== null && !Array.isArray(a) && "type" in a && "pluginId" in a && "domain" in a && "idKind" in a && "id" in a && Object.getOwnPropertyNames(a).every(
    (D, Z) => e[8].test(D) || o(a[D])
  ) && Ks(a.type) && r(a.pluginId) && r(a.domain) && r(a.idKind) && r(a.id), Ks = (a) => typeof a == "string" && a === "remote", Vs = (a) => typeof a == "object" && a !== null && !Array.isArray(a) && "type" in a && "pluginId" in a && "accountId" in a && "senderKind" in a && "id" in a && Object.getOwnPropertyNames(a).every(
    (D, Z) => e[9].test(D) || o(a[D])
  ) && Ys(a.type) && Yn(a.pluginId) && Yn(a.accountId) && Zs(a.senderKind) && r(a.id), Ys = (a) => typeof a == "string" && a === "observation", Yn = (a) => r(a) || Zn(a), Zn = (a) => a === null, Zs = (a) => Kn(a) || Js(a) || Xs(a), Js = (a) => typeof a == "string" && a === "bot", Xs = (a) => typeof a == "string" && a === "unknown", Qs = (a) => typeof a == "object" && a !== null && !Array.isArray(a) && "type" in a && "actorType" in a && "source" in a && "id" in a && Object.getOwnPropertyNames(a).every(
    (D, Z) => e[10].test(D) || o(a[D])
  ) && ea(a.type) && p(a.actorType) && ta(a.source) && p(a.id), ea = (a) => typeof a == "string" && a === "legacy", ta = (a) => p(a) || Zn(a), na = (a) => Array.isArray(a) && a.every((D, Z) => ra(D)), ra = (a) => typeof a == "object" && a !== null && !Array.isArray(a) && "emoji" in a && "count" in a && "identities" in a && Object.getOwnPropertyNames(a).every(
    (D, Z) => e[11].test(D) || o(a[D])
  ) && jn(a.emoji) && S(a.count) && oa(a.identities), oa = (a) => Array.isArray(a) && a.every((D, Z) => ia(D)) && a.length >= 1, ia = (a) => typeof a == "object" && a !== null && !Array.isArray(a) && "id" in a && Object.getOwnPropertyNames(a).every(
    (D, Z) => e[12].test(D) || o(a[D])
  ) && r(a.id) && (a.label === void 0 || !("label" in a) || p(a.label));
  return {
    isAgentActivityItem: (a) => t(a),
    isSessionObserverDigest: (a) => w(a),
    isSessionNarrationEvent: (a) => qt(a),
    isSessionReactionEvent: (a) => Os(a)
  };
})();

// openclaw/ui/src/lib/chat/tool-call-grouping.ts
function Ss(e) {
  let t = $(e)?.activity;
  return Array.isArray(t) ? t.filter(Rs) : [];
}

// openclaw/ui/src/lib/chat/tool-cards.ts
function $d(e) {
  return U(e.messageId) ?? U(G(e.__openclaw)?.id);
}
function xs(e) {
  let t = G(G(e)?.__openclaw), n = G(t?.toolOutput);
  return (n?.source === "provider-response" || n?.source === "execution") && n.modelInput === "unverified" ? {
    source: n.source,
    modelInput: n.modelInput,
    ...n.outcome === "unknown" ? { outcome: "unknown" } : {},
    ...n.captureTruncated === !0 ? { captureTruncated: !0 } : {}
  } : void 0;
}
function qd(e) {
  return Array.isArray(e) ? e.filter((t) => be(t) !== null) : [];
}
function Wd(e) {
  if (typeof e != "string")
    return e;
  let t = e.trim();
  return t.startsWith("{") || t.startsWith("[") ? nn(t) ?? e : e;
}
function jd(e) {
  if (typeof e.text == "string")
    return e.text;
  if (typeof e.content == "string")
    return e.content;
  if (Array.isArray(e.content)) {
    let t = e.content.flatMap((n) => {
      let o = be(n)?.text;
      return typeof o == "string" ? [o] : [];
    });
    if (t.length > 0)
      return t.join(`
`);
  }
}
function Kd(...e) {
  for (let t of e) {
    let n = be(t), o = n?.exitCode ?? n?.exit_code;
    if (typeof o == "number" && Number.isInteger(o))
      return o;
  }
}
function Cs(e) {
  if (e.activity)
    return e.activity.status === "skipped";
  let t = be(e.details);
  return (e.live !== !0 || e.completed === !0) && t?.status === "skipped" && t.deniedReason === "steering";
}
function Es(e) {
  if (Cs(e))
    return !1;
  if (e.activity)
    return e.activity.status === "failed";
  let t = e.live !== !0 || e.completed === !0;
  return e.isError ?? (t && si(e.outputText));
}
function _s(e, t) {
  if (Cs(e))
    return "skipped";
  if (e.toolOutput?.outcome === "unknown")
    return Es(e) ? "failed" : "unknown";
  if (e.activity) {
    let { status: n, phase: o } = e.activity;
    return n === "failed" || n === "blocked" ? n : n === "completed" ? "succeeded" : t === !0 && e.live === !0 && (n === "running" || o !== "end" && e.completed !== !0) ? "running" : "unknown";
  }
  return Es(e) ? "failed" : t === !0 && e.live === !0 && e.completed !== !0 ? "running" : e.completed === !0 || e.live !== !0 && e.outputText !== void 0 ? "succeeded" : "unknown";
}
function Vd(e) {
  let t = ri(e);
  return t?.surface === "assistant_message" ? { ...t, surface: "assistant_message" } : void 0;
}
function Yd(e, t, n) {
  let o = ni(e), r = o?.surface === "assistant_message" ? { ...o, surface: "assistant_message" } : Vd(t);
  if (r)
    return { preview: { ...r, surface: "assistant_message" } };
  let i = G(G(e)?.browserTab), s = Tn(i);
  if (n !== "browser" || !i || !s)
    return {};
  let c = typeof i.url == "string" ? We(i.url, 2048) : "";
  return {
    browserTab: s,
    preview: Zo(c) ? {
      kind: "browser-tab",
      ...s,
      url: c,
      ...typeof i.title == "string" ? { title: We(i.title, 512) } : {}
    } : void 0
  };
}
function Ts(e, t) {
  return ii(e) ?? K(e.callId) ?? K(t.toolCallId) ?? K(t.tool_call_id) ?? K(t.toolUseId) ?? K(t.tool_use_id);
}
function Wn(e, t) {
  return K(e.name) ?? K(t.toolName) ?? K(t.tool_name) ?? "tool";
}
function Zd(e) {
  if (e != null)
    return typeof e == "string" ? e : JSON.stringify(e, null, 2);
}
var Jd = 0;
function Xd(e) {
  return kn(e.type) || typeof e.name == "string" && (e.arguments != null || e.args != null || e.input != null);
}
function ks(e) {
  let t = e, n = typeof t.role == "string" ? t.role.toLowerCase() : "", o = qn(e) || n === "tool" || n === "function" || typeof t.toolName == "string" || typeof t.tool_name == "string", r = qd(t.content), i = It(t), s = t.__openclawToolStreamLive === !0, c = ws(t.__openclawToolStreamDiffStat), u = [], p = /* @__PURE__ */ new WeakSet(), g = $d(t), f = Zt(t)?.runId ?? U(t.runId), m = (y, h, b = !1) => {
    let w = jd(y), R = y.details ?? t.details, S = G(y.__openclaw), x = It(y) ?? i, E = Kd(
      y,
      R,
      w ? Re(w.trim()) : void 0,
      b ? void 0 : t
    );
    return {
      outputText: w,
      resultMessageId: !b && S && Object.hasOwn(S, "id") ? U(S.id) : g,
      outputTruncated: (S && Object.hasOwn(S, "truncated") ? S : G(t.__openclaw))?.truncated === !0,
      toolOutput: xs(y) ?? xs(t),
      ...R !== void 0 ? { details: R } : {},
      ...x !== void 0 ? { isError: x } : {},
      ...E !== void 0 ? { exitCode: E } : {},
      ...Yd(R, w, h)
    };
  };
  for (let y = 0; y < r.length; y++) {
    let h = r[y] ?? {}, b = Xd(h);
    if (!b && !vt(h.type))
      continue;
    let w = U(h.runId) ?? f, R = U(h.parentToolCallId), S = Ts(h, t), x = Wn(h, t), E = {
      id: S ?? `${x}:${y}`,
      ...S ? { callId: S } : {},
      ...w ? { runId: w } : {},
      ...R ? { parentToolCallId: R } : {},
      name: x,
      messageId: g
    }, P = h.details ?? t.details;
    if (b) {
      let v = Wd(h.arguments ?? h.args ?? h.input);
      u.push({
        ...E,
        args: v,
        inputText: Zd(v),
        ...P !== void 0 ? { details: P } : {},
        ...s ? {
          live: !0,
          completed: t.__openclawToolStreamResultReceived === !0 || t.__openclawToolStreamItemEnded === !0
        } : {},
        ...c ? { liveDiffStat: c } : {}
      });
      continue;
    }
    let _ = u.find((v) => v.id === E.id) ?? u.find(
      (v) => (
        // Same-name fallback belongs to legacy blocks missing an explicit identity.
        (!S || !v.callId) && v.name === x && v.outputText === void 0 && !p.has(v)
      )
    ), C = o ? Wn({}, t) : void 0, O = C && C !== "browser" ? C : _?.name ?? C ?? x, I = m(h, O);
    if (_) {
      p.add(_), _.callId ??= S, _.runId ??= w, _.parentToolCallId ??= R, s || (_.completed = !0), Object.assign(_, I, {
        preview: I.preview,
        browserTab: I.browserTab
      });
      continue;
    }
    u.push({
      ...E,
      completed: !0,
      ...I
    });
  }
  if (o && u.length === 0) {
    let y = typeof t.toolName == "string" && t.toolName || typeof t.tool_name == "string" && t.tool_name || "tool", h = Ts({}, t);
    u.push({
      id: h ?? `${Wn({}, t)}:0`,
      ...h ? { callId: h } : {},
      ...f ? { runId: f } : {},
      name: y,
      completed: qn(e) || n === "tool" || n === "function",
      messageId: g,
      ...m(t, y, !0)
    });
  }
  let l = new Map(
    Ss(e).filter((y) => !y.suppressChannelProgress).map((y) => [y.toolCallId ?? y.itemId, y])
  ), d;
  for (let [y, h] of u.entries()) {
    let b = h.callId ? l.get(h.callId) : void 0;
    b && (h.activity = b), !(!h.browserTab || h.callId || h.messageId) && (d ??= ++Jd, h.previewRevision = `${d}:${y}`);
  }
  return u;
}
var As = /* @__PURE__ */ new WeakMap();
function vs(e) {
  if (!e || typeof e != "object")
    return ks(e);
  let t = As.get(e);
  if (t)
    return t;
  let n = ks(e);
  return As.set(e, n), n;
}

// openclaw/ui/src/lib/chat/browser-tab-preview.ts
function Qd(e) {
  return e.callId ?? e.messageId ?? e.previewRevision;
}
var Is = /* @__PURE__ */ new WeakMap();
function Ps(e, t) {
  let n = Is.get(e);
  if (n?.toolMessages === t)
    return n.latest;
  let o = /* @__PURE__ */ new Map();
  for (let r of [e, t])
    for (let i of r)
      if (J(i))
        for (let s of vs(i)) {
          let c = Qd(s);
          if (s.browserTab && c && _s(s, !1) === "succeeded") {
            let u = Yo(s.browserTab);
            o.delete(u), o.set(u, { tab: s.browserTab, revision: c });
          }
        }
  return Is.set(e, { toolMessages: t, latest: o }), o;
}

// octogee/app/openclaw-browser/resources.ts
function lx(e, t) {
  return [...Ps(e, []).values()].filter((o) => o.tab.target === "host" && o.tab.profile === t).at(-1) ?? null;
}
export {
  lx as latestNativeBrowserTab
};
/*!
TypeBox

The MIT License (MIT)

Copyright (c) 2017-2026 Haydn Paterson

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
*/
/*! Bundled license information:

@noble/ed25519/index.js:
  (*! noble-ed25519 - MIT License (c) 2019 Paul Miller (paulmillr.com) *)

markdown-it/dist/markdown-it.mjs:
  (*! markdown-it 15.0.2 https://github.com/markdown-it/markdown-it @license MIT *)
*/
